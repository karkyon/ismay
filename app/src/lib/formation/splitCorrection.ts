import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { debugServer } from "@/lib/debugServer";
import { ResponsibilityCandidateSchema, type ResponsibilityCandidate } from "@/lib/ai/schema";
import { RESPONSIBILITY_TYPES } from "@/lib/responsibility";
import { resolveLegacyProjectionMap } from "@/lib/formation/legacyProjectionResolver";
import { sessionEventTypeForDecision } from "@/lib/formation/materialize";
import { assessAtomicity } from "@/lib/formation/atomicityAssessment";
import { enqueueCaseSuggestionMatch } from "@/lib/patterns/caseSuggestQueue";

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
 * [MERGE実装状況の記録・R1-04是正で明確化] 複数候補を1件に統合するMERGE
 * transactionは「どの候補群を対象にするか」「統合後の内容を誰がどう決めるか」の
 * 入力形がSPLITと非対称で、UI設計も含め別途検討が必要だったため、このファイルが
 * 最初に書かれた時点ではcoreTypes.tsへの値の予約(`MERGED`)のみ行い、実装は
 * 次のGateへ持ち越していた。[2026-08-30更新・M1-C2B] MERGE本体は
 * `mergeCorrection.ts`で実装済み(このfileのSPLIT実装と対になる、同じ不変条件
 * パターンを踏襲したtransaction)。上記の段落はこのfileが最初に書かれた時点の
 * 状況説明として残す。
 *
 * [2026-08-30是正・M1-C2C] `formation_candidate_lineages`(mergeCorrection.tsが
 * 使うのと同じtable)への記録、実Source Anchor行の子候補への複製、
 * proposedFields parse失敗時の架空evidenceSpans fallback廃止(CORRUPTED_
 * CANDIDATE_DATAとして明示的に失敗させる)を追加した。DEC-MERGE-001「根拠が
 * 無い場合は空/UNKNOWNとして表し、offsetを捏造しない」をSplitにも適用する。
 * [重要な教訓] このparseチェックは書き込み開始前(decisionEvent作成前)に
 * 置かなければならない。Prismaの`$transaction`はcallbackが`return`で
 * 終わっても書き込み済みの内容をそのままcommitするため、書き込み後に
 * 検証すると「decisionEventだけ作られてSPLIT全体は失敗扱い」という
 * 不整合を起こす(初回実装時に実機検証で検出・是正した順序ミス)。
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
  | { ok: false; error: "LEGACY_PROJECTION_CONFLICT"; legacyInferenceId: string; legacyDecision: string }
  /** [2026-08-30新設・M1-C2C是正] 親candidateのproposedFieldsがResponsibilityCandidateSchema
   *  へparseできない(破損データ)場合。旧実装はここで架空の`[{start:0,end:1}]`を
   *  fallbackとして使い、SPLIT自体を握りつぶして成功させていた
   *  (DEC-MERGE-001「根拠が無い場合は空/UNKNOWNとして表し、offsetを捏造しない」
   *  の精神に反する)。materialize.tsのCORRUPTED_CANDIDATE_DATAと同じ考え方で、
   *  破損データを検知したら明示的に失敗させる。[重要] このcheckは必ず
   *  transaction内のどの書き込みよりも前に置くこと。Prismaの`$transaction`は
   *  callbackがreturnで終わっても(throwしない限り)それまでの書き込みを
   *  そのままcommitするため、書き込み後に検証するとpartial commitの
   *  不整合を起こす(初回実装でこの順序ミスを実機検証で検出・是正した)。 */
  | { ok: false; error: "CORRUPTED_CANDIDATE_DATA" };

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
    const sessionRows = await tx.$queryRaw<{ id: string; version: number; state: string; subject_user_id: string }[]>`
      SELECT id, version, state, subject_user_id FROM formation_sessions
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

    // [2026-08-30是正・M1-C2C DEC-MERGE-001準拠、かつtransaction順序の重要な教訓]
    // このcheckは必ずどの書き込みよりも前に置く。Prismaの
    // `$transaction(async (tx) => {...})`は、callbackが`return`で終わっても
    // (throwしない限り)それまでの書き込みをそのままcommitしてしまう。旧実装は
    // このparseチェックをdecisionEvent作成の*後*に置いており、parse失敗時に
    // 「decisionEventだけ作られ、SPLIT自体は失敗として返る」という不整合な
    // commitを起こしていた(初回実装時の実機検証で実際に踏んだ回帰: 元候補への
    // SPLIT decisionEventが残ってしまいALREADY_DECIDED状態のまま取り残される)。
    // 全ての判定・検証を先に完了させてから書き込みを開始する、という既存の
    // 他guard(NOT_FOUND/REVISION_CONFLICT/ALREADY_DECIDED等)と同じ順序原則に
    // 揃える(旧実装ではこの原則がevidenceSpans検証部分だけ破られていた)。
    const parsedParent = ResponsibilityCandidateSchema.safeParse(revision.proposedFields);
    if (!parsedParent.success) {
      return { ok: false, error: "CORRUPTED_CANDIDATE_DATA" } as const;
    }
    const parentEvidenceSpans = parsedParent.data.evidenceSpans;

    // [2026-08-30新設・M1-C2C是正] mergeCorrection.tsと同じく、実際の
    // FormationSourceAnchor行を継承する準備として、書き込み開始前に親の
    // Anchorを取得しておく(旧実装はproposedFields.evidenceSpansをJSONに
    // コピーするだけで、DBで照会可能なAnchor行を子候補へ一切作っていなかった)。
    // Split(1親→N子)はMerge(N親→1子)と異なり複数の子それぞれが親の全根拠を
    // 参照しうるため、重複排除は不要(各子へ親の全Anchorをそのまま複製する)。
    const parentAnchors = await tx.formationSourceAnchor.findMany({
      where: { revisionId: revision.id, workspaceId },
    });

    // [§11.4「SPLIT Correctionを追記」] ここから書き込み開始。元候補にSPLIT決定を
    // 記録する(recordCandidateDecisionと同じCandidateDecisionEvent機構を使う。
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
        // [M1-B6B追加] 本人がSPLIT操作で明示確定させた子候補のため、質問すべき
        // 曖昧性は無い(clarificationSignalsは空)。
        clarificationSignals: [],
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

      // [PATTERN-SUGGEST-01B新設・2026-09-05] Split結果の各子Candidateに対しても
      // Case Pattern照合をenqueueする(shadowWrite.ts/answerService.ts/
      // mergeCorrection.tsと同じ理由)。
      await enqueueCaseSuggestionMatch(tx, {
        workspaceId,
        ownerSubjectUserId: session.subject_user_id,
        candidateId: childIdentity.id,
        reasonCode: "CANDIDATE_REVISION_CREATED",
      });

      // [2026-08-30新設・M1-C2C是正] 親のSource Anchorを子へ複製する
      // (DBで照会可能な実Anchor行。mergeCorrection.tsと対になる実装)。
      for (const anchor of parentAnchors) {
        await tx.formationSourceAnchor.create({
          data: {
            workspaceId,
            revisionId: childRevision.id,
            sourceKind: anchor.sourceKind,
            captureId: anchor.captureId,
            startOffset: anchor.startOffset,
            endOffset: anchor.endOffset,
            imageRegion: anchor.imageRegion ?? undefined,
            excerptHash: anchor.excerptHash,
            piiClassification: anchor.piiClassification,
            // [M1-B6A追加・2026-08-31指示書§3.2.3「Split/Mergeは全kind固有field
            // を正確に継承し、dedupeしても根拠を失わない」]
            audioStartMs: anchor.audioStartMs,
            audioEndMs: anchor.audioEndMs,
            segmentIndex: anchor.segmentIndex,
            speakerLabel: anchor.speakerLabel,
            speakerConfirmed: anchor.speakerConfirmed,
            pageIndex: anchor.pageIndex,
            ocrConfidence: anchor.ocrConfidence ?? undefined,
            quality: anchor.quality,
            unavailableReason: anchor.unavailableReason,
            anchorSchemaVersion: anchor.anchorSchemaVersion,
          },
        });
      }

      // [2026-08-30新設・M1-C2C是正] formation_candidate_lineagesへも記録する
      // (mergeCorrection.tsと統一。従来はFormationSessionEvent.payload内の
      // splitFromCandidateId/splitFromCandidateKeyのみで、DBで直接照会
      // できるlineage tableへは書き込んでいなかった)。
      await tx.formationCandidateLineage.create({
        data: {
          workspaceId,
          childRevisionId: childRevision.id,
          parentIdentityId: identity.id,
          parentRevisionId: revision.id,
          correctionKind: "SPLIT",
        },
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
