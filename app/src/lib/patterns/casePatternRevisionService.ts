import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Case Pattern Catalog(M4) — append-only revision作成サービス(PATTERN-SCHEMA-01)。
 * 出典: 指示書「revision追加と同一transactionでのみ更新し、revision番号競合を処理する」。
 * 既存formation/mergeCorrection.tsの
 * `tx.formationCandidateRevision.create(...)` → `tx.formationCandidateIdentity.update({data:{currentRevision}})`
 * という「同一transaction内でrevision行を追加し、identity.currentRevisionを
 * 新しいrevision番号で更新する」パターンをそのまま踏襲する。
 *
 * 受入条件PS-05「revision番号の同時追加、重複revisionなし、片方retryまたは明示競合」
 * に対応するため、`case_pattern_revisions_pattern_revision_uq`
 * (patternId, revision)の一意制約への違反(P2002)を検出した場合、
 * 最新のcurrentRevisionを再読込してリトライする(最大3回、既存の楽観ロック
 * 系コードと同じ有限リトライ方針)。
 */

const MAX_RETRY_ATTEMPTS = 3;

export interface CreateCasePatternRevisionInput {
  workspaceId: string;
  patternId: string;
  representativeText: string;
  decompositionTemplate: Prisma.InputJsonValue;
  thresholds: Prisma.InputJsonValue;
  schemaVersion: string;
}

export interface CreateCasePatternRevisionResult {
  revisionId: string;
  revision: number;
}

/**
 * 新しいCasePatternRevisionを追加し、同一transaction内でCasePattern.currentRevisionを
 * 更新する。revision番号は常に「読込時点のcurrentRevision + 1」を試み、
 * 一意制約違反(他プロセスが同時に同じ番号を確保した場合)はcurrentRevisionを
 * 再読込してリトライする。
 *
 * 過去revision行そのものへのUPDATE/DELETEはこの関数を含め一切行わない
 * (append-only、指示書「revision行、SourceLink、FeedbackEventは更新で履歴を
 * 書き換えない」)。
 */
export async function createCasePatternRevision(
  input: CreateCasePatternRevisionInput,
): Promise<CreateCasePatternRevisionResult> {
  for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
    try {
      return await db.$transaction(async (tx: Prisma.TransactionClient): Promise<CreateCasePatternRevisionResult> => {
        const pattern = await tx.casePattern.findFirst({
          where: { id: input.patternId, workspaceId: input.workspaceId },
          select: { currentRevision: true },
        });
        if (!pattern) {
          throw new Error(`createCasePatternRevision: CasePattern not found (id=${input.patternId})`);
        }
        const nextRevision = pattern.currentRevision + 1;

        const created = await tx.casePatternRevision.create({
          data: {
            workspaceId: input.workspaceId,
            patternId: input.patternId,
            revision: nextRevision,
            representativeText: input.representativeText,
            decompositionTemplate: input.decompositionTemplate,
            thresholds: input.thresholds,
            schemaVersion: input.schemaVersion,
          },
        });

        const updateResult = await tx.casePattern.updateMany({
          where: { id: input.patternId, workspaceId: input.workspaceId },
          data: { currentRevision: nextRevision },
        });
        if (updateResult.count !== 1) {
          throw new Error(
            `createCasePatternRevision: CasePattern update affected ${updateResult.count} rows (expected 1)`,
          );
        }

        return { revisionId: created.id, revision: nextRevision };
      });
    } catch (err) {
      const isUniqueConflict = (err as { code?: string } | null)?.code === "P2002";
      const isLastAttempt = attempt === MAX_RETRY_ATTEMPTS - 1;
      if (!isUniqueConflict || isLastAttempt) {
        throw err;
      }
      // [並行競合対策・PS-05] 別プロセスが同じ(patternId, revision)を先に
      // 確保した場合、currentRevisionを再読込して次のループでリトライする。
    }
  }
  // 型上到達しないが、TypeScriptの制御フロー解析のためにthrowで閉じる。
  throw new Error("createCasePatternRevision: リトライ上限に到達しました(想定外の競合)");
}
