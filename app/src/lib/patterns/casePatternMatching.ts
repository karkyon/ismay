/**
 * Case Pattern Embedding・exact cosine matching(PATTERN-DETECT-01D新設・2026-09-04)。
 * 出典: Claude向け_ISMAY_0fcea2b以降_再監査是正・PATTERN-DETECT連続実装指示_2026-09-03.md
 * §5 DR-Bの決定「同一Pattern判定はversioned embedding exact cosine」、
 * v1判定契約テーブル、§6 PATTERN-DETECT-01D、§7 受入条件 PD-09/PD-10/PD-11/PD-14。
 *
 * [設計方針] lib/ai/relatedResponsibilities.ts(embedAndStoreResponsibility /
 * findRelatedResponsibilities)と同型の設計。pgvectorの`embedding <=> vector`
 * (コサイン距離)を使用し、schema.prismaのembedding列は
 * Unsupported("vector(1536)")のためPrisma Clientの型付きAPIでは扱えず、
 * $executeRaw/$queryRawを使う(意図的、既存パターンを踏襲)。
 *
 * 判定方式のversion定数・閾値・分類ロジック本体はcasePatternMatchPolicy.ts
 * (db非依存、pure test対象)に分離している。このファイルはEmbeddingの生成・
 * 保存・DB問い合わせ(similarity計算)というI/O層のみを担当する。
 *
 * [scope宣言] このファイルはEmbeddingの生成・保存・「既存Patternに一致するか」
 * の判定(3値: MATCHED/AMBIGUOUS/NO_MATCH)を提供するI/O層である。
 * 「NO_MATCHの場合に新規CANDIDATE Patternを実際に作る」トリガー配線・
 * Detector本体(caseDetectQueueJob.ts)からの実際の呼び出しは、
 * PATTERN-DETECT-02A(casePatternDetectionService.ts)で実装した
 * (旧scope外注記は解消)。
 *
 * [依存性注入・テスト方針] 指示書「APIキーが無い環境では実provider呼出しを
 * 行わず、deterministic fake embeddingでqueue、冪等性、cosine、境界、曖昧性を
 * 検証する」に従い、`getProvider`をoverride可能にする
 * (lib/formation/materialize.tsのembedAndStoreResponsibility overrideと同じ
 * 依存性注入パターン)。本番既定値はgetActiveEmbeddingProvider。
 */
import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { debugServer } from "@/lib/debugServer";
import { getActiveEmbeddingProvider } from "@/lib/ai/config";
import type { AiEmbeddingProvider } from "@/lib/ai/embeddingProvider";
import { buildCasePatternEmbeddingText, type CasePatternDetectionCandidateInput } from "./casePatternEmbeddingText";
import {
  CASE_PATTERN_EMBEDDING_SOURCE_VERSION,
  classifyCasePatternMatchCandidates,
  type CasePatternMatchCandidate,
  type CasePatternMatchResult,
} from "./casePatternMatchPolicy";

export {
  CASE_PATTERN_MATCH_POLICY_VERSION,
  CASE_PATTERN_EMBEDDING_SOURCE_VERSION,
  CASE_PATTERN_MATCH_CANDIDATE_THRESHOLD,
  CASE_PATTERN_MATCH_AMBIGUITY_MARGIN,
  classifyCasePatternMatchCandidates,
  type CasePatternMatchResult,
  type CasePatternMatchCandidate,
} from "./casePatternMatchPolicy";

export interface CasePatternEmbeddingOverrides {
  /** 既定はgetActiveEmbeddingProvider。テストではdeterministic fake providerを注入する。 */
  getProvider?: (workspaceId: string) => Promise<AiEmbeddingProvider>;
}

function toVectorLiteral(vector: number[]): string {
  // pgvectorのテキスト入力形式: '[0.1,0.2,...]'(lib/ai/relatedResponsibilities.tsと同じ)。
  return `[${vector.join(",")}]`;
}

export type EmbedCasePatternRevisionResult =
  | { ok: true; model: string; dimensions: number }
  | { ok: false; errorKind: "TRANSIENT" | "FATAL"; reason: string };

