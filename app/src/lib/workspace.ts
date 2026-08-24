import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";

export interface DefaultWorkspaceContext {
  workspaceId: string;
  domainId: string;
}

/**
 * ユーザーの所属Workspaceを取得する。存在しない場合は個人用Workspace＋
 * 既定Domain(kind=PERSONAL)を新設して返す。
 *
 * MVP(M0〜M4)では「1ユーザー＝1個人用Workspace」を前提とする(将来の共有Workspace対応はスコープ外)。
 * DB設計書v1.1 1章「Domainは表示分類ではなくプライバシー・連携・AI参照境界として使う」に基づき、
 * 初回アクセス時に既定Domain(kind=PERSONAL)も同時に作成する。
 *
 * [既知の制約] 同一ユーザーからの初回同時リクエストが競合した場合、
 * ごく稀にWorkspaceが重複作成される可能性がある(MVPでは許容。
 * 恒久対策はWorkspaceMemberへのユーザー単位一意制約導入を別途検討)。
 */
export async function ensureDefaultWorkspace(
  userId: string,
  displayNameHint?: string | null,
): Promise<DefaultWorkspaceContext> {
  const membership = await db.workspaceMember.findFirst({
    where: { userId, leftAt: null },
    orderBy: { joinedAt: "asc" },
    select: { workspaceId: true },
  });

  if (membership) {
    const domain = await db.domain.findFirst({
      where: { workspaceId: membership.workspaceId, deletedAt: null },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (domain) {
      return { workspaceId: membership.workspaceId, domainId: domain.id };
    }
    // Workspaceは存在するが既定Domainが無い異常系: ここで補完する
    const createdDomain = await db.domain.create({
      data: { workspaceId: membership.workspaceId, name: "個人", kind: "PERSONAL" },
      select: { id: true },
    });
    return { workspaceId: membership.workspaceId, domainId: createdDomain.id };
  }

  const workspaceName = displayNameHint ? `${displayNameHint}のワークスペース` : "個人ワークスペース";

  return db.$transaction(async (tx: Prisma.TransactionClient) => {
    const workspace = await tx.workspace.create({ data: { name: workspaceName } });
    await tx.workspaceMember.create({
      data: { workspaceId: workspace.id, userId, role: "OWNER" },
    });
    const domain = await tx.domain.create({
      data: { workspaceId: workspace.id, name: "個人", kind: "PERSONAL" },
    });
    return { workspaceId: workspace.id, domainId: domain.id };
  });
}
