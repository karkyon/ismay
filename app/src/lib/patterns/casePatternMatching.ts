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
 * [scope宣言・想像で先行実装しない] このファイルはEmbeddingの生成・保存・
 * 「既存Patternに一致するか」の判定(3値: MATCHED/AMBIGUOUS/NO_MATCH)までを
 * 提供する。「NO_MATCHの場合に新規CANDIDATE Patternを実際に作る」トリガー
 * 配線や、Detector本体(caseDetectQueueJob.tsのno-opプレースホルダの置き換え)
 * は、いつ・どの入力に対してこの判定を呼ぶかという別の設計判断
 * (PATTERN-DETECT-01E「Suggestion接続準備」寄りの話)を要するため、本Gateの
 * scope外とし、判定結果を返す純粋なAPIとしてのみ実装する。
 *
 * [依存性注入・テスト方針] 指示書「APIキーが無い環境では実provider呼出しを
 * 行わず、deterministic fake embeddingでqueue、冪等性、cosine、境界、曖昧性を
 * 検証する」に従い、`getProvider`をoverride可能にする
 * (lib/formation/materialize.tsのembedAndStoreResponsibility overrideと同じ
 * 依存性注入パターン)。本番既定値はgetActiveEmbeddingProvider。
 */
import { db } from "@/lib/db";
import { debugServer } from "@/lib/debugServer";
import { getActiveEmbeddingProvider } from "@/lib/ai/config";
import type { AiEmbeddingProvider } from "@/lib/ai/embeddingProvider";
import { buildCasePatternEmbeddingText } from "./casePatternEmbeddingText";
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

/**
 * 1つのCasePatternRevisionのEmbeddingを生成し、case_pattern_embeddingsへ
 * upsertする(revisionId, model単位で1件、CHG-045「1 current/model」)。
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
  const getProvider = overrides.getProvider ?? getActiveEmbeddingProvider;
  const provider = await getProvider(params.workspaceId);
  const text = buildCasePatternEmbeddingText({
    representativeText: params.representativeText,
    decompositionTemplate: params.decompositionTemplate,
  });
  const outcome = await provider.embed({ text });

  if (!outcome.ok) {
    debugServer.error("patterns/casePatternMatching", "Case Pattern Embedding生成失敗", {
      revisionId: params.revisionId,
      kind: outcome.kind,
      message: outcome.message,
    });
    return { ok: false, errorKind: outcome.kind, reason: outcome.message };
  }

  const vectorLiteral = toVectorLiteral(outcome.vector);

  await db.$executeRaw`
    INSERT INTO case_pattern_embeddings (id, workspace_id, revision_id, model, dimensions, source_version, embedding, updated_at)
    VALUES (gen_random_uuid()::text, ${params.workspaceId}, ${params.revisionId}, ${provider.modelName}, ${outcome.dimensions}, ${CASE_PATTERN_EMBEDDING_SOURCE_VERSION}, ${vectorLiteral}::vector, now())
    ON CONFLICT (workspace_id, revision_id, model)
    DO UPDATE SET dimensions = ${outcome.dimensions}, source_version = ${CASE_PATTERN_EMBEDDING_SOURCE_VERSION}, embedding = ${vectorLiteral}::vector, updated_at = now()
  `;

  debugServer.event("patterns/casePatternMatching", "CASE_PATTERN_EMBEDDING_STORED", {
    revisionId: params.revisionId,
    model: provider.modelName,
    dimensions: outcome.dimensions,
  });
  return { ok: true, model: provider.modelName, dimensions: outcome.dimensions };
}

interface SimilarityRow {
  pattern_id: string;
  revision_id: string;
  similarity: number;
}

/**
 * 候補テキストが、この本人(ownerSubjectUserId)の既存CasePattern(current
 * revisionのみ)のいずれかと同一Patternとみなせるかを判定する
 * (case-pattern-match-v1、DOC-06 §5 DR-B)。
 *
 * - 同一workspace・同一owner・current revisionのみを対象(v1判定契約)。
 * - model・dimensions・source_versionが完全一致するEmbedding同士のみ比較
 *   (PD-11「異model/dimensions/sourceVersionを混合比較0」)。
 * - exact cosine類似度の総当たり(ANN index禁止、v1判定契約「exact search」)。
 * - 分類(閾値・曖昧性)判定そのものはcasePatternMatchPolicy.tsへ委譲する。
 */
export async function matchCasePattern(
  params: {
    workspaceId: string;
    ownerSubjectUserId: string;
    candidateText: string;
  },
  overrides: CasePatternEmbeddingOverrides = {},
): Promise<CasePatternMatchResult> {
  const getProvider = overrides.getProvider ?? getActiveEmbeddingProvider;
  const provider = await getProvider(params.workspaceId);
  const outcome = await provider.embed({ text: params.candidateText });

  if (!outcome.ok) {
    debugServer.error("patterns/casePatternMatching", "Case Pattern照合用Embedding生成失敗", {
      kind: outcome.kind,
      message: outcome.message,
    });
    return { kind: "EMBEDDING_FAILED", errorKind: outcome.kind, reason: outcome.message };
  }

  const vectorLiteral = toVectorLiteral(outcome.vector);

  const rows = await db.$queryRaw<SimilarityRow[]>`
    SELECT
      cp.id AS pattern_id,
      cpr.id AS revision_id,
      1 - (cpe.embedding <=> ${vectorLiteral}::vector) AS similarity
    FROM case_pattern_embeddings cpe
    JOIN case_pattern_revisions cpr ON cpr.id = cpe.revision_id
    JOIN case_patterns cp ON cp.id = cpr.pattern_id AND cp.current_revision = cpr.revision
    WHERE cpe.workspace_id = ${params.workspaceId}
      AND cp.owner_subject_user_id = ${params.ownerSubjectUserId}
      AND cpe.model = ${provider.modelName}
      AND cpe.dimensions = ${outcome.dimensions}
      AND cpe.source_version = ${CASE_PATTERN_EMBEDDING_SOURCE_VERSION}
    ORDER BY cpe.embedding <=> ${vectorLiteral}::vector
    LIMIT 2
  `;

  const candidates: CasePatternMatchCandidate[] = rows.map((r: SimilarityRow) => ({
    patternId: r.pattern_id,
    revisionId: r.revision_id,
    similarity: Number(r.similarity),
  }));
  return classifyCasePatternMatchCandidates(candidates);
}