/** DB契約(schema.prisma CasePatternEmbedding.embedding: vector(1536)固定)。 */
const CASE_PATTERN_EMBEDDING_DB_DIMENSIONS = 1536;

/**
 * [PATTERN-DETECT-02A是正・P1-3] provider outcomeのdimensionsを、DB列の
 * 固定次元(vector(1536))・ベクトル長・NaN/Infinity・空配列について、
 * DB書込み前に検証する。従来はこの検証が無く、1536以外の次元は分類されない
 * DB例外(未分類のPostgresエラー)として現れ、EmbedCasePatternRevisionResultの
 * FATALへ正規化されていなかった。秘密情報(APIキー等)を含まない明示的な
 * 理由文字列のみを返す。
 */
function validateEmbeddingVector(vector: number[], claimedDimensions: number): { ok: true } | { ok: false; reason: string } {
  if (!Array.isArray(vector) || vector.length === 0) {
    return { ok: false, reason: "embedding vectorが空です" };
  }
  if (vector.length !== claimedDimensions) {
    return {
      ok: false,
      reason: `provider outcomeのdimensions(${claimedDimensions})とvector長(${vector.length})が一致しません`,
    };
  }
  if (claimedDimensions !== CASE_PATTERN_EMBEDDING_DB_DIMENSIONS) {
    return {
      ok: false,
      reason: `dimensions(${claimedDimensions})がDB契約(${CASE_PATTERN_EMBEDDING_DB_DIMENSIONS})と一致しません`,
    };
  }
  for (const v of vector) {
    if (typeof v !== "number" || !Number.isFinite(v)) {
      return { ok: false, reason: "embedding vectorにNaN/Infinity/非数値要素が含まれています" };
    }
  }
  return { ok: true };
}

type PatternDbClient = typeof db | Prisma.TransactionClient;

export interface EmbedCasePatternCandidateSuccess {
  ok: true;
  vector: number[];
  vectorLiteral: string;
  model: string;
  dimensions: number;
}
export type EmbedCasePatternCandidateResult =
  | EmbedCasePatternCandidateSuccess
  | { ok: false; errorKind: "TRANSIENT" | "FATAL"; reason: string };

/**
 * [PATTERN-DETECT-02A新設] provider解決だけを単独で行う(modelNameを知るために
 * embed()自体を呼ぶ必要はない)。呼び出し元(casePatternDetectionService.ts)が
 * 「この本人・このsourceは既にこのmodelで処理済みか」をReceiptで先に確認し、
 * 未処理の場合のみembedCasePatternCandidateへ進むことで、不要なAI呼出しを
 * 避けられる(PE2E-02の再処理シナリオでAI呼出しを繰り返さない)。
 */
export async function resolveCasePatternEmbeddingProvider(
  workspaceId: string,
  overrides: CasePatternEmbeddingOverrides = {},
): Promise<AiEmbeddingProvider> {
  const getProvider = overrides.getProvider ?? getActiveEmbeddingProvider;
  return getProvider(workspaceId);
}

/**
 * [PATTERN-DETECT-02A新設] 候補テキストをEmbeddingへ変換するだけの最小単位。
 * 「マッチング判定」と「(NO_MATCH時の)新規Pattern Embedding保存」の両方で
 * 同じベクトルを再利用できるよう、AI呼出しをこの関数1回に集約する
 * (以前はmatchCasePatternとembedAndStoreCasePatternRevisionがそれぞれ
 * 独立にprovider.embed()を呼んでおり、NEW_PATTERN_CREATEDのたびにAI呼出しが
 * 2回発生し、かつ2回目の呼出し結果が1回目と異なるベクトルになり得た)。
 * `preResolvedProvider`を渡した場合はgetProvider解決を省略し、そのproviderで
 * embed()のみ行う(resolveCasePatternEmbeddingProviderと組み合わせて使う)。
 */
