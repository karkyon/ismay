import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { debugServer } from "@/lib/debugServer";
import type { ResponsibilityCandidate } from "@/lib/ai/schema";
import { resolveFormationSessionTransition, isValidTextOffsetRange, type FormationEventType } from "@/lib/formation/coreTypes";
import { applyQuestionPolicyAndTransition, type CandidateForQuestionPolicy } from "@/lib/formation/formationQuestionService";
import { assessAtomicity } from "@/lib/formation/atomicityAssessment";
import { classifyPii } from "@/lib/formation/piiClassifier";

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
 * [エラー方針] この関数はfire-and-forgetのbest-effortとして呼び出し元
 * (ai/extract.ts)から呼ばれる。内部で例外を捕捉し、失敗しても本体のCapture/
 * AiInference確定処理には一切影響させない(DOC-03 UX契約1「Capture保存はAI障害と
 * 独立して完了する」と同じ精神を、shadow書込み自身の障害にも適用する)。
 */

export interface ShadowSourceCaptureContext {
  id: string;
  workspaceId: string;
  domainId: string | null;
  createdById: string;
  rawText: string;
}

export interface WriteShadowFormationSessionParams {
  capture: ShadowSourceCaptureContext;
  aiRunId: string;
  schemaVersion: string;
  candidates: ResponsibilityCandidate[];
  captureSummary?: string;
}

export async function writeShadowFormationSession(params: WriteShadowFormationSessionParams): Promise<void> {
  const { capture, aiRunId, schemaVersion, candidates, captureSummary } = params;

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

      const session = await tx.formationSession.create({
        data: {
          workspaceId: capture.workspaceId,
          domainId: capture.domainId as string,
          subjectUserId: capture.createdById,
          captureId: capture.id,
          clientSessionKey,
          state: "DRAFT",
        },
      });

      let sequence = 1;
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
            confidence: candidate.confidence,
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

        createdCandidates.push({ identityId: identity.id, createdOrder: createdCandidates.length, candidate });

        for (const span of candidate.evidenceSpans) {
          const validRange = isValidTextOffsetRange(span.start, span.end, capture.rawText.length);
          // 不正range(AIがCapture本文の範囲外を指した等)はoffsetをnullにして保存する
          // (formation_source_anchors_text_offset_check CHECKに合わせ、両方null
          // またはstart<end<=lengthのどちらかのみを許可するため)。SOURCE_ANCHOR_ATTACHED
          // Event自体はcandidateの根拠件数として残す。
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
        }
      }

      if (createdCandidates.length > 0) {
        await applyQuestionPolicyAndTransition({
          tx,
          workspaceId: capture.workspaceId,
          sessionId: session.id,
          questionCountBefore: 0,
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
    // [shadow] 失敗しても本体(Capture/AiInference)には一切影響させない。
    // ここで再throwしない設計そのものがDOC-03 UX契約1の意図的な保護である。
    debugServer.error("formation/shadowWrite", "SHADOW_WRITE_FAILED_IGNORED", {
      captureId: capture.id,
      aiRunId,
      err,
    });
  }
}
