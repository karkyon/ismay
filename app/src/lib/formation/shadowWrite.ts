import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import type { AiTranscriptionSegment } from "@/lib/ai/transcriptionProvider";
import { locateTranscriptSegmentCharOffsets, findAudioSegmentForSpan } from "@/lib/formation/transcriptSegmentMapping";
import { buildAudioTimecodeAnchorFields } from "@/lib/formation/sourceAnchorAdapter";
import { debugServer } from "@/lib/debugServer";
import type { ResponsibilityCandidate } from "@/lib/ai/schema";
import { resolveFormationSessionTransition, isValidTextOffsetRange, capConfidenceForMissingEvidence, type FormationEventType } from "@/lib/formation/coreTypes";
import { applyQuestionPolicyAndTransition, type CandidateForQuestionPolicy } from "@/lib/formation/formationQuestionService";
import { assessAtomicity } from "@/lib/formation/atomicityAssessment";
import { classifyPii } from "@/lib/formation/piiClassifier";
import { enqueueCaseSuggestionMatch } from "@/lib/patterns/caseSuggestQueue";

/**
 * V5-M1-B2 Formation Session shadow書込み。
 * 出典: ISMAY-V5-DOC-03(Formation Session仕様書) 10章「M1-B1はshadow Session生成のみ」、
 *       CHG-012「aiExtractJob.tsをSession Event、Question Policy、Source Anchor生成へ拡張」。
 *
 * [設計方針・スコープ] このGate(M1-B2)は既存のFN-AI-01抽出結果(ai/extract.ts
 * persistSuccessが確定した後)を読み取り専用の入力として、Formation Session構造を
 * 複製書込みするだけである。既存のCapture/AiInference/Inbox UI/APIは一切変更しない。
 *
 * [DEC-009] 対象はpersistSuccess(READY)経路のみ。persistFailure/markFailed
 *   (FAILED経路)・finalizeBatchExtraction経由のBatch結果はこのGateでは対象外とする。
 *   理由: shadow配線の初回投入はblast radiusを最小化すべきであり、まず最も高頻度な
 *   成功経路でFormationSession/Candidate/Revision/SourceAnchorのデータ形状を実運用
 *   データで検証してから、FAILED/RETRY遷移やBatch経路へ拡張する方が安全(想像で
 *   全経路を一度に繋がない)。未対応経路は本ファイルでは一切呼び出されない。
 *
 * [2026-08-30更新・M1-B5a §4.2] DEC-010「Question Policy未接続のためCLARIFYING分岐は
 * 使わない」は本Gateで解消した。候補作成後、`applyQuestionPolicyAndTransition`
 * (formationQuestionService.ts、answerService.tsとの共通部品)を呼び、統合正本§6.4の
 * Question Policyに従ってCLARIFYING(質問あり)またはREVIEW_READY(質問なし)へ遷移する。
 * BATCH抽出経路(aiExtractJob.ts等)への同サービスの配線は未調査のため次のGateとする。
 *
 * [エラー方針・2026-08-31是正 M1-B6C-1] 従来この関数は内部で例外を捕捉し
 * `SHADOW_WRITE_FAILED_IGNORED`として握り潰していたが、これによりCapture=READY/
 * AiInference=成功なのにFormationSessionが永久欠落する状態が観測不能なまま
 * 恒久化し得た(指示書§3.1)。この関数は現在、内部で発生した例外を握り潰さず
 * 呼び出し元へ伝播する(例外はthrowする)。「Capture保存はAI障害と独立して完了
 * する」というDOC-03 UX契約1自体は変更しない: 本体のCapture/AiInference確定
 * transactionは既にこの関数の呼び出しより前にcommit済みであり、この関数の
 * 失敗が本体を巻き戻すことは無い。呼び出し元は`shadowCheckpoint.ts`の
 * `processShadowCheckpoint`経由でこの関数を呼び、失敗を`FormationShadowCheckpoint`
 * 行として永続記録した上でreconciliation workerが再試行する(旧来のfire-and-
 * forget best-effortから、観測可能・再試行可能なcheckpoint方式へ置き換えた)。
 */

export interface ShadowSourceCaptureContext {
  id: string;
  workspaceId: string;
  domainId: string | null;
  createdById: string;
  rawText: string;
  /// [M1-B6C-2新設・2026-09-01] AUDIO_TIMECODE Anchorをsourceで絞り込むために必要
  /// (VOICE以外のCaptureに対しては音声timecode検索自体を試みない)。
  sourceType: string;
}

