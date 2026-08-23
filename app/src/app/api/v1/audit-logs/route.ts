import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth/guard";
import { apiOk, apiError } from "@/lib/auth/response";

const LIST_LIMIT_DEFAULT = 50;
const LIST_LIMIT_MAX = 200;

/**
 * API-ADM-01(推論): GET /audit-logs(2026-08-23新設)。UI-15「管理コンソール」の一部。
 * 出典: Webシステム要件定義書v2.1 FR-ADM-04「監査ログを検索・出力できる。実行者、対象、
 * 操作、日時、結果、理由で検索できる」。
 *
 * [設計判断・2026-08-23] 要件定義書はロール「Security Auditor」による閲覧を想定しているが、
 * ISMAYは個人利用(1ユーザー1Workspace)を前提としており、ロール・権限管理システム自体が
 * 未実装(想像で新しいロール体系を作り込まない)。そのため本APIは「本人が自分の
 * ワークスペースに関する監査ログを閲覧する」という単純な設計とし、requireAuthのみで
 * 認可する(既存の他APIと同じ規約)。複数ユーザー・ロール分離が必要になった場合は
 * 別途権限チェックを追加する拡張ポイントとして残す。
 *
 * AuditLogモデル自体に本文フィールドが無く、action/reason/targetType/targetIdなど
 * メタデータのみを記録する設計になっているため、「本文はマスキングを原則とする」
 * (7章)という要件は、そもそも本文を記録しないことで既に満たされている。
 *
 * 「出力できる」(エクスポート)は、既存のFN-PRV-01(GET /exports)とは別に監査ログ専用の
 * エクスポート機能を新設するとスコープが重複するため、今回は一覧表示までとする。
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }

  const url = new URL(req.url);
  const actorUserId = url.searchParams.get("actorUserId") ?? undefined;
  const targetType = url.searchParams.get("targetType") ?? undefined;
  const action = url.searchParams.get("action") ?? undefined;
  const result = url.searchParams.get("result") ?? undefined;
  const from = url.searchParams.get("from") ?? undefined;
  const to = url.searchParams.get("to") ?? undefined;
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const limitParam = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, LIST_LIMIT_MAX) : LIST_LIMIT_DEFAULT;

  const dateFilter: { gte?: Date; lte?: Date } = {};
  if (from) dateFilter.gte = new Date(from);
  if (to) dateFilter.lte = new Date(to);
  const hasDateFilter = from !== undefined || to !== undefined;

  // [設計判断] 個人利用規模を前提に、本人が関わる監査ログ(actorUserIdが本人)を既定の
  // スコープとする。actorUserIdクエリで絞り込む場合も、本人以外を指定されたら無視する
  // (IDOR対策。将来複数ユーザー対応する場合はここに権限チェックを追加する)。
  const effectiveActorUserId = actorUserId === auth.user.userId ? actorUserId : auth.user.userId;

  const logs = await db.auditLog.findMany({
    where: {
      actorUserId: effectiveActorUserId,
      ...(targetType ? { targetType } : {}),
      ...(action ? { action } : {}),
      ...(result ? { result } : {}),
      ...(hasDateFilter ? { occurredAt: dateFilter } : {}),
    },
    orderBy: { occurredAt: "desc" },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: {
      id: true,
      actorUserId: true,
      actorType: true,
      action: true,
      targetType: true,
      targetId: true,
      result: true,
      reason: true,
      ipAddress: true,
      occurredAt: true,
    },
  });

  type LogRow = (typeof logs)[number];
  const hasMore = logs.length > limit;
  const page = (logs as LogRow[]).slice(0, limit);
  const nextCursor = hasMore ? page[page.length - 1].id : undefined;

  return apiOk({ auditLogs: page }, { extraMeta: nextCursor ? { nextCursor } : {} });
}
