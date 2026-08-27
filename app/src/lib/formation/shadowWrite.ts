import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { debugServer } from "@/lib/debugServer";
import type { ResponsibilityCandidate } from "@/lib/ai/schema";
import { resolveFormationSessionTransition, isValidTextOffsetRange, type FormationEventType } from "@/lib/formation/coreTypes";

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

      // DRAFT --analyze--> ANALYZING。coreTypes.tsの状態機械を実際に参照することで、
      // 正本の遷移表とshadow書込みの整合を機械的に保つ(遷移表を書き換えたときに
      // ここが追随漏れしないよう、遷移先を直接この関数がハードコードしない)。
      const toAnalyzing = resolveFormationSessionTransition("DRAFT", "ANALYZE");
      if (!toAnalyzing) throw new Error("coreTypes不整合: DRAFT--analyze-->の遷移が定義されていません");
      await tx.formationSession.update({
        where: { id: session.id },
        data: { state: toAnalyzing, version: { increment: 1 } },
      });
      await emit("ANALYSIS_REQUESTED", { aiRunId });

      // ANALYZING --success/no question--> REVIEW_READY (候補>=1) または
      // ANALYZING --failure--> FAILED (候補0件)。
      // [DEC-010] Question Policy(質問生成)はこのGateでは未接続のため、
      // success/question分岐(CLARIFYING)は使わない(質問を生成する主体が
      // まだ存在しない。想像でCLARIFYINGへ遷移させない)。
      if (candidates.length > 0) {
        await emit("ANALYSIS_SUCCEEDED", { candidateCount: candidates.length, captureSummary: captureSummary ?? null });
        const toReviewReady = resolveFormationSessionTransition("ANALYZING", "ANALYSIS_SUCCESS_NO_QUESTION");
        if (!toReviewReady) throw new Error("coreTypes不整合: ANALYZING--success/no question-->の遷移が定義されていません");
        await tx.formationSession.update({
          where: { id: session.id },
          data: { state: toReviewReady, version: { increment: 1 } },
        });
      } else {
        await emit("ANALYSIS_FAILED", { reason: "候補0件" });
        const toFailed = resolveFormationSessionTransition("ANALYZING", "ANALYSIS_FAILURE");
        if (!toFailed) throw new Error("coreTypes不整合: ANALYZING--failure-->の遷移が定義されていません");
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

        await emit("CANDIDATE_CREATED", { candidateKey: candidate.candidateId, revisionId: revision.id, type: candidate.type });

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
              // [DEC-011] PII自動分類器はこのGateでは未実装のため、既定でNONEとする
              // (誤ってHIGHより安全側に倒すのではなく、「分類していない」ことを示す
              // 明示的な既定値として選ぶ。将来分類器が実装されたら再計算する)。
              piiClassification: "NONE",
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
