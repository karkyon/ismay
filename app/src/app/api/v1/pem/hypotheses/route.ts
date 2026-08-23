import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";
import { ensureHypothesesUpToDate } from "@/lib/pem";

/**
 * API-PEM-02: GET /pem/hypotheses 閲覧(FN-PEM-03/UI-09)。
 * 出典: API・イベント設計書v1.1 4.5節では`GET/PATCH /pem/hypotheses/{id}`のみを
 * 明記しているが、UI-09(あなたの実行モデル画面)は事実・観察・仮説をまとめて表示する
 * 一覧画面のため、一覧取得用にGET(id無し)をREST拡張として追加する
 * ([設計判断・2026-08-23]、[id]/route.tsは個別の閲覧・訂正を担当)。
 *
 * 呼び出し時、まず観察に対して未生成の仮説が無いかチェックし、あれば生成してから
 * 一覧を返す(ensureHypothesesUpToDate。母数・却下履歴の条件を満たす場合のみAI呼び出しが
 * 発生するため、通常は0件でコストがかからない)。
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }

  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  await ensureHypothesesUpToDate(auth.user.userId, workspaceId).catch(() => {
    // AI障害時もFACT/OBSERVATIONの閲覧自体は継続させる(fail-open。
    // AI・PEM設計書v1.0 15章「低確度、Provider障害...でもCapture・手動管理を継続」の精神)。
  });

  const [facts, observations, hypotheses] = await Promise.all([
    db.pemObservation.findMany({
      where: { userId: auth.user.userId, observationType: "FACT", deletedAt: null },
      orderBy: { occurredAt: "desc" },
      select: { id: true, payload: true, occurredAt: true },
    }),
    db.pemObservation.findMany({
      where: {
        userId: auth.user.userId,
        observationType: "OBSERVATION",
        deletedAt: null,
        OR: [{ validUntil: null }, { validUntil: { gt: new Date() } }],
      },
      orderBy: { occurredAt: "desc" },
      select: { id: true, payload: true, occurredAt: true },
    }),
    db.pemHypothesis.findMany({
      where: {
        userId: auth.user.userId,
        deletedAt: null,
        OR: [{ validUntil: null }, { validUntil: { gt: new Date() } }],
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        statement: true,
        sampleSize: true,
        windowFrom: true,
        windowTo: true,
        confidence: true,
        userVerdict: true,
        createdAt: true,
      },
    }),
  ]);

  return apiOk({
    facts: facts.map((f: (typeof facts)[number]) => ({ id: f.id, payload: f.payload, occurredAt: f.occurredAt.toISOString() })),
    observations: observations.map((o: (typeof observations)[number]) => ({
      id: o.id,
      payload: o.payload,
      occurredAt: o.occurredAt.toISOString(),
    })),
    hypotheses: hypotheses.map((h: (typeof hypotheses)[number]) => ({
      id: h.id,
      statement: h.statement,
      sampleSize: h.sampleSize,
      windowFrom: h.windowFrom.toISOString(),
      windowTo: h.windowTo.toISOString(),
      confidence: Number(h.confidence),
      userVerdict: h.userVerdict,
      createdAt: h.createdAt.toISOString(),
    })),
  });
}
