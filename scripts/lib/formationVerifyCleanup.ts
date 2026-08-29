/**
 * scripts/lib/formationVerifyCleanup.ts
 *
 * [B3.2是正・監査「Gate M1-B3.2」B32-02]
 *
 * B3(verify_gate_m1b3_materialize_acceptance.ts)とB3.1
 * (verify_gate_m1b31_materialization_invariants.ts)は、ほぼ同一のcleanupUser()を
 * それぞれ個別に持っており、その全DELETE呼び出しが`.catch(() => null)`または
 * `.catch(() => [])`で無条件に握りつぶされていた。実際に過去、
 * `responsibility_embeddings`テーブルへの誤ったUUIDキャストによるSQL例外
 * (42883)がこの握りつぶしで隠れた実績がある。
 *
 * このモジュールは同じ削除手順を1箇所にまとめ、例外を握りつぶさず収集する。
 * 「対象行が存在しない」(Prisma `deleteMany`のcount=0)は正常なので例外にはならず、
 * 実際に何か失敗した場合だけ`errors`配列に積まれる。呼び出し元は`errors.length>0`
 * なら最終結果をFAILにすること(このモジュール自身はexit codeを操作しない)。
 */

type Db = typeof import("../../app/src/lib/db")["db"];

export interface CleanupResult {
  userId: string;
  workspaceId: string | null;
  /** 個々のステップで発生した例外(存在しない場合の0件ヒットは含まない)。 */
  errors: { step: string; error: unknown }[];
}

async function step<T>(errors: { step: string; error: unknown }[], name: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    errors.push({ step: name, error });
    return fallback;
  }
}

/**
 * RUN_ID/テスト用user一人分に紐づくWorkspace/Domain/Capture/FormationSession/
 * 候補/Decision/Receipt/Responsibility/Embedding/EventLog/OutboxをFK順に削除する。
 * テスト用データ(このuserId配下のみ)以外は一切対象にしない。
 */
