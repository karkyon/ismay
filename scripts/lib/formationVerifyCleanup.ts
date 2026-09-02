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
  let resolvedWorkspaceIdOuter: string | null = workspaceId;

  // [B4.1是正・2026-08-29] workspaceMember行が(過去の途中失敗runで)既に
  // 削除済みの場合、workspaceId経由だけではこのuserが作成したCaptureを
  // 見失う(membershipが無い=workspaceId=nullとなり、この関数のCapture探索
  // ブロック自体がまるごとスキップされていた)。userId(createdById)経由でも
  // 必ずCaptureを探し、両方の結果を合算する。
  const capturesByCreator = await step(
    errors,
    "capture.findMany(createdById)",
    () => db.capture.findMany({ where: { createdById: userId }, select: { id: true, workspaceId: true } }),
    [] as { id: string; workspaceId: string }[],
  );
  const resolvedWorkspaceId = workspaceId ?? capturesByCreator[0]?.workspaceId ?? null;
  resolvedWorkspaceIdOuter = resolvedWorkspaceId;

  if (resolvedWorkspaceId) {
    const capturesByWorkspace = await step(
      errors,
      "capture.findMany",
      () => db.capture.findMany({ where: { workspaceId: resolvedWorkspaceId }, select: { id: true } }),
      [] as { id: string }[],
    );
    const captureIds = [...new Set([...capturesByWorkspace, ...capturesByCreator].map((c) => c.id))];

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
      // [2026-08-30新設・M1-B5a是正] FormationQuestion/FormationAnswerEventが
      // このcleanupに組み込まれていなかった(M1-B5a §3.2でtable新設時に追随漏れ)。
      // FormationAnswerEvent.questionId(必須FK)→FormationQuestion、
      // FormationQuestion.candidateId(nullable FK)→FormationCandidateIdentity、
      // FormationQuestion.askedEventId(nullable FK)→FormationSessionEventの依存が
      // あるため、下のformationCandidateIdentity.deleteMany/formationSessionEvent.
      // deleteManyより先に、必ずこのブロックで削除しておく(そうしないとFK違反で
      // cleanup全体が中断し、test用行が残る)。
      const questions = await step(
        errors,
        "formationQuestion.findMany",
        () => db.formationQuestion.findMany({ where: { sessionId: { in: sessionIds } }, select: { id: true } }),
        [] as { id: string }[],
      );
      const questionIds = questions.map((q) => q.id);
      if (questionIds.length > 0) {
        await step(errors, "formationAnswerEvent.deleteMany", () => db.formationAnswerEvent.deleteMany({ where: { questionId: { in: questionIds } } }), { count: 0 });
      }
      await step(errors, "formationQuestion.deleteMany", () => db.formationQuestion.deleteMany({ where: { sessionId: { in: sessionIds } } }), { count: 0 });

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
          // [2026-08-30新設・M1-C2B是正] formation_candidate_lineagesは
          // child_revision_id(このSessionのRevision)とparent_identity_id
          // (このSessionのIdentity)の両方への複合FKを持つ。lineageは
          // Merge/Split操作で「他候補」を親として参照することもあるため、
          // Session内revisionIds/identityIdsのどちらか一方でも一致すれば
          // 削除対象に含める(OR条件)。formationCandidateRevision/
          // formationCandidateIdentityのどちらのdeleteManyより先に
          // 実行する必要がある。
          await step(
            errors,
            "formationCandidateLineage.deleteMany",
            () =>
              db.formationCandidateLineage.deleteMany({
                where: { OR: [{ childRevisionId: { in: revisionIds } }, { parentIdentityId: { in: identityIds } }] },
              }),
            { count: 0 },
          );
          await step(errors, "formationSourceAnchor.deleteMany", () => db.formationSourceAnchor.deleteMany({ where: { revisionId: { in: revisionIds } } }), { count: 0 });
          // [2026-08-30新設・M1-C是正] formation_atomicity_assessmentsは
          // formation_candidate_revisionsへの複合FK(revision_id, workspace_id)を
          // 持つため、formationCandidateRevision.deleteManyより先に削除しないと
          // FK違反でcleanup全体が中断する(M1-B5aのFormationQuestion/
          // FormationAnswerEventで踏んだのと同種の追随漏れ、今回はテーブル
          // 新設時に発見・即時是正)。
          await step(errors, "formationAtomicityAssessment.deleteMany", () => db.formationAtomicityAssessment.deleteMany({ where: { revisionId: { in: revisionIds } } }), { count: 0 });
          // [2026-08-30新設・M1-C2A是正] formation_atomicity_overridesも同じ複合FKを
          // 持つため、同じ理由でformationCandidateRevision.deleteManyより先に削除する
          // (formationAtomicityAssessmentと全く同じ教訓、今回は実装と同一工程で対応)。
          await step(errors, "formationAtomicityOverride.deleteMany", () => db.formationAtomicityOverride.deleteMany({ where: { revisionId: { in: revisionIds } } }), { count: 0 });
        }
        // [2026-08-30新設・M1-C2B是正] formation_candidate_merge_eventsは
        // new_candidate_idを通じてformation_candidate_identitiesへの複合FKを
        // 持つため、formationCandidateIdentity.deleteManyより先に削除する。
        await step(errors, "formationCandidateMergeEvent.deleteMany", () => db.formationCandidateMergeEvent.deleteMany({ where: { newCandidateId: { in: identityIds } } }), { count: 0 });
        await step(errors, "materializationReceiptItem.deleteMany", () => db.materializationReceiptItem.deleteMany({ where: { candidateId: { in: identityIds } } }), { count: 0 });
        await step(errors, "formationCandidateDecisionEvent.deleteMany", () => db.formationCandidateDecisionEvent.deleteMany({ where: { candidateId: { in: identityIds } } }), { count: 0 });
        await step(errors, "formationCandidateRevision.deleteMany", () => db.formationCandidateRevision.deleteMany({ where: { candidateId: { in: identityIds } } }), { count: 0 });
      }
      await step(errors, "formationCandidateIdentity.deleteMany", () => db.formationCandidateIdentity.deleteMany({ where: { sessionId: { in: sessionIds } } }), { count: 0 });
      await step(errors, "materializationReceipt.deleteMany", () => db.materializationReceipt.deleteMany({ where: { sessionId: { in: sessionIds } } }), { count: 0 });
      // [M1-B6B新設] formation_session_lifecycle_eventsもformation_sessionsへの
      // 複合FKを持つため、formationSession.deleteManyより先に削除する
      // (formationSessionEvent.deleteManyと同じ理由)。
      await step(errors, "formationSessionLifecycleEvent.deleteMany", () => db.formationSessionLifecycleEvent.deleteMany({ where: { sessionId: { in: sessionIds } } }), { count: 0 });
      await step(errors, "formationSessionEvent.deleteMany", () => db.formationSessionEvent.deleteMany({ where: { sessionId: { in: sessionIds } } }), { count: 0 });
      await step(errors, "formationSession.deleteMany", () => db.formationSession.deleteMany({ where: { id: { in: sessionIds } } }), { count: 0 });
    }

    const responsibilities = await step(
      errors,
      "responsibility.findMany",
      () => db.responsibility.findMany({ where: { workspaceId: resolvedWorkspaceId, originCaptureId: { in: captureIds } }, select: { id: true } }),
      [] as { id: string }[],
    );
    const responsibilityIds = responsibilities.map((r) => r.id);

    if (responsibilityIds.length > 0) {
      // [B4新設・2026-08-29] materialize.ts側にもTag自動付与・BLOCKS Relation解決
      // (B31-06是正)が追加されたことに伴う対応。ResponsibilityRelationは
      // fromId/toIdともonDelete指定なし(デフォルトRESTRICT)のため、これを先に
      // 消さないとresponsibility.deleteMany自体がFK違反で失敗し、cleanup全体が
      // 中断してtest用行が残ってしまう(実際にこのGateでBLOCKS Relationを
      // 初めてmaterialize.ts経由で作るようになって顕在化した)。
      await step(
        errors,
        "responsibilityRelation.deleteMany",
        () =>
          db.responsibilityRelation.deleteMany({
            where: { OR: [{ fromId: { in: responsibilityIds } }, { toId: { in: responsibilityIds } }] },
          }),
        { count: 0 },
      );
      // [M1-C3新設・2026-09-02] responsibility_correction_result_items.new_responsibility_id
      // はResponsibilityへの複合FK(RESTRICT)を持つため、responsibility.deleteManyより
      // 先に削除しないとFK違反でcleanup全体が中断する(formationCandidateLineage等と
      // 同じ追随漏れ防止パターン)。Split対象(source)とSplit結果(new)のどちらも
      // responsibilityIdsに含まれるため、receiptはsourceResponsibilityId経由で特定する。
      const correctionReceipts = await step(
        errors,
        "responsibilityCorrectionReceipt.findMany",
        () =>
          db.responsibilityCorrectionReceipt.findMany({
            where: { workspaceId: resolvedWorkspaceId, sourceResponsibilityId: { in: responsibilityIds } },
            select: { id: true },
          }),
        [] as { id: string }[],
      );
      const correctionReceiptIds = correctionReceipts.map((r) => r.id);
      if (correctionReceiptIds.length > 0) {
        await step(
          errors,
          "responsibilityCorrectionResultItem.deleteMany",
          () => db.responsibilityCorrectionResultItem.deleteMany({ where: { receiptId: { in: correctionReceiptIds } } }),
          { count: 0 },
        );
      }
      // [M1-C3B新設・2026-09-02] responsibility_merge_source_items.
      // source_responsibility_idはResponsibilityへの複合FK(RESTRICT)を持つため、
      // responsibility.deleteManyより先に削除する(上のresponsibilityCorrection
      // ResultItemと同じ追随漏れ防止パターン)。receiptはnewResponsibilityId経由で
      // 特定する(新規生成されたResponsibilityも必ずresponsibilityIdsに含まれる)。
      const mergeReceipts = await step(
        errors,
        "responsibilityMergeReceipt.findMany",
        () =>
          db.responsibilityMergeReceipt.findMany({
            where: { workspaceId: resolvedWorkspaceId, newResponsibilityId: { in: responsibilityIds } },
            select: { id: true },
          }),
        [] as { id: string }[],
      );
      const mergeReceiptIds = mergeReceipts.map((r) => r.id);
      if (mergeReceiptIds.length > 0) {
        await step(
          errors,
          "responsibilityMergeSourceItem.deleteMany",
          () => db.responsibilityMergeSourceItem.deleteMany({ where: { receiptId: { in: mergeReceiptIds } } }),
          { count: 0 },
        );
      }
      // [重大バグ修正・2026-09-02徹底再検証で発覚・未実行のまま気づいた設計ミス]
      // `responsibility_correction_receipts.source_responsibility_id → responsibilities`
      // (RESTRICT)と`responsibilities.superseded_by_receipt_id →
      // responsibility_correction_receipts`(RESTRICT、逆方向)は互いに参照し合う
      // 循環関係にある。Merge側も同様(supersededByMergeReceiptId ⇄
      // responsibility_merge_receipts)。Receipt/Responsibilityのどちらを先に
      // 削除しようとしても、もう片方がまだ参照している限りFK違反になり
      // cleanup全体が中断する(このコードパスは実DBで一度も実行されておらず、
      // 局所的なコメントの追随漏れチェックだけでは気づけなかった)。
      // 削除前に、対象Responsibility側の参照列をNULL化して依存を断ち切り、
      // その後Receipt自体を削除してからResponsibilityを削除する(下部の
      // responsibility.deleteManyより前にReceipt削除まで完了させる)。
      await step(
        errors,
        "responsibility.updateMany(clear supersededBy*)",
        () =>
          db.responsibility.updateMany({
            where: { id: { in: responsibilityIds } },
            data: { supersededByReceiptId: null, supersededByMergeReceiptId: null },
          }),
        { count: 0 },
      );
      if (correctionReceiptIds.length > 0) {
        await step(
          errors,
          "responsibilityCorrectionReceipt.deleteMany",
          () => db.responsibilityCorrectionReceipt.deleteMany({ where: { id: { in: correctionReceiptIds } } }),
          { count: 0 },
        );
      }
      if (mergeReceiptIds.length > 0) {
        await step(
          errors,
          "responsibilityMergeReceipt.deleteMany",
          () => db.responsibilityMergeReceipt.deleteMany({ where: { id: { in: mergeReceiptIds } } }),
          { count: 0 },
        );
      }
      // [M1-C3新設・2026-09-02] responsibilityCorrection.tsがSplit結果の子
      // ResponsibilityへProjectContextLink/LinkEventを複製するため、
      // responsibility.deleteManyより先にresponsibilityId経由で削除する
      // (ProjectContextLink.responsibilityIdはResponsibilityへの複合FK RESTRICT)。
      // [既知の欠陥是正の一環] formationVerifyCleanupは従来ProjectContext系を
      // 一切扱っていなかった(verify_gate_m1a_acceptance.tsが独自の別cleanup関数を
      // 持つ設計だったため)。このGateで初めてformationVerifyCleanup経由の
      // テストがProjectContextLinkを作るようになったため、必要な範囲だけ追加する。
      await step(errors, "projectContextLinkEvent.deleteMany(byResponsibility)", () => db.projectContextLinkEvent.deleteMany({ where: { responsibilityId: { in: responsibilityIds } } }), { count: 0 });
      await step(errors, "projectContextLink.deleteMany(byResponsibility)", () => db.projectContextLink.deleteMany({ where: { responsibilityId: { in: responsibilityIds } } }), { count: 0 });
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
    // [2026-09-02是正] Receipt自体は上のresponsibilityIdsブロック内で既に削除済み
    // (循環FK解消のため、Responsibility削除より前に完了させる必要があったため)。
    await step(errors, "responsibility.deleteMany", () => db.responsibility.deleteMany({ where: { workspaceId: resolvedWorkspaceId, originCaptureId: { in: captureIds } } }), { count: 0 });
    // [B4新設・2026-08-29] Tag自動付与(B31-06是正)に伴う対応。ResponsibilityTagは
    // onDelete: Cascadeのため上のresponsibility.deleteManyで自動的に消えるが、
    // Tag行自体(workspaceId_name一意)はcascade対象外のため明示的に消す
    // (残すとtest再実行時にupsertで再利用されるだけで実害は無いが、
    // 「実行したゴミファイルはちゃんとかたずけろ」の方針を徹底する)。
    await step(errors, "tag.deleteMany", () => db.tag.deleteMany({ where: { workspaceId: resolvedWorkspaceId } }), { count: 0 });
    await step(errors, "eventLog.deleteMany(Capture)", () => db.eventLog.deleteMany({ where: { aggregateId: { in: captureIds } } }), { count: 0 });
    await step(errors, "outboxEvent.deleteMany(Capture)", () => db.outboxEvent.deleteMany({ where: { aggregateId: { in: captureIds } } }), { count: 0 });
    // [B4.1新設・2026-08-29] AiInference.aiRunIdがAiRunを参照するため、
    // aiInference→aiRunの順でcapture.deleteManyより先に削除する
    // (このコメントブロックの2つ上のGate M1-B4.1で初めて必要になった対応。
    // 前回の修正時、GitHub未push状態のこの箇所を素のHEADから再構成した際に
    // 誤って失われていたため、ここで再度・確実に追加する)。
    // [M1-B6C-1新設・2026-08-31] formation_shadow_checkpointsはai_run_id(→ai_runs)と
    // capture_id(→captures)の両方への複合/単一FKを持つため、aiRun.deleteMany/
    // capture.deleteManyより先に削除する(formationQuestion等と同じ追随漏れ防止パターン)。
    await step(errors, "formationShadowCheckpoint.deleteMany", () => db.formationShadowCheckpoint.deleteMany({ where: { captureId: { in: captureIds } } }), { count: 0 });
    // [M1-B6C-4新設・2026-09-02] retry orchestrationがJob(jobType=AI_EXTRACT)を
    // captureId=aggregateIdとして作成しうるため、capture.deleteManyより先に削除する
    // (JobはCaptureへの正式なDB FKを持たないため放置してもFK違反にはならないが、
    // test data cleanup 0件を保証するため明示的に削除する)。
    await step(errors, "job.deleteMany(AI_EXTRACT)", () => db.job.deleteMany({ where: { jobType: "AI_EXTRACT", aggregateId: { in: captureIds } } }), { count: 0 });
    await step(errors, "aiInference.deleteMany", () => db.aiInference.deleteMany({ where: { captureId: { in: captureIds } } }), { count: 0 });
    await step(errors, "aiRun.deleteMany", () => db.aiRun.deleteMany({ where: { captureId: { in: captureIds } } }), { count: 0 });
    await step(errors, "capture.deleteMany", () => db.capture.deleteMany({ where: { id: { in: captureIds } } }), {
      count: 0,
    });
  }

  // [M1-C3新設・2026-09-02] ProjectContext.workspaceIdはWorkspaceへの単一FK
  // (デフォルトRESTRICT)を持つため、workspace.deleteManyより先にこのworkspace配下の
  // 全ProjectContext及びその従属table(externalContextReference経由のsnapshot、
  // embedding、Link/LinkEvent、EventLog/Outbox)を削除する。上のresponsibilityIds
  // ブロックはSplitで複製されたLinkのみをresponsibilityId経由で消すため、
  // Split対象外のProjectContext(テストfixtureが直接作成したもの)を拾うには
  // このcontextId経由の削除が必要(verify_gate_m1a_acceptance.tsの
  // cleanupTestUserと同じFK依存順を踏襲)。
  if (resolvedWorkspaceIdOuter) {
    const projectContexts = await step(
      errors,
      "projectContext.findMany",
      () => db.projectContext.findMany({ where: { workspaceId: resolvedWorkspaceIdOuter as string }, select: { id: true } }),
      [] as { id: string }[],
    );
    const contextIds = projectContexts.map((c) => c.id);
    if (contextIds.length > 0) {
      const externalRefs = await step(
        errors,
        "externalContextReference.findMany",
        () => db.externalContextReference.findMany({ where: { contextId: { in: contextIds } }, select: { id: true } }),
        [] as { id: string }[],
      );
      const externalRefIds = externalRefs.map((r) => r.id);
      if (externalRefIds.length > 0) {
        await step(errors, "projectContextSnapshotRevision.deleteMany", () => db.projectContextSnapshotRevision.deleteMany({ where: { referenceId: { in: externalRefIds } } }), { count: 0 });
      }
      await step(errors, "externalContextReference.deleteMany", () => db.externalContextReference.deleteMany({ where: { contextId: { in: contextIds } } }), { count: 0 });
      await step(errors, "projectContextEmbedding.deleteMany", () => db.projectContextEmbedding.deleteMany({ where: { contextId: { in: contextIds } } }), { count: 0 });
      await step(errors, "projectContextLinkEvent.deleteMany(byContext)", () => db.projectContextLinkEvent.deleteMany({ where: { contextId: { in: contextIds } } }), { count: 0 });
      await step(errors, "projectContextLink.deleteMany(byContext)", () => db.projectContextLink.deleteMany({ where: { contextId: { in: contextIds } } }), { count: 0 });
      await step(errors, "eventLog.deleteMany(ProjectContext)", () => db.eventLog.deleteMany({ where: { aggregateId: { in: contextIds } } }), { count: 0 });
      await step(errors, "outboxEvent.deleteMany(ProjectContext)", () => db.outboxEvent.deleteMany({ where: { aggregateId: { in: contextIds } } }), { count: 0 });
      await step(errors, "projectContext.deleteMany", () => db.projectContext.deleteMany({ where: { id: { in: contextIds } } }), { count: 0 });
    }
  }

  await step(errors, "workspaceMember.deleteMany", () => db.workspaceMember.deleteMany({ where: { userId } }), {
    count: 0,
  });
  if (resolvedWorkspaceIdOuter) {
    await step(errors, "workspace.deleteMany", () => db.workspace.deleteMany({ where: { id: resolvedWorkspaceIdOuter } }), {
      count: 0,
    });
  }
  await step(errors, "user.deleteMany", () => db.user.deleteMany({ where: { id: userId } }), { count: 0 });

  return { userId, workspaceId: resolvedWorkspaceIdOuter, errors };
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
