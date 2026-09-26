/**
 * scripts/lib/httpVerifyUserCleanup.ts
 *
 * [AUDIT-BASELINE-01・2026-09-26新設] HTTP受入script(register→login→Capture→AI解析)が作った
 * テストユーザー1人分のデータを、アカウントPurge本体(`executePurgeForUser`、FKグラフを実行時に
 * 発見して削除順序を決める・Gate PURGE hardening 02/03A/03Bで実DB受入済み)で物理削除する。
 *
 * 背景: M1B1/M1B2の旧cleanupは表を手書きで列挙し、例外を`.catch(() => null)`で握り潰していた。
 * FormationAtomicityAssessment・FormationShadowCheckpoint・Case Pattern Suggest Job等、後続Gateで
 * 追加された表が漏れ、実DBでFK違反によりテストデータが残存した(2026-09-26 omega-dev2)。
 * 表を列挙する方式は表の追加に追随できないため、Purge本体に委ねる。
 *
 * 安全策:
 *   - テスト用アドレス(`emailPrefix`で始まり`@example.invalid`で終わる)以外は拒否する。
 *   - Purgeが共有workspace等で拒否した場合は削除を強行せず、エラーとして返す。
 *   - 旧cleanupの途中失敗でmembershipだけ消えた孤立ユーザーは、そのユーザー自身が作成した
 *     Captureのworkspaceについてmembershipを復元してからPurgeする(他人のworkspaceには触れない)。
 *   - Purge後、そのユーザーを対象とするaudit_logs(テスト由来)を削除する。
 */

type Db = typeof import("../../app/src/lib/db")["db"];

const DAY_MS = 24 * 60 * 60 * 1000;

export async function purgeHttpVerifyUser(db: Db, userId: string, emailPrefix: string): Promise<string[]> {
  const errors: string[] = [];
  const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, email: true } });
  if (!user) {
    await db.auditLog.deleteMany({ where: { targetType: "User", targetId: userId } });
    return errors;
  }
  if (!user.email.startsWith(emailPrefix) || !user.email.endsWith("@example.invalid")) {
    return [`${userId}: テスト用アドレス以外のユーザーは削除しません(${user.email})`];
  }

  const activeMemberships = await db.workspaceMember.count({ where: { userId, leftAt: null } });
  if (activeMemberships === 0) {
    const ownedWorkspaces = await db.capture.findMany({
      where: { createdById: userId },
      select: { workspaceId: true },
      distinct: ["workspaceId"],
    });
    for (const { workspaceId } of ownedWorkspaces) {
      const otherMembers = await db.workspaceMember.count({ where: { workspaceId, userId: { not: userId }, leftAt: null } });
      if (otherMembers > 0) {
        errors.push(`${userId}: workspace ${workspaceId} に他のmemberがいるためmembershipを復元しません`);
        continue;
      }
      await db.workspaceMember.create({ data: { workspaceId, userId, role: "OWNER" } });
    }
  }

  await db.user.update({ where: { id: userId }, data: { deletedAt: new Date(Date.now() - 60 * DAY_MS) } });
  const { executePurgeForUser } = await import("../../app/src/lib/admin/purgeJob");
  const result = await executePurgeForUser({ userId });
  if (result.status !== "PURGED") {
    errors.push(`${userId}: Purgeが拒否されました(${result.status}${"detail" in result && result.detail ? `: ${result.detail}` : ""})`);
  }
  await db.auditLog.deleteMany({ where: { targetType: "User", targetId: userId } });
  if (await db.user.findUnique({ where: { id: userId }, select: { id: true } })) {
    errors.push(`${userId}: userが残存しています`);
  }
  return errors;
}