export async function embedCasePatternCandidate(
  workspaceId: string,
  candidate: CasePatternDetectionCandidateInput,
  overrides: CasePatternEmbeddingOverrides = {},
  preResolvedProvider?: AiEmbeddingProvider,
): Promise<EmbedCasePatternCandidateResult> {
  const provider = preResolvedProvider ?? (await resolveCasePatternEmbeddingProvider(workspaceId, overrides));
  const text = buildCasePatternEmbeddingText(candidate);
  const outcome = await provider.embed({ text });

  if (!outcome.ok) {
    return { ok: false, errorKind: outcome.kind, reason: outcome.message };
  }
  const validation = validateEmbeddingVector(outcome.vector, outcome.dimensions);
  if (!validation.ok) {
    return { ok: false, errorKind: "FATAL", reason: validation.reason };
  }
  return {
    ok: true,
    vector: outcome.vector,
    vectorLiteral: toVectorLiteral(outcome.vector),
    model: provider.modelName,
    dimensions: outcome.dimensions,
  };
}

/**
 * 既に計算済みのEmbeddingベクトルを、指定revisionのcase_pattern_embeddingsへ
 * upsertする(revisionId, model単位で1件、CHG-045「1 current/model」)。
 * `txOrDb`にtransaction clientを渡せば、Pattern/Revision/SourceLink作成と
 * 同一transaction内でのcommitが可能(PATTERN-DETECT-02A §3.2 手順7
 * 「同一transactionで作成する」)。
 */
export async function storeCasePatternEmbedding(
  txOrDb: PatternDbClient,
  params: { workspaceId: string; revisionId: string; vectorLiteral: string; model: string; dimensions: number },
): Promise<void> {
  await txOrDb.$executeRaw`
    INSERT INTO case_pattern_embeddings (id, workspace_id, revision_id, model, dimensions, source_version, embedding, updated_at)
    VALUES (gen_random_uuid()::text, ${params.workspaceId}, ${params.revisionId}, ${params.model}, ${params.dimensions}, ${CASE_PATTERN_EMBEDDING_SOURCE_VERSION}, ${params.vectorLiteral}::vector, now())
    ON CONFLICT (workspace_id, revision_id, model)
    DO UPDATE SET dimensions = ${params.dimensions}, source_version = ${CASE_PATTERN_EMBEDDING_SOURCE_VERSION}, embedding = ${params.vectorLiteral}::vector, updated_at = now()
  `;
  debugServer.event("patterns/casePatternMatching", "CASE_PATTERN_EMBEDDING_STORED", {
    revisionId: params.revisionId,
    model: params.model,
    dimensions: params.dimensions,
  });
}

/**
 * 1つのCasePatternRevisionのEmbeddingを生成し、case_pattern_embeddingsへ
 * upsertする(revisionId, model単位で1件、CHG-045「1 current/model」)。
 * embedCasePatternCandidate + storeCasePatternEmbeddingの組合せ版(既存
 * revisionへの後付けEmbedding付与など、matching結果を再利用しない単独呼出し
 * 向けに残す)。
 */
export async function embedAndStoreCasePatternRevision(
  params: {
    workspaceId: string;
    revisionId: string;
    representativeText: string;
    decompositionTemplate: unknown;
  },
  overrides: CasePatternEmbeddingOverrides = {},
): Promise<EmbedCasePatternRevisionResult> {
  const outcome = await embedCasePatternCandidate(
    params.workspaceId,
    { representativeText: params.representativeText, decompositionTemplate: params.decompositionTemplate },
    overrides,
  );
  if (!outcome.ok) {
    debugServer.error("patterns/casePatternMatching", "Case Pattern Embedding生成失敗", {
      revisionId: params.revisionId,
      errorKind: outcome.errorKind,
      reason: outcome.reason,
    });
    return { ok: false, errorKind: outcome.errorKind, reason: outcome.reason };
  }
  await storeCasePatternEmbedding(db, {
    workspaceId: params.workspaceId,
    revisionId: params.revisionId,
    vectorLiteral: outcome.vectorLiteral,
    model: outcome.model,
    dimensions: outcome.dimensions,
  });
  return { ok: true, model: outcome.model, dimensions: outcome.dimensions };
}

interface SimilarityRow {
  pattern_id: string;
  revision_id: string;
  similarity: number;
}

