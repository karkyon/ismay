import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { debugServer } from "@/lib/debugServer";
import { requireAuth } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";
import { findSimilarResponsibilitiesForText } from "@/lib/ai/relatedResponsibilities";

/**
 * API-SRCH-01: GET /search(2026-08-22新設)。UI-11「横断検索」。
 * 出典: Webシステム要件定義書v2.1 FR-SRCH-01/02、システム基本設計書v1.2 10章。
 *
 * FR-SRCH-01「キーワードと意味の双方で検索できる」を満たすため、mode=keyword(既定)/
 * semantic/bothを受け付ける。keywordはPostgreSQLの大小無視ILIKE部分一致
 * (ILIKE '%word%'相当、Prismaの`contains`+`mode: "insensitive"`)を使う。
 * [設計判断・2026-08-22] 設計書は「PostgreSQL全文検索」を挙げているが、日本語には
 * 分かち書きが無いためtsvector/to_tsvectorの標準言語設定(englishやsimple)は
 * 単語境界を正しく扱えず、かえって検索漏れを生む。個人利用規模(NFR的にも大量データを
 * 想定していない)であればILIKE部分一致で十分実用的なため、まずはこちらを採用する。
 * 将来pg_bigm等の日本語対応拡張を追加した場合はこの関数の内部実装のみ差し替えれば良い。
 *
 * semanticはFN-GR-01で既に実装済みのfindSimilarResponsibilitiesForText()を再利用する
 * (意味照合と横断検索は同じ「テキスト→Embedding→pgvector類似検索」の仕組みで良い)。
 *
 * FR-SRCH-01「原文と責任を区別する」に対応し、Capture(原文)とResponsibility(責任)を
 * 別々の配列で返す。
 *
 * FR-SRCH-02の絞り込みのうち、type/status/domainId/from/to/counterpartyを実装する
 * (「保存ビュー化」は本パッチのスコープ外、次段階とする)。
 *
 * 「検索候補取得後に必ずDB認可フィルターを再適用」(10章)に対応し、semanticモードでも
 * workspaceIdスコープを必ず通す(findSimilarResponsibilitiesForText自体が既にworkspaceId
 * フィルタを内包している)。
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const mode = url.searchParams.get("mode") ?? "keyword"; // keyword | semantic | both
  const type = url.searchParams.get("type") ?? undefined;
  const status = url.searchParams.get("status") ?? undefined;
  const domainId = url.searchParams.get("domainId") ?? undefined;
  const from = url.searchParams.get("from") ?? undefined;
  const to = url.searchParams.get("to") ?? undefined;
  const counterparty = url.searchParams.get("counterparty") ?? undefined;

  if (!q) {
    return apiOk({ responsibilities: [], captures: [], semantic: [] });
  }

  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const wantKeyword = mode === "keyword" || mode === "both";
  const wantSemantic = mode === "semantic" || mode === "both";

  let responsibilities: unknown[] = [];
  let captures: unknown[] = [];
  if (wantKeyword) {
    const dateFilter: { gte?: Date; lte?: Date } = {};
    if (from) dateFilter.gte = new Date(from);
    if (to) dateFilter.lte = new Date(to);
    const hasDateFilter = from !== undefined || to !== undefined;

    responsibilities = await db.responsibility.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        ...(type ? { type } : {}),
        ...(status ? { status } : {}),
        ...(domainId ? { domainId } : {}),
        ...(hasDateFilter ? { hardDeadlineAt: dateFilter } : {}),
        AND: [
          {
            OR: [
              { title: { contains: q, mode: "insensitive" } },
              { description: { contains: q, mode: "insensitive" } },
            ],
          },
          ...(counterparty
            ? [
                {
                  OR: [
                    { commitmentDetail: { counterpartyName: { contains: counterparty, mode: "insensitive" as const } } },
                    { waitingDetail: { waitingOn: { contains: counterparty, mode: "insensitive" as const } } },
                  ],
                },
              ]
            : []),
        ],
      },
      select: {
        id: true,
        type: true,
        title: true,
        status: true,
        importance: true,
        hardDeadlineAt: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: "desc" },
      take: 50,
    });

    captures = await db.capture.findMany({
      where: {
        workspaceId,
        ...(domainId ? { domainId } : {}),
        OR: [
          { rawText: { contains: q, mode: "insensitive" } },
          { aiSummary: { contains: q, mode: "insensitive" } },
        ],
      },
      select: {
        id: true,
        sourceType: true,
        rawText: true,
        aiSummary: true,
        processingStatus: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: 30,
    });
  }

  let semantic: unknown[] = [];
  if (wantSemantic) {
    semantic = await findSimilarResponsibilitiesForText({ text: q, workspaceId });
  }

  debugServer.event("GET /search", "検索実行", {
    q,
    mode,
    resultCounts: { responsibilities: responsibilities.length, captures: captures.length, semantic: semantic.length },
  });

  return apiOk({ responsibilities, captures, semantic });
}
