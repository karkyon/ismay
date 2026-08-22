import { db } from "@/lib/db";

/**
 * FN-PRV-01 データ主権(2026-08-23新設)。
 * 出典: Webシステム要件定義書v2.1 FR-PRV-01/02、DB設計書v1.1 8章、UI-14。
 *
 * 「原文、責任グラフ、AI推定、PEM、履歴を閲覧できる」「機械可読形式と人間可読形式を
 * 提供する」の2要件を満たすため、JSON(機械可読・完全)とCSV(人間可読・主要項目)の
 * 両方を生成する。
 *
 * [設計判断・2026-08-23] DB設計書は「JSON＋CSV＋添付マニフェスト」をZIPでの提供を
 * 想定しているように読めるが、ZIP生成には新規npm依存(archiver等)が必要になる。
 * 個人利用規模でファイル数も少ないため、ZIP化はせず複数ファイルを1回のAPIレスポンス内に
 * 文字列として同梱し、クライアント側で個別にBlobダウンロードさせる方式を採る
 * (依存追加を避けつつ「複数ファイル形式での提供」という要件は満たせる)。
 *
 * [スコープ外・2026-08-23] DB設計書8章の「30日後にPurge Job」(完全物理削除)は
 * 別途スケジュールジョブが必要な大きめの機能のため、本パッチでは対象外とする。
 * 本パッチが実装するのは、エクスポートと、削除要求時点でのsoft-delete
 * (deletedAt設定)までである。
 */

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = typeof value === "string" ? value : JSON.stringify(value);
  if (/[",\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(","));
  }
  return lines.join("\n");
}

export interface UserExportBundle {
  generatedAt: string;
  workspace: { id: string; name: string };
  responsibilities: Record<string, unknown>[];
  captures: Record<string, unknown>[];
  aiInferences: Record<string, unknown>[];
  pemObservations: Record<string, unknown>[];
  pemHypotheses: Record<string, unknown>[];
  eventLogs: Record<string, unknown>[];
}

/**
 * 指定Workspace(および紐づくUser)の全データを機械可読な構造で組み立てる。
 * AI推定と本人確定を識別可能にする(DB設計書8章)ため、Responsibility.sourceKind
 * (USER/AI/IMPORT/SYSTEM)、AiInference.decision(PENDING/ACCEPTED/EDITED/...)を
 * そのまま含める。
 */
export async function buildUserExportBundle(params: {
  workspaceId: string;
  workspaceName: string;
  userId: string;
}): Promise<UserExportBundle> {
  const { workspaceId, workspaceName, userId } = params;

  const responsibilities = await db.responsibility.findMany({
    where: { workspaceId },
    include: {
      taskDetail: true,
      commitmentDetail: true,
      decisionDetail: true,
      waitingDetail: true,
      constraints: true,
      recurrenceRule: true,
    },
    orderBy: { createdAt: "asc" },
  });

  const captures = await db.capture.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "asc" },
  });

  const captureIds = captures.map((c: { id: string }) => c.id);
  const aiInferences = captureIds.length
    ? await db.aiInference.findMany({
        where: { captureId: { in: captureIds } },
        orderBy: { createdAt: "asc" },
      })
    : [];

  const pemObservations = await db.pemObservation.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
  });
  const pemHypotheses = await db.pemHypothesis.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
  });

  const responsibilityIds = (responsibilities as { id: string }[]).map((r) => r.id);
  const eventLogs = responsibilityIds.length
    ? await db.eventLog.findMany({
        where: { aggregateType: "Responsibility", aggregateId: { in: responsibilityIds } },
        orderBy: { occurredAt: "asc" },
      })
    : [];

  return {
    generatedAt: new Date().toISOString(),
    workspace: { id: workspaceId, name: workspaceName },
    responsibilities: responsibilities as unknown as Record<string, unknown>[],
    captures: captures as unknown as Record<string, unknown>[],
    aiInferences: aiInferences as unknown as Record<string, unknown>[],
    pemObservations: pemObservations as unknown as Record<string, unknown>[],
    pemHypotheses: pemHypotheses as unknown as Record<string, unknown>[],
    eventLogs: eventLogs as unknown as Record<string, unknown>[],
  };
}

/** responsibilities/capturesの主要項目のみを抜き出したCSV(人間可読)用の行を作る。 */
export function responsibilitiesToCsvRows(bundle: UserExportBundle): Record<string, unknown>[] {
  return bundle.responsibilities.map((r) => ({
    id: r.id,
    type: r.type,
    title: r.title,
    status: r.status,
    sourceKind: r.sourceKind,
    importance: r.importance,
    hardDeadlineAt: r.hardDeadlineAt,
    targetAt: r.targetAt,
    completedAt: r.completedAt,
    createdAt: r.createdAt,
    deletedAt: r.deletedAt,
  }));
}

export function capturesToCsvRows(bundle: UserExportBundle): Record<string, unknown>[] {
  return bundle.captures.map((c) => ({
    id: c.id,
    sourceType: c.sourceType,
    processingStatus: c.processingStatus,
    aiSummary: c.aiSummary,
    createdAt: c.createdAt,
    deletedAt: c.deletedAt,
  }));
}