/**
 * 計算済みEmbeddingベクトルを、この本人(ownerSubjectUserId)の既存CasePattern
 * (current revisionのみ)と比較し、3値判定する(case-pattern-match-v1、
 * DOC-06 §5 DR-B)。model・dimensions・source_versionが完全一致するEmbedding
 * 同士のみ比較(PD-11)。exact cosine総当たり(ANN index禁止、v1判定契約)。
 * 分類(閾値・曖昧性)判定そのものはcasePatternMatchPolicy.tsへ委譲する。
 */
export async function classifyCasePatternVector(
  params: { workspaceId: string; ownerSubjectUserId: string; vectorLiteral: string; model: string; dimensions: number },
): Promise<CasePatternMatchResult> {
  const rows = await db.$queryRaw<SimilarityRow[]>`
    SELECT
      cp.id AS pattern_id,
      cpr.id AS revision_id,
      1 - (cpe.embedding <=> ${params.vectorLiteral}::vector) AS similarity
    FROM case_pattern_embeddings cpe
    JOIN case_pattern_revisions cpr ON cpr.id = cpe.revision_id
    JOIN case_patterns cp ON cp.id = cpr.pattern_id AND cp.current_revision = cpr.revision
    WHERE cpe.workspace_id = ${params.workspaceId}
      AND cp.owner_subject_user_id = ${params.ownerSubjectUserId}
      AND cpe.model = ${params.model}
      AND cpe.dimensions = ${params.dimensions}
      AND cpe.source_version = ${CASE_PATTERN_EMBEDDING_SOURCE_VERSION}
    ORDER BY cpe.embedding <=> ${params.vectorLiteral}::vector
    LIMIT 2
  `;

  const candidates: CasePatternMatchCandidate[] = rows.map((r: SimilarityRow) => ({
    patternId: r.pattern_id,
    revisionId: r.revision_id,
    similarity: Number(r.similarity),
  }));
  return classifyCasePatternMatchCandidates(candidates);
}

/**
 * 候補テキストが、この本人(ownerSubjectUserId)の既存CasePattern(current
 * revisionのみ)のいずれかと同一Patternとみなせるかを判定する
 * (case-pattern-match-v1、DOC-06 §5 DR-B)。embedCasePatternCandidate +
 * classifyCasePatternVectorの組合せ版(単発の判定のみが必要な呼び出し元
 * ・既存test向けに残す。NEW_PATTERN_CREATED時にベクトルを再利用したい
 * casePatternDetectionService.tsは、この2関数を個別に呼ぶ)。
 *
 * [PATTERN-DETECT-02A是正・P1-2] 従来はcandidateTextを呼び出し元が任意に
 * 組み立てて渡していたため、Pattern保存側(representativeText +
 * decompositionTemplateをbuildCasePatternEmbeddingText()経由)と正規化規則が
 * 非対称だった。候補側もCasePatternDetectionCandidateInput
 * (representativeText + decompositionTemplate)を受け取り、同じ
 * buildCasePatternEmbeddingText()を経由させることで対称性を保証する。
 */
export async function matchCasePattern(
  params: {
    workspaceId: string;
    ownerSubjectUserId: string;
    candidate: CasePatternDetectionCandidateInput;
  },
  overrides: CasePatternEmbeddingOverrides = {},
): Promise<CasePatternMatchResult> {
  const outcome = await embedCasePatternCandidate(params.workspaceId, params.candidate, overrides);
  if (!outcome.ok) {
    debugServer.error("patterns/casePatternMatching", "Case Pattern照合用Embedding生成失敗", {
      errorKind: outcome.errorKind,
      reason: outcome.reason,
    });
    return { kind: "EMBEDDING_FAILED", errorKind: outcome.errorKind, reason: outcome.reason };
  }
  return classifyCasePatternVector({
    workspaceId: params.workspaceId,
    ownerSubjectUserId: params.ownerSubjectUserId,
    vectorLiteral: outcome.vectorLiteral,
    model: outcome.model,
    dimensions: outcome.dimensions,
  });
}