export interface WriteShadowFormationSessionParams {
  capture: ShadowSourceCaptureContext;
  aiRunId: string;
  schemaVersion: string;
  candidates: ResponsibilityCandidate[];
  captureSummary?: string;
  /** [M1-B6C-4新設・2026-09-01指示書§6.3「retry orchestration」] 指定時、新規
   *  FormationSessionを作らず、既存Session(RETRYで既にANALYZING状態へ遷移済み)へ
   *  このAiRunの結果を新しいanalysis attemptとして追加する。指定Sessionが存在しない
   *  /workspaceId・captureIdが一致しない/ANALYZING状態でない場合はthrowする
   *  (想像で新規Sessionへfallbackしない。呼び出し元のcheckpoint機構が再試行/
   *  DEAD_LETTER判定する)。 */
  attachToSessionId?: string;
}

export async function writeShadowFormationSession(params: WriteShadowFormationSessionParams): Promise<void> {
  const { capture, aiRunId, schemaVersion, candidates, captureSummary, attachToSessionId } = params;

  if (!capture.domainId) {
    // FormationSession.domainIdは必須(DOC-03 4章)。CaptureのdomainIdが未設定の場合
    // (現行スキーマ上は許容されている)、shadowを書けないため静かにスキップする。
    debugServer.event("formation/shadowWrite", "SKIPPED_NO_DOMAIN", { captureId: capture.id });
    return;
  }

  try {
    await db.$transaction(async (tx: Prisma.TransactionClient) => {
      // clientSessionKeyをaiRunIdへ決定論的に束ねることで、同一AiRunに対する
      // 二重呼び出し(将来的なリトライ等)がformation_sessions_idempotency_uqで
      // 自然に弾かれる(既存captures_idempotency_key等と同じ設計)。
      const clientSessionKey = `shadow:${aiRunId}`;

      let session: { id: string; questionCount: number };
      let sequence: number;

      if (attachToSessionId) {
        // [M1-B6C-4新設・§6.3] retry attach path: 新規Sessionを作らず既存へ追記する。
        const existing = await tx.formationSession.findFirst({
          where: { id: attachToSessionId, workspaceId: capture.workspaceId, captureId: capture.id },
          select: { id: true, state: true, questionCount: true },
        });
        if (!existing) {
          throw new Error(`RETRY_ATTACH_SESSION_NOT_FOUND: sessionId=${attachToSessionId}`);
        }
        if (existing.state !== "ANALYZING") {
          // 想像で先へ進まない: retryFormationSessionがFAILED→ANALYZINGへ遷移させた
          // 直後のはずだが、想定外に他状態(例: 二重retry・並行操作)になっていた場合は
          // 新candidateを誤って書き込まず失敗させる(checkpoint機構が観測・再試行する)。
          throw new Error(`RETRY_ATTACH_SESSION_INVALID_STATE: sessionId=${attachToSessionId} state=${existing.state}`);
        }
        session = { id: existing.id, questionCount: existing.questionCount };
        const lastEvent = await tx.formationSessionEvent.findFirst({
          where: { workspaceId: capture.workspaceId, sessionId: session.id },
          orderBy: { sequence: "desc" },
          select: { sequence: true },
        });
        sequence = (lastEvent?.sequence ?? 0) + 1;
      } else {
        const created = await tx.formationSession.create({
          data: {
            workspaceId: capture.workspaceId,
            domainId: capture.domainId as string,
            subjectUserId: capture.createdById,
            captureId: capture.id,
            clientSessionKey,
            state: "DRAFT",
          },
        });
        session = { id: created.id, questionCount: created.questionCount };
        sequence = 1;
      }

      const emit = (eventType: FormationEventType, payload: object) =>
        tx.formationSessionEvent.create({
          data: {
            workspaceId: capture.workspaceId,
            sessionId: session.id,
            sequence: sequence++,
            eventType,
            actorType: "SYSTEM",
            payload: payload as object,
          },
        });

      if (!attachToSessionId) {
        await emit("FORMATION_CREATED", { captureId: capture.id });

        // DRAFT --START_ANALYSIS--> ANALYZING。coreTypes.tsの状態機械を実際に参照することで、
        // 正本の遷移表とshadow書込みの整合を機械的に保つ(遷移表を書き換えたときに
        // ここが追随漏れしないよう、遷移先を直接この関数がハードコードしない)。
        // [2026-08-30是正] 操作名をDOC-03語彙"ANALYZE"から統合正本§6.3語彙
        // "START_ANALYSIS"へ置換。
        const toAnalyzing = resolveFormationSessionTransition("DRAFT", "START_ANALYSIS");
        if (!toAnalyzing) throw new Error("coreTypes不整合: DRAFT--START_ANALYSIS-->の遷移が定義されていません");
        await tx.formationSession.update({
          where: { id: session.id },
          data: { state: toAnalyzing, version: { increment: 1 } },
        });
      }
      // [M1-B6C-4新設・§6.3] attach path(retry)ではSessionは既にANALYZING
      // (retryFormationSessionのFAILED--RETRY-->ANALYZING遷移による)なので、
      // このEventだけを「新しいanalysis attemptが開始した」証跡として追記する。
      await emit("ANALYSIS_REQUESTED", { aiRunId });

      // ANALYZING --success--> 候補作成後、Question Policyで質問要否を判定して
      // CLARIFYING(質問あり)/REVIEW_READY(質問なし)へ遷移する(§6.4)。
      // ANALYZING --failure--> FAILED (候補0件)。
      // [2026-08-30是正・M1-B5a §4.2] DEC-010は解消済み(ファイル冒頭コメント参照)。
      // [2026-08-30是正] 操作名をDOC-03語彙"ANALYSIS_SUCCESS_NO_QUESTION"から
      // 統合正本§6.3語彙"NO_QUESTIONS_NEEDED"へ置換。
      const createdCandidates: CandidateForQuestionPolicy[] = [];
      if (candidates.length > 0) {
        await emit("ANALYSIS_SUCCEEDED", { candidateCount: candidates.length, captureSummary: captureSummary ?? null });
      } else {
        await emit("ANALYSIS_FAILED", { reason: "候補0件" });
        // [2026-08-30是正] 操作名をDOC-03語彙"ANALYSIS_FAILURE"から統合正本§6.3語彙
        // "ANALYSIS_FAILED"へ置換(FormationEventType側の"ANALYSIS_FAILED"とは別の
        // 名前空間=coreTypes.tsの操作enumであることに注意。EventTypeは変更なし)。
        const toFailed = resolveFormationSessionTransition("ANALYZING", "ANALYSIS_FAILED");
        if (!toFailed) throw new Error("coreTypes不整合: ANALYZING--ANALYSIS_FAILED-->の遷移が定義されていません");
        await tx.formationSession.update({
          where: { id: session.id },
          data: { state: toFailed, version: { increment: 1 } },
        });
      }

      // [M1-B6C-2新設・2026-09-01 Gate M1-B6C-2「Source Anchor live配線」]
      // candidateループの外で1回だけ、このCaptureに対応する文字起こしAiRunの
      // segmentsを取得し、rawText内での文字offsetへ位置特定しておく
      // (候補ごとに毎回DBを読みに行く必要はない。同一Captureに対して同じ結果)。
      // sourceType!=="VOICE"の場合、および音声だが文字起こしAiRunが見つからない
      // 場合(このGate以前のCapture、話題分割された子Capture等)は`located`が
      // 空配列のままとなり、AUDIO_TIMECODE Anchorは全てUNAVAILABLEになる
      // (捏造しない。transcriptSegmentMapping.tsのモジュールコメント参照)。
      let locatedAudioSegments: ReturnType<typeof locateTranscriptSegmentCharOffsets> = [];
      if (capture.sourceType === "VOICE") {
        const transcriptionAiRun = await tx.aiRun.findFirst({
          where: { captureId: capture.id, transcriptSegments: { not: Prisma.DbNull } },
          orderBy: { startedAt: "desc" },
        });
        if (transcriptionAiRun?.transcriptSegments) {
          locatedAudioSegments = locateTranscriptSegmentCharOffsets(
            capture.rawText,
            transcriptionAiRun.transcriptSegments as unknown as AiTranscriptionSegment[],
          );
        }
      }

      for (const candidate of candidates) {
        const identity = await tx.formationCandidateIdentity.create({
          data: {
            workspaceId: capture.workspaceId,
            sessionId: session.id,
            candidateKey: candidate.candidateId,
          },
        });

        const revision = await tx.formationCandidateRevision.create({
          data: {
            workspaceId: capture.workspaceId,
            candidateId: identity.id,
            revision: 1,
            type: candidate.type,
            title: candidate.title,
            description: candidate.description ?? null,
            // AI提案の全fields(dateMentions/actor/importance/suggestedTags等)を
            // そのまま下書きとして保持する(M1-BのMaterialize service接続はまだ無いため、
            // ここでの厳密なmapping先ResponsibilityDetail型は未確定)。
            proposedFields: candidate as unknown as object,
            // [M1-B6A追加・2026-08-31指示書§3.2.3「Source Anchorのない断定候補は
            // confidence上限0.49を保存前に強制する」] 実在するTEXT_OFFSET
            // evidenceSpan(=Capture本文のvalid rangeを指すもの)を1件も持たない
            // 候補は、AI自己申告のconfidenceをそのまま保存せず、
            // NO_EVIDENCE_CONFIDENCE_CAP(0.49)以下へ引き下げる。Revisionは
            // immutableなため、この判定は書込み前(ここ)で行う必要がある。
            confidence: capConfidenceForMissingEvidence(
              candidate.confidence,
              candidate.evidenceSpans.some((span) => isValidTextOffsetRange(span.start, span.end, capture.rawText.length)),
            ),
            schemaVersion,
          },
        });

        await tx.formationCandidateIdentity.update({
          where: { id: identity.id },
          data: { currentRevision: 1 },
        });

        // [2026-08-30新設・M1-C] Atomicity Assessment(統合正本§11)。
        // Revisionはimmutableなので、作成直後に1回だけ算出して保存する
        // (このファイルの他の観測記録=SourceAnchorと同じパターン)。
        // §11.3「AssessmentはObservationであり、責任を自動分割しない」に
        // 従い、ここでは記録のみでSession状態やCandidateへの副作用は起こさない。
        const assessment = assessAtomicity(candidate);
        await tx.formationAtomicityAssessment.create({
          data: {
            workspaceId: capture.workspaceId,
            revisionId: revision.id,
            assessment: assessment.assessment,
            reasonCode: assessment.reasonCode,
            evidence: assessment.evidence as unknown as object,
            confidence: assessment.confidence,
            algorithmVersion: assessment.algorithmVersion,
          },
        });

        await emit("CANDIDATE_CREATED", { candidateKey: candidate.candidateId, revisionId: revision.id, type: candidate.type });

        // [PATTERN-SUGGEST-01B新設・2026-09-05] 新しいFormationCandidateRevisionが
        // 確定した時点でCase Pattern照合をenqueueする(CHG-044「Pattern提案を
        // Candidate sourceとして接続」)。既存Session/Candidate/Event/Anchor書込みと
        // 同一transaction内で原子的にenqueueする(caseDetectQueue.tsのenqueueCaseDetect
        // と同じ「呼び出し元txの中で呼ぶ」設計)。subjectUserId=capture.createdById
        // (このファイル冒頭のformationSession.create呼出しと同じ値、DOC-03
        // 「FormationSession.subjectUserId」)。
        await enqueueCaseSuggestionMatch(tx, {
          workspaceId: capture.workspaceId,
          ownerSubjectUserId: capture.createdById,
          candidateId: identity.id,
          reasonCode: "CANDIDATE_REVISION_CREATED",
        });

        createdCandidates.push({ identityId: identity.id, createdOrder: createdCandidates.length, candidate });

        for (const span of candidate.evidenceSpans) {
          const validRange = isValidTextOffsetRange(span.start, span.end, capture.rawText.length);
          // 不正range(AIがCapture本文の範囲外を指した等)はoffsetをnullにして保存する
          // (formation_source_anchors_text_offset_check CHECKに合わせ、両方null
          // またはstart<end<=lengthのどちらかのみを許可するため)。SOURCE_ANCHOR_ATTACHED
          // Event自体はcandidateの根拠件数として残す。
          // [M1-B6A追加・2026-08-31指示書§3.2.1] 不正rangeの場合、quality=
          // UNAVAILABLEとして明示的に記録する(isValidSourceAnchorKindFieldsの
          // TEXT_OFFSET/AVAILABLE契約はstartOffset/endOffset非null必須のため、
          // quality=AVAILABLEのまま両方nullにすると不整合になる)。
          const excerpt = validRange ? capture.rawText.slice(span.start, span.end) : "";
          const excerptHash = createHash("sha256").update(excerpt).digest("hex");
          await tx.formationSourceAnchor.create({
            data: {
              workspaceId: capture.workspaceId,
              revisionId: revision.id,
              sourceKind: "TEXT_OFFSET",
              captureId: capture.id,
              startOffset: validRange ? span.start : null,
              endOffset: validRange ? span.end : null,
              excerptHash,
              quality: validRange ? "AVAILABLE" : "UNAVAILABLE",
              unavailableReason: validRange ? null : "TEXT_OFFSET_OUT_OF_RANGE",
              // [2026-08-30是正・M1-B6] classifyPii()による客観的pattern検出
              // (メールアドレス・電話番号)を適用する。
              // [R1-05是正・監査是正指示書2026-08-31] 不正range(excerptが空文字列)
              // の場合、以前は「判定材料が無い」ことを「PII無しと確認した」NONEへ
              // 倒していたが、これはAnchor品質(判定材料の有無)とPII分類(判定
              // 結果)を混同する誤りだった。classifyPii("")は現在UNCLASSIFIEDを
              // 返すため、この呼出しをそのまま使うだけで正しく「未分類」として
              // 記録される(NONEへの特別扱いは不要になった)。
              piiClassification: classifyPii(excerpt),
            },
          });
          await emit("SOURCE_ANCHOR_ATTACHED", {
            candidateKey: candidate.candidateId,
            start: span.start,
            end: span.end,
            validRange,
          });

          // [M1-B6C-2新設・2026-09-01] VOICE Captureの場合、同じevidence根拠に
          // 対してAUDIO_TIMECODE Anchorも追加で記録する。TEXT_OFFSET Anchorを
          // 置き換えるのではなく併記する(§4「evidenceとsegmentを対応できない
          // 場合は捏造せずUNAVAILABLE/TEXT_OFFSET fallback」に従い、TEXT_OFFSETは
          // 常に事実として残し、AUDIO_TIMECODEは分かる場合の追加情報として扱う)。
          if (capture.sourceType === "VOICE") {
            const matchedSegment = validRange ? findAudioSegmentForSpan(locatedAudioSegments, span.start, span.end) : null;
            const audioFields = buildAudioTimecodeAnchorFields(
              matchedSegment ? { startMs: matchedSegment.startMs, endMs: matchedSegment.endMs, text: "" } : null,
              matchedSegment ? matchedSegment.segmentIndex : null,
            );
            await tx.formationSourceAnchor.create({
              data: {
                workspaceId: capture.workspaceId,
                revisionId: revision.id,
                sourceKind: "AUDIO_TIMECODE",
                captureId: capture.id,
                excerptHash,
                quality: audioFields.quality,
                unavailableReason: audioFields.unavailableReason,
                audioStartMs: audioFields.audioStartMs,
                audioEndMs: audioFields.audioEndMs,
                segmentIndex: audioFields.segmentIndex,
                piiClassification: classifyPii(excerpt),
              },
            });
          }
        }
      }

      if (createdCandidates.length > 0) {
        await applyQuestionPolicyAndTransition({
          tx,
          workspaceId: capture.workspaceId,
          sessionId: session.id,
          // [M1-B6C-4是正・§6.3] 新規Session作成時は常に0だが、retry attach path
          // では既存Sessionの実際のquestionCountを使う必要がある(生涯合計3問の
          // 上限を跨いで守るため、想像で0にリセットしない)。
          questionCountBefore: session.questionCount,
          candidates: createdCandidates,
          actorType: "SYSTEM",
          actorUserId: null,
        });
      }

      return session.id;
    });

    debugServer.event("formation/shadowWrite", "SHADOW_SESSION_WRITTEN", {
      captureId: capture.id,
      aiRunId,
      candidateCount: candidates.length,
    });
  } catch (err) {
    // [2026-08-31是正 M1-B6C-1] 握り潰さず呼び出し元(processShadowCheckpoint)へ
    // 伝播する。呼び出し元がcheckpoint行のstatus/lastErrorCode等へ永続記録する。
    debugServer.error("formation/shadowWrite", "SHADOW_WRITE_FAILED", {
      captureId: capture.id,
      aiRunId,
      err,
    });
    throw err;
  }
}
