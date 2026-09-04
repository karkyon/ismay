import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { randomUUID } from "node:crypto";

/**
 * Case Pattern Catalog(M4) — append-only revision作成サービス(PATTERN-SCHEMA-01)。
 * 出典: 指示書「revision追加と同一transactionでのみ更新し、revision番号競合を処理する」。
 * 既存formation/mergeCorrection.tsの
 * `tx.formationCandidateRevision.create(...)` → `tx.formationCandidateIdentity.update({data:{currentRevision}})`
 * という「同一transaction内でrevision行を追加し、identity.currentRevisionを
 * 新しいrevision番号で更新する」パターンをそのまま踏襲する。
 *
 * [2026-09-03是正・実DB受入試験PS-05失敗の修正]
 * 当初はfindFirst(lock無し)+ P2002検出時リトライ(最大3回)という設計だったが、
 * 5並行createを行う受入試験で1件が3回のリトライを使い切って失敗した
 * (5-way競合に対しリトライ回数が根本的に不足していた)。
 * `recordCandidateDecision`/`materializeFormationSession`(materialize.ts)が
 * Session行を`SELECT ... FOR UPDATE`で明示的にlockして直列化しているのと同じ
 * 設計を踏襲し、CasePattern行自体をtx内で`FOR UPDATE`lockすることで、
 * 同時に複数のtransactionがrevision番号を確保しようとする競合自体を
 * DBレベルで排除する(想像で「リトライ回数を増やす」対処に頼らず、
 * 既存の確立されたlockパターンを再利用する)。
 */

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
 * 更新する。CasePattern行を`FOR UPDATE`でlockしてから読み書きするため、並行呼出しは
 * DBレベルで直列化され、revision番号の重複・取りこぼしは発生しない。
 *
 * 過去revision行そのものへのUPDATE/DELETEはこの関数を含め一切行わない
 * (append-only、指示書「revision行、SourceLink、FeedbackEventは更新で履歴を
 * 書き換えない」)。
 */
export async function createCasePatternRevision(
  input: CreateCasePatternRevisionInput,
): Promise<CreateCasePatternRevisionResult> {
  return await db.$transaction(async (tx: Prisma.TransactionClient): Promise<CreateCasePatternRevisionResult> => {
    const rows = await tx.$queryRaw<{ id: string; currentRevision: number }[]>`
      SELECT id, current_revision AS "currentRevision" FROM case_patterns
      WHERE id = ${input.patternId} AND workspace_id = ${input.workspaceId}
      FOR UPDATE`;
    const pattern = rows[0];
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
}

/**
 * [PATTERN-DETECT-02A新設・2026-09-04] NO_MATCH判定時、新規CasePattern
 * identity + revision 1を同一transactionで作成する。
 * 出典: 指示書§3.2 worker処理手順7「NO_MATCHならCasePattern identity +
 * revision 1 + embedding + SourceLinkを同一transactionで作成する」。
 *
 * [patternKey生成方針・想像で意味を発明しない] schema.prisma CasePattern.patternKey
 * のコメントは「生成アルゴリズム自体はこのGateのscope外」としていたが、
 * 本Gateで実際に新規Pattern作成を実装するため、ここで確定する。Pattern
 * identityの同一性はEmbedding類似度クラスタリング(casePatternMatchPolicy.ts)
 * が担うため、patternKey自体には意味的な内容(タイトルの正規化等)を持たせず、
 * 「このworkspace+本人内で一意な不透明トークン」として`crypto.randomUUID()`を
 * 用いる(想像でタイトルベースの疑似安定キーを発明し、キー生成自体を新たな
 * 曖昧性の発生源にしない)。
 *
 * title/representativeTextは呼び出し元(casePatternDetectionService.ts)が
 * 入力根拠(Responsibility.type/titleそのもの)から決定論的に構築した値を渡す
 * こと。AIに新規Patternのタイトルを生成させない(指示書§3.2「AIに捏造させない」)。
 */
export interface CreateCasePatternIdentityInput {
  workspaceId: string;
  ownerSubjectUserId: string;
  title: string;
  representativeText: string;
  decompositionTemplate: Prisma.InputJsonValue;
  thresholds: Prisma.InputJsonValue;
  schemaVersion: string;
}

export interface CreateCasePatternIdentityResult {
  patternId: string;
  revisionId: string;
  revision: number;
}

async function createCasePatternIdentityWithClient(
  tx: Prisma.TransactionClient,
  input: CreateCasePatternIdentityInput,
): Promise<CreateCasePatternIdentityResult> {
  const pattern = await tx.casePattern.create({
    data: {
      workspaceId: input.workspaceId,
      ownerSubjectUserId: input.ownerSubjectUserId,
      patternKey: randomUUID(),
      title: input.title,
      status: "NONE",
      currentRevision: 1,
    },
  });

  const revision = await tx.casePatternRevision.create({
    data: {
      workspaceId: input.workspaceId,
      patternId: pattern.id,
      revision: 1,
      representativeText: input.representativeText,
      decompositionTemplate: input.decompositionTemplate,
      thresholds: input.thresholds,
      schemaVersion: input.schemaVersion,
    },
  });

  return { patternId: pattern.id, revisionId: revision.id, revision: 1 };
}

/**
 * `tx`を渡した場合はそのtransaction内でPattern+Revisionのみを作成する
 * (呼び出し元がEmbedding保存・SourceLink作成まで同一transactionへ含める
 * ためのcomposable版、casePatternDetectionService.ts参照)。省略時は独立した
 * 新規transactionを開いて自己完結で実行する(既存呼び出し元・単体test向け)。
 */
export async function createCasePatternIdentity(
  input: CreateCasePatternIdentityInput,
  tx?: Prisma.TransactionClient,
): Promise<CreateCasePatternIdentityResult> {
  if (tx) {
    return createCasePatternIdentityWithClient(tx, input);
  }
  return await db.$transaction((innerTx: Prisma.TransactionClient) => createCasePatternIdentityWithClient(innerTx, input));
}