export async function cleanupFormationVerifyUser(db: Db, userId: string): Promise<CleanupResult> {
  const errors: { step: string; error: unknown }[] = [];

  const membership = await step(
    errors,
    "workspaceMember.findFirst",
    () => db.workspaceMember.findFirst({ where: { userId }, select: { workspaceId: true } }),
    null,
  );
  const workspaceId = membership?.workspaceId ?? null;

  if (workspaceId) {
    const captures = await step(
      errors,
      "capture.findMany",
      () => db.capture.findMany({ where: { workspaceId }, select: { id: true } }),
      [] as { id: string }[],
    );
    const captureIds = captures.map((c) => c.id);

    const sessions = captureIds.length
      ? await step(
          errors,
          "formationSession.findMany",
          () => db.formationSession.findMany({ where: { captureId: { in: captureIds } }, select: { id: true } }),
          [] as { id: string }[],
        )
      : [];
    const sessionIds = sessions.map((s) => s.id);

    if (sessionIds.length > 0) {
      const identities = await step(
        errors,
        "formationCandidateIdentity.findMany",
        () => db.formationCandidateIdentity.findMany({ where: { sessionId: { in: sessionIds } }, select: { id: true } }),
        [] as { id: string }[],
      );
      const identityIds = identities.map((c) => c.id);

      if (identityIds.length > 0) {
        const revisions = await step(
          errors,
          "formationCandidateRevision.findMany",
          () => db.formationCandidateRevision.findMany({ where: { candidateId: { in: identityIds } }, select: { id: true } }),
          [] as { id: string }[],
        );
        const revisionIds = revisions.map((r) => r.id);

        if (revisionIds.length > 0) {
          await step(errors, "formationSourceAnchor.deleteMany", () => db.formationSourceAnchor.deleteMany({ where: { revisionId: { in: revisionIds } } }), { count: 0 });
        }
        await step(errors, "materializationReceiptItem.deleteMany", () => db.materializationReceiptItem.deleteMany({ where: { candidateId: { in: identityIds } } }), { count: 0 });
        await step(errors, "formationCandidateDecisionEvent.deleteMany", () => db.formationCandidateDecisionEvent.deleteMany({ where: { candidateId: { in: identityIds } } }), { count: 0 });
        await step(errors, "formationCandidateRevision.deleteMany", () => db.formationCandidateRevision.deleteMany({ where: { candidateId: { in: identityIds } } }), { count: 0 });
      }
      await step(errors, "formationCandidateIdentity.deleteMany", () => db.formationCandidateIdentity.deleteMany({ where: { sessionId: { in: sessionIds } } }), { count: 0 });
      await step(errors, "materializationReceipt.deleteMany", () => db.materializationReceipt.deleteMany({ where: { sessionId: { in: sessionIds } } }), { count: 0 });
      await step(errors, "formationSessionEvent.deleteMany", () => db.formationSessionEvent.deleteMany({ where: { sessionId: { in: sessionIds } } }), { count: 0 });
      await step(errors, "formationSession.deleteMany", () => db.formationSession.deleteMany({ where: { id: { in: sessionIds } } }), { count: 0 });
    }

    const responsibilities = await step(
      errors,
      "responsibility.findMany",
      () => db.responsibility.findMany({ where: { workspaceId, originCaptureId: { in: captureIds } }, select: { id: true } }),
      [] as { id: string }[],
    );
    const responsibilityIds = responsibilities.map((r) => r.id);

    if (responsibilityIds.length > 0) {
      await step(errors, "eventLog.deleteMany(Responsibility)", () => db.eventLog.deleteMany({ where: { aggregateType: "Responsibility", aggregateId: { in: responsibilityIds } } }), { count: 0 });
      await step(errors, "outboxEvent.deleteMany(Responsibility)", () => db.outboxEvent.deleteMany({ where: { aggregateId: { in: responsibilityIds } } }), { count: 0 });
      // [2026-08-28修正・実障害の踏襲] responsibility_embeddings.responsibility_idは
      // 実カラム型がtextのため、::text[]キャストが正しい(::uuid[]は42883で失敗する)。
      await step(
        errors,
        "responsibility_embeddings raw DELETE",
        () =>
          db.$executeRawUnsafe(
            `DELETE FROM responsibility_embeddings WHERE responsibility_id = ANY($1::text[])`,
            responsibilityIds,
          ),
        0,
      );
    }
    await step(errors, "responsibility.deleteMany", () => db.responsibility.deleteMany({ where: { workspaceId, originCaptureId: { in: captureIds } } }), { count: 0 });
    await step(errors, "eventLog.deleteMany(Capture)", () => db.eventLog.deleteMany({ where: { aggregateId: { in: captureIds } } }), { count: 0 });
    await step(errors, "outboxEvent.deleteMany(Capture)", () => db.outboxEvent.deleteMany({ where: { aggregateId: { in: captureIds } } }), { count: 0 });
    await step(errors, "capture.deleteMany", () => db.capture.deleteMany({ where: { id: { in: captureIds } } }), {
      count: 0,
    });
  }

  await step(errors, "workspaceMember.deleteMany", () => db.workspaceMember.deleteMany({ where: { userId } }), {
    count: 0,
  });
  if (workspaceId) {
    await step(errors, "workspace.deleteMany", () => db.workspace.deleteMany({ where: { id: workspaceId } }), {
      count: 0,
    });
  }
  await step(errors, "user.deleteMany", () => db.user.deleteMany({ where: { id: userId } }), { count: 0 });

  return { userId, workspaceId, errors };
}

/**
 * emailPrefixで始まるtest用Userが1件も残っていないことを確認する
 * (監査B32-02「cleanup後にtest prefixのUser/Workspace/Capture/Session/
 * Responsibility/Receiptが0件であることをassertする」)。
 */
export async function assertNoLeftoverFormationVerifyUsers(
  db: Db,
  emailPrefix: string,
): Promise<{ clean: boolean; remainingUserIds: string[] }> {
  const remaining = await db.user.findMany({
    where: { email: { startsWith: emailPrefix, endsWith: "@example.invalid" } },
    select: { id: true },
  });
  return { clean: remaining.length === 0, remainingUserIds: remaining.map((u) => u.id) };
}
