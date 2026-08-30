import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { debugServer } from "@/lib/debugServer";
import { ResponsibilityCandidateSchema, type ResponsibilityCandidate } from "@/lib/ai/schema";
import { RESPONSIBILITY_TYPES } from "@/lib/responsibility";
import { resolveLegacyProjectionMap } from "@/lib/formation/legacyProjectionResolver";
import { sessionEventTypeForDecision } from "@/lib/formation/materialize";
import { assessAtomicity } from "@/lib/formation/atomicityAssessment";

/**
 * V5-M1-C Split Correction service。
 * 出典: `ISMAY_統合正本仕様書_v5_0.md` §11.4「分解Transaction」
 * 「本人が承認した場合のみ、元候補又は責任にSPLIT Correctionを追記し、新しい
 * Responsibility群とRelationを同一transactionで作る。元責任の履歴は削除しない。」
 *
 * [対象範囲の明記] 正本は「元候補**又は**責任」の両方を分解対象として認める。
 * このGate(M1-C)ではFormation Session domainの**候補**(materialize前)の
 * 分解のみを実装する。既にmaterialize済みのResponsibility本体の分解
 * (post-materialize split)は、Responsibility Graph・既存Relation体系との
 * 整合を別途検討する必要があり、このPatchのscope外とする(想像で範囲を広げない)。
 *
 * [設計方針] `materialize.ts`の`recordCandidateDecision`と全く同じ不変条件
 * パターンを踏襲する: Session行FOR UPDATE lock、legacy横断guard、
 * ALREADY_DECIDED/REVISION_CONFLICT判定。分解して生まれた子候補は「AIが
 * 提案した候補」ではなく「本人がSPLIT操作で確定した候補」であるため、
 * 子候補のconfidenceは1(本人確定)とし、Question Policyの再評価対象にはしない
 * (本人が既に内容を確定させた上でのSPLIT操作であり、直後にまたQuestion Policyが
 * 質問を生成すると「確定させたのにまた聞かれる」という体験になり§3「入力負荷
 * 削減」思想に反するため。子候補はSession=REVIEW_READY/PARTIALLY_CONFIRMEDの
 * ままACCEPT/REJECTの対象として直接並ぶ)。
 *
 * [MERGEはこのGateでは未実装] 複数候補を1件に統合するMERGE transactionは、
 * 「どの候補群を対象にするか」「統合後の内容を誰がどう決めるか」の入力形が
 * SPLITと非対称で、UI設計も含め別途検討が必要なため、このPatchでは
 * coreTypes.tsへの値の予約(`MERGED`)のみ行い、実装は次のGateへ持ち越す。
 *
 * db.ts を直接importして良い(このファイルはmaterialize.ts等と同じくAPI route
 * から呼ばれるservice層であり、db非依存pure testの対象ではないため)。
 */

export interface SplitCandidatePartInput {
  type: string;
  title: string;
  description?: string;
  completionCondition?: string;
}

export interface SplitCandidateParams {
  sessionId: string;
  workspaceId: string;
  candidateId: string;
  /** 分解対象を固定するため、クライアントが直前に見ていたcurrentRevisionを渡す
   *  (既存recordCandidateDecisionの`expectedRevision`と同じ設計)。 */
  expectedRevision: number;
  parts: SplitCandidatePartInput[];
  reasonCode?: string;
  actorUserId: string;
}

export interface SplitCandidateNewCandidate {
  identityId: string;
  candidateKey: string;
  revisionId: string;
  title: string;
}

export type SplitCandidateResult =
  | { ok: true; decisionEventId: string; sessionState: string; newCandidates: SplitCandidateNewCandidate[] }
  | { ok: false; error: "NOT_FOUND" }
  | { ok: false; error: "REVISION_CONFLICT"; latestRevision: number }
  | { ok: false; error: "ALREADY_DECIDED"; existingDecision: string }
  | { ok: false; error: "INVALID_SESSION_STATE"; sessionState: string }
  /** §3.2条件「独立して完了判定できる成果を複数内包しない」の裏返しとして、
   *  分解には最低2つの独立した部分が必要(1つしか無ければ分解にならない)。 */
  | { ok: false; error: "INVALID_SPLIT_PARTS"; reason: string }
  | { ok: false; error: "ALREADY_MATERIALIZED_BY_LEGACY"; legacyInferenceId: string; legacyDecision: string }
  | { ok: false; error: "ALREADY_DECIDED_BY_LEGACY"; legacyInferenceId: string; legacyDecision: string }
  | { ok: false; error: "LEGACY_PROJECTION_CONFLICT"; legacyInferenceId: string; legacyDecision: string };

const RESPONSIBILITY_TYPE_SET = new Set<string>(RESPONSIBILITY_TYPES);

