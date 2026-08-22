import type { NextRequest } from "next/server";
import { debugServer } from "@/lib/debugServer";
import { requireAuth } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { db } from "@/lib/db";
import { apiOk, apiError } from "@/lib/auth/response";
import {
  buildUserExportBundle,
  responsibilitiesToCsvRows,
  capturesToCsvRows,
  toCsv,
} from "@/lib/dataExport";

/**
 * API-PRV-01: GET /exports(2026-08-23新設)。UI-14「データ管理」の主機能。
 * FR-PRV-01「原文、責任グラフ、AI推定、PEM、履歴を閲覧できる」
 * FR-PRV-02「データを...エクスポートできる」「機械可読形式と人間可読形式を提供する」
 *
 * 同期処理で即座に生成する(個人利用規模のデータ量を前提。Job Queue化・非同期通知は
 * 将来データ量が増えた場合の拡張ポイントとして残す)。複数ファイルを1レスポンス内に
 * 文字列同梱する設計についてはlib/dataExport.tsのコメントを参照。
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }

  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);
  const workspace = await db.workspace.findUnique({ where: { id: workspaceId }, select: { name: true } });

  const bundle = await buildUserExportBundle({
    workspaceId,
    workspaceName: workspace?.name ?? "",
    userId: auth.user.userId,
  });

  const manifest = {
    generatedAt: bundle.generatedAt,
    workspace: bundle.workspace,
    files: ["data.json", "responsibilities.csv", "captures.csv", "manifest.json"],
    counts: {
      responsibilities: bundle.responsibilities.length,
      captures: bundle.captures.length,
      aiInferences: bundle.aiInferences.length,
      pemObservations: bundle.pemObservations.length,
      pemHypotheses: bundle.pemHypotheses.length,
      eventLogs: bundle.eventLogs.length,
    },
  };

  await db.auditLog.create({
    data: {
      actorUserId: auth.user.userId,
      actorType: "USER",
      action: "DATA_EXPORT_REQUESTED",
      targetType: "Workspace",
      targetId: workspaceId,
      result: "SUCCESS",
    },
  });
  debugServer.event("GET /exports", "エクスポート生成完了", { workspaceId, counts: manifest.counts });

  return apiOk({
    files: {
      "data.json": JSON.stringify(bundle, null, 2),
      "responsibilities.csv": toCsv(responsibilitiesToCsvRows(bundle)),
      "captures.csv": toCsv(capturesToCsvRows(bundle)),
      "manifest.json": JSON.stringify(manifest, null, 2),
    },
  });
}
