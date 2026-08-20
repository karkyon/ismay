import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";
import { findLiteralDuplicateGroups } from "@/lib/ai/literalDuplicates";
import { findSimilarResponsibilitiesForText } from "@/lib/ai/relatedResponsibilities";
import { buildEmbeddingText } from "@/lib/ai/embeddingText";
import { ResponsibilityCandidateSchema } from "@/lib/ai/schema";

/**
 * UI-04向け候補取得(GET /captures/{id}/inferences)。
 *
 * [2026-08-20追加] カルキョンさんの指摘「そもそもタスクとして成立するのか
 * (＝重複していないか)が一切確認できていない」に対応。実際に同じメモを複数回
 * 保存したケースで、14件中7件が完全な重複として画面に出てしまっていた。
 * - リテラル重複: 同一Workspace内の他PENDING候補と正規化後タイトルが完全一致する場合、
 *   AI呼び出し無しで検出する(安価・即時)。
 * - 意味的重複: 既にResponsibility化済みのものとEmbeddingで比較する(Embedding
 *   プロバイダー未設定時は静かにスキップし、他機能を止めない)。
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }

  const { id } = await ctx.params;
  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const capture = await db.capture.findFirst({
    where: { id, workspaceId, deletedAt: null },
    select: { id: true },
  });
  if (!capture) {
    return apiError("RESOURCE_NOT_FOUND", "指定されたCaptureが見つかりません");
  }

  const inferences = await db.aiInference.findMany({
    where: { captureId: id },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      inferenceType: true,
      payload: true,
      evidenceSpans: true,
      confidence: true,
      decision: true,
      decidedAt: true,
      createdAt: true,
      version: true,
    },
  });

  type InferenceRow = (typeof inferences)[number];

  // リテラル重複チェックはWorkspace全体のPENDING候補を対象にする
  // (同じメモを別Captureとして複数回保存したケースを検出するため、この
  // Captureの候補だけを見ていては検出できない)。
  const allPendingInferences = await db.aiInference.findMany({
    where: { decision: "PENDING", capture: { workspaceId, deletedAt: null } },
    select: { id: true, payload: true },
  });

  type PayloadRow = { id: string; payload: unknown };
  const titledCandidates = (allPendingInferences as PayloadRow[])
    .map((r) => {
      const parsed = ResponsibilityCandidateSchema.safeParse(r.payload);
      return parsed.success ? { id: r.id, title: parsed.data.title } : null;
    })
    .filter((v): v is { id: string; title: string } => v !== null);
  const literalDuplicateGroups = findLiteralDuplicateGroups(titledCandidates);

  // 意味的重複チェック(Embedding)は、このCaptureのPENDING候補かつリテラル重複が
  // 見つからなかったものだけに限定する(APIコール数を抑えるため)。
  const enriched = await Promise.all(
    (inferences as InferenceRow[]).map(async (inf) => {
      const literalDuplicateOf = literalDuplicateGroups.get(inf.id) ?? [];
      if (inf.decision !== "PENDING" || literalDuplicateOf.length > 0) {
        return { ...inf, literalDuplicateOf, similarExisting: [] as unknown[] };
      }
      const candidateParsed = ResponsibilityCandidateSchema.safeParse(inf.payload);
      if (!candidateParsed.success) {
        return { ...inf, literalDuplicateOf, similarExisting: [] as unknown[] };
      }
      const text = buildEmbeddingText(candidateParsed.data);
      const similarExisting = await findSimilarResponsibilitiesForText({ text, workspaceId }).catch(() => []);
      return { ...inf, literalDuplicateOf, similarExisting };
    }),
  );

  return apiOk({ inferences: enriched });
}