function validateParts(parts: SplitCandidatePartInput[]): string | null {
  if (parts.length < 2) {
    return "分解には2件以上の部分が必要です";
  }
  for (const [i, part] of parts.entries()) {
    if (!RESPONSIBILITY_TYPE_SET.has(part.type)) {
      return `parts[${i}].typeが不正です: ${part.type}`;
    }
    if (!part.title || part.title.trim().length === 0) {
      return `parts[${i}].titleが空です`;
    }
  }
  return null;
}

export async function splitFormationCandidate(params: SplitCandidateParams): Promise<SplitCandidateResult> {
  const { sessionId, workspaceId, candidateId, expectedRevision, parts, reasonCode, actorUserId } = params;

  const partsError = validateParts(parts);
  if (partsError) {
    return { ok: false, error: "INVALID_SPLIT_PARTS", reason: partsError };
  }

  return await db.$transaction(async (tx: Prisma.TransactionClient) => {
    // [recordCandidateDecisionと同じB3.1是正パターン] Session行をFOR UPDATEでlockし、
    // 同一Sessionへの並行Decision記録・Materializeと直列化する。
    const sessionRows = await tx.$queryRaw<{ id: string; version: number; state: string }[]>`
      SELECT id, version, state FROM formation_sessions
      WHERE id = ${sessionId} AND workspace_id = ${workspaceId}
      FOR UPDATE`;
    const session = sessionRows[0];
    if (!session) return { ok: false, error: "NOT_FOUND" } as const;

    if (session.state !== "REVIEW_READY" && session.state !== "PARTIALLY_CONFIRMED") {
      return { ok: false, error: "INVALID_SESSION_STATE", sessionState: session.state } as const;
    }

    const identity = await tx.formationCandidateIdentity.findFirst({
      where: { id: candidateId, sessionId, workspaceId },
    });
    if (!identity) return { ok: false, error: "NOT_FOUND" } as const;

    if (identity.currentRevision !== expectedRevision) {
      return { ok: false, error: "REVISION_CONFLICT", latestRevision: identity.currentRevision } as const;
    }

    // [recordCandidateDecisionと同じB4.1新設・3.3節] 旧新横断guard。
    const legacyMap = await resolveLegacyProjectionMap(tx, { sessionId, workspaceId });
    const legacyEntry = legacyMap?.byCandidateKey.get(identity.candidateKey) ?? null;
    if (legacyEntry) {
      if (legacyEntry.decision === "ACCEPTED" || legacyEntry.decision === "EDITED") {
        if (legacyEntry.responsibilityId) {
          return {
            ok: false,
            error: "ALREADY_MATERIALIZED_BY_LEGACY",
            legacyInferenceId: legacyEntry.inferenceId,
            legacyDecision: legacyEntry.decision,
          } as const;
        }
        return {
          ok: false,
          error: "LEGACY_PROJECTION_CONFLICT",
          legacyInferenceId: legacyEntry.inferenceId,
          legacyDecision: legacyEntry.decision,
        } as const;
      }
      if (legacyEntry.decision === "REJECTED" || legacyEntry.decision === "HELD") {
        return {
          ok: false,
          error: "ALREADY_DECIDED_BY_LEGACY",
          legacyInferenceId: legacyEntry.inferenceId,
          legacyDecision: legacyEntry.decision,
        } as const;
      }
    }

    const existingDecision = await tx.formationCandidateDecisionEvent.findFirst({
      where: { candidateId: identity.id, workspaceId },
      orderBy: { occurredAt: "desc" },
    });
    if (existingDecision) {
      return { ok: false, error: "ALREADY_DECIDED", existingDecision: existingDecision.decision } as const;
    }

    const revision = await tx.formationCandidateRevision.findFirst({
      where: { candidateId: identity.id, workspaceId, revision: expectedRevision },
    });
    if (!revision) return { ok: false, error: "NOT_FOUND" } as const;

    // [§11.4「SPLIT Correctionを追記」] 元候補にSPLIT決定を記録する
    // (recordCandidateDecisionと同じCandidateDecisionEvent機構を使う。
    // ただしSPLITはこの専用serviceからしか作れない、materialize.ts側で防御済み)。
    const decisionEvent = await tx.formationCandidateDecisionEvent.create({
      data: {
        workspaceId,
        candidateId: identity.id,
        revisionId: revision.id,
        decision: "SPLIT",
        reasonCode: reasonCode ?? null,
        actorUserId,
      },
    });

    const lastSessionEvent = await tx.formationSessionEvent.findFirst({
      where: { sessionId, workspaceId },
      orderBy: { sequence: "desc" },
    });
    let nextSequence = (lastSessionEvent?.sequence ?? 0) + 1;

    await tx.formationSessionEvent.create({
      data: {
        workspaceId,
        sessionId,
        sequence: nextSequence++,
        eventType: sessionEventTypeForDecision("SPLIT"),
        actorType: "USER",
        actorUserId,
        payload: {
          candidateId: identity.id,
          candidateKey: identity.candidateKey,
          decision: "SPLIT",
          revisionId: revision.id,
          partCount: parts.length,
        } as object,
      },
    });

    // [§11.4「新しい…群とRelationを同一transactionで作る」] 元候補のevidenceSpansを
    // 各子候補が参照(inherit)する。子候補自体は本人がSPLIT操作で入力した新しい
    // 内容であり、AI抽出のような原文中の新しい根拠位置は存在しないため、
    // 「元候補が根拠としていた原文範囲」をそのまま引き継ぐことが最も忠実な
    // Source Anchorの扱いだと判断した([設計判断]。原文の別範囲を子候補ごとに
    // 個別指定させるUIは、このGateのscopeでは未実装)。
    const parsedParent = ResponsibilityCandidateSchema.safeParse(revision.proposedFields);
    const parentEvidenceSpans = parsedParent.success
      ? parsedParent.data.evidenceSpans
      : [{ start: 0, end: 1 }]; // [保守的fallback] 親candidateのproposedFieldsが壊れていた場合でも
    // SPLIT自体(本人の明示操作)を失敗させない。子候補のevidenceSpansはschema上
    // 必須(min 1)のため、既知の妥当な最小値で埋める(実データの根拠が無いことは
    // 子候補には実質的な影響を与えない。SourceAnchorそのものは作らないため)。

    const newCandidates: SplitCandidateNewCandidate[] = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const childCandidateKey = `${identity.candidateKey}-split-${i + 1}`;
      const childIdentity = await tx.formationCandidateIdentity.create({
        data: {
          workspaceId,
          sessionId,
          candidateKey: childCandidateKey,
        },
      });

      const childCandidate: ResponsibilityCandidate = {
        candidateId: childCandidateKey,
        type: part.type as ResponsibilityCandidate["type"],
        title: part.title,
        description: part.description,
        completionCondition: part.completionCondition,
        evidenceSpans: parentEvidenceSpans,
        // [設計判断] 本人がSPLIT操作で確定した内容のため、AI抽出のconfidenceとは
        // 異なる意味で1(最大)とする。
        confidence: 1,
        dateMentions: [],
        unknowns: [],
        blockedByCandidateIds: [],
        suggestedTags: [],
      };

      const childRevision = await tx.formationCandidateRevision.create({
        data: {
          workspaceId,
          candidateId: childIdentity.id,
          revision: 1,
          type: part.type,
          title: part.title,
          description: part.description ?? null,
          proposedFields: childCandidate as unknown as object,
          confidence: 1,
          schemaVersion: revision.schemaVersion,
        },
      });

      await tx.formationCandidateIdentity.update({
        where: { id: childIdentity.id },
        data: { currentRevision: 1 },
      });

      // [M1-C是正・formationVerifyCleanup.tsの教訓を踏まえ、実装と同じPatch内で
      // Atomicity Assessmentも必ず算出する。shadowWrite.ts/answerService.tsと
      // 同じ「Revision作成直後に1回だけ算出」パターン。]
      const childAssessment = assessAtomicity(childCandidate);
      await tx.formationAtomicityAssessment.create({
        data: {
          workspaceId,
          revisionId: childRevision.id,
          assessment: childAssessment.assessment,
          reasonCode: childAssessment.reasonCode,
          evidence: childAssessment.evidence as unknown as object,
          confidence: childAssessment.confidence,
          algorithmVersion: childAssessment.algorithmVersion,
        },
      });

      await tx.formationSessionEvent.create({
        data: {
          workspaceId,
          sessionId,
          sequence: nextSequence++,
          eventType: "CANDIDATE_CREATED",
          actorType: "USER",
          actorUserId,
          payload: {
            candidateKey: childCandidateKey,
            revisionId: childRevision.id,
            type: part.type,
            splitFromCandidateId: identity.id,
            splitFromCandidateKey: identity.candidateKey,
          } as object,
        },
      });

      newCandidates.push({
        identityId: childIdentity.id,
        candidateKey: childCandidateKey,
        revisionId: childRevision.id,
        title: part.title,
      });
    }

    debugServer.event("formation/splitCorrection", "CANDIDATE_SPLIT", {
      sessionId,
      candidateId: identity.id,
      newCandidateCount: newCandidates.length,
    });

    return {
      ok: true,
      decisionEventId: decisionEvent.id,
      sessionState: session.state,
      newCandidates,
    } as const;
  });
}
