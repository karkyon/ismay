import { db } from "@/lib/db";
import { debugServer } from "@/lib/debugServer";
import { getActiveEmbeddingProvider } from "@/lib/ai/config";
import { buildEmbeddingText } from "@/lib/ai/embeddingText";

/**
 * FN-GR-01 意味照合(異なるCapture間の関連性検出)。
 * 出典: ISMAY_機能別詳細設計書v1.1 9章、DB設計書v1.1 7章。
 *
 * [今回の実装スコープ・設計判断(2026-08-20)]
 * 設計書のFN-GR-01は「全文Top20・Vector Top20・属性Top20」の3系統検索＋LLMによる
 * 関係種別(DUPLICATE/CONTINUES/REPLACES/CONTRADICTS/RELATED/NONE)の自動判定を
 * 想定しているが、これを一度に実装すると事故率が上がる(絶対ルール7章)ため、
 * 本パッチではVector検索のみを実装する。全文検索・属性検索、LLMによる関係種別の
 * 自動分類は次段階とする。関係の確定(ResponsibilityRelation作成)もユーザーの
 * 明示操作に委ね、自動では作らない(前回実装した同一Capture内BLOCKS関係とは異なり、
 * 異なるCapture間は誤判定の実害が大きいため)。
 *
 * pgvectorの`embedding <=> $1::vector`(コサイン距離)を使用。schema.prismaの
 * embedding列はUnsupported("vector(1536)")のためPrisma Clientの型付きAPIでは
 * 扱えず、$executeRaw/$queryRawを使う(意図的。Prisma側の既知の制約)。
 */

const SIMILARITY_THRESHOLD = 0.75;
const TOP_K = 5;

function toVectorLiteral(vector: number[]): string {
  // pgvectorのテキスト入力形式: '[0.1,0.2,...]'
  return `[${vector.join(",")}]`;
}

/**
 * Responsibility 1件の埋め込みを生成しresponsibility_embeddingsへ保存(upsert)する。
 * Embedding APIの失敗はResponsibility本体の作成を巻き戻すほどの重大度ではないため、
 * 呼び出し元はこの関数の例外を握りつぶしてよい(意味照合が使えないだけで、
 * 責任自体は正常に作成・利用できる)。
 */
export async function embedAndStoreResponsibility(params: {
  responsibilityId: string;
  workspaceId: string;
  domainId: string;
  title: string;
  description?: string | null;
  actor?: string | null;
  counterparty?: string | null;
}): Promise<{ ok: boolean; reason?: string }> {
  const provider = await getActiveEmbeddingProvider(params.workspaceId);
  const text = buildEmbeddingText(params);
  const outcome = await provider.embed({ text });

  if (!outcome.ok) {
    debugServer.error("ai/relatedResponsibilities", "Embedding生成失敗", {
      responsibilityId: params.responsibilityId,
      kind: outcome.kind,
      message: outcome.message,
    });
    return { ok: false, reason: outcome.message };
  }

  const modelVersion = `${provider.providerName}/${provider.modelName}`;
  const vectorLiteral = toVectorLiteral(outcome.vector);

  await db.$executeRaw`
    INSERT INTO responsibility_embeddings (responsibility_id, workspace_id, domain_id, model_version, embedding, created_at, updated_at)
    VALUES (${params.responsibilityId}, ${params.workspaceId}, ${params.domainId}, ${modelVersion}, ${vectorLiteral}::vector, now(), now())
    ON CONFLICT (responsibility_id)
    DO UPDATE SET embedding = ${vectorLiteral}::vector, model_version = ${modelVersion}, updated_at = now()
  `;

  debugServer.event("ai/relatedResponsibilities", "EMBEDDING_STORED", {
    responsibilityId: params.responsibilityId,
    modelVersion,
    dimensions: outcome.dimensions,
  });
  return { ok: true };
}

export interface RelatedResponsibility {
  responsibilityId: string;
  title: string;
  type: string;
  status: string;
  similarity: number;
}

interface SimilarityRow {
  responsibility_id: string;
  similarity: number;
}

/**
 * 指定Responsibilityに意味的に近い、同一Workspace内の他Responsibility(削除済み除く)を
 * 上位TOP_K件返す。しきい値未満は除外する(全件Top-Kで返すと無関係なものまで
 * 「関連候補」として提示してしまい、かえってノイズになるため)。
 */
export async function findRelatedResponsibilities(params: {
  responsibilityId: string;
  workspaceId: string;
}): Promise<RelatedResponsibility[]> {
  const self = await db.$queryRaw<{ embedding_exists: boolean }[]>`
    SELECT EXISTS(SELECT 1 FROM responsibility_embeddings WHERE responsibility_id = ${params.responsibilityId}) AS embedding_exists
  `;
  if (!self[0]?.embedding_exists) {
    return [];
  }

  const rows = await db.$queryRaw<SimilarityRow[]>`
    SELECT
      e.responsibility_id,
      1 - (e.embedding <=> self_e.embedding) AS similarity
    FROM responsibility_embeddings e
    JOIN responsibility_embeddings self_e ON self_e.responsibility_id = ${params.responsibilityId}
    JOIN responsibilities r ON r.id = e.responsibility_id
    WHERE e.workspace_id = ${params.workspaceId}
      AND e.responsibility_id != ${params.responsibilityId}
      AND r.deleted_at IS NULL
    ORDER BY e.embedding <=> self_e.embedding
    LIMIT ${TOP_K}
  `;

  const candidateIds = rows.map((r: SimilarityRow) => r.responsibility_id);
  if (candidateIds.length === 0) return [];

  const responsibilities = await db.responsibility.findMany({
    where: { id: { in: candidateIds } },
    select: { id: true, title: true, type: true, status: true },
  });
  type RespRow = { id: string; title: string; type: string; status: string };
  const byId = new Map((responsibilities as RespRow[]).map((r) => [r.id, r]));

  return (rows as SimilarityRow[])
    .filter((r) => Number(r.similarity) >= SIMILARITY_THRESHOLD && byId.has(r.responsibility_id))
    .map((r) => {
      const resp = byId.get(r.responsibility_id) as RespRow;
      return {
        responsibilityId: resp.id,
        title: resp.title,
        type: resp.type,
        status: resp.status,
        similarity: Number(r.similarity),
      };
    });
}
