#!/usr/bin/env node
/**
 * scripts/verify_gate_m1b5a_question_answer_acceptance.ts
 *
 * Gate M1-B5a(2026-08-30指示書§4.1〜4.4)の受入証跡。
 * AI providerへの実通信は一切行わない(aiNetworkDenyGuard必須)。
 *
 * 対象:
 *   1. writeShadowFormationSession(shadowWrite.ts)配線: 候補作成後、実際に
 *      Question Policyが評価され、CLARIFYING(質問あり)/REVIEW_READY(質問なし)へ
 *      正しく分岐すること(DEC-010解消の実DB確認)。
 *   2. recordFormationAnswer(answerService.ts): clientEventId冪等性(同一key同一
 *      payload replay、異payload 409相当)、CLARIFYING以外での回答拒否、
 *      Answer→Candidate Revision反映、CLARIFYING→ANALYZING→(再評価)遷移。
 *   3. 複数Question同時提示時、1問だけ回答しても残り未回答QuestionがあればCLARIFYING
 *      を維持すること(実装時に発見・是正したbugの回帰確認)。
 *   4. ALREADY_ANSWERED/REVISION_OF_NOT_LATEST/訂正(revisionOfId)の経路。
 *   5. formationVerifyCleanup.tsがFormationQuestion/FormationAnswerEventを
 *      正しく削除できること(cleanup漏れの回帰確認)。
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_m1b5a_question_answer_acceptance.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { installAiNetworkDenyGuard, selfTestAiNetworkDenyGuard } from "./lib/aiNetworkDenyGuard";
import { cleanupFormationVerifyUser, assertNoLeftoverFormationVerifyUsers } from "./lib/formationVerifyCleanup";

function loadDotEnv(envPath: string): void {
  let content: string;
  try {
    content = readFileSync(envPath, "utf-8");
  } catch {
    return;
  }
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
loadDotEnv(join(__dirname, "..", "app", ".env"));

const RUN_ID = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const EMAIL_PREFIX = "gate-m1b5a-verify-";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ok - ${name}`);
  } else {
    failed++;
    failures.push(name + (detail ? ` (${detail})` : ""));
    console.log(`  NG - ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

/** ResponsibilityCandidateSchema互換の最小候補オブジェクトを作る(shadowWrite.tsへの入力形)。 */
function makeCandidate(overrides: Record<string, unknown> & { candidateId: string; type: string; title: string }) {
  return {
    evidenceSpans: [{ start: 0, end: 4 }],
    confidence: 0.9,
    dateMentions: [],
    unknowns: [],
    blockedByCandidateIds: [],
    suggestedTags: [],
    ...overrides,
  };
}

async function main(): Promise<void> {
  const denyGuard = installAiNetworkDenyGuard();
  const guardSelfTestPassed = await selfTestAiNetworkDenyGuard(denyGuard);
  ok("[非課金guard] AI network deny guardのpure self-testが機能する", guardSelfTestPassed);
  const deniedBaseline = denyGuard.deniedCallAttempts.length;
  if (!guardSelfTestPassed) {
    denyGuard.restore();
    console.log(`\n合計: ${passed} passed, ${failed} failed`);
    process.exitCode = 1;
    return;
  }

  const { db } = await import("../app/src/lib/db");
  const { writeShadowFormationSession } = await import("../app/src/lib/formation/shadowWrite");
  const { recordFormationAnswer } = await import("../app/src/lib/formation/answerService");

  const orphans = await db.user.findMany({
    where: { email: { startsWith: EMAIL_PREFIX, endsWith: "@example.invalid" } },
    select: { id: true },
  });
  if (orphans.length > 0) {
    console.log(`[SWEEP] 過去実行の孤立テストユーザー${orphans.length}件を削除します...`);
    for (const o of orphans) {
      const result = await cleanupFormationVerifyUser(db, o.id);
      if (result.errors.length > 0) {
        console.log(`  [SWEEP] userId=${o.id} cleanup中に例外: ${result.errors.map((e) => e.step).join(",")}`);
      }
    }
  }

  const userIds: string[] = [];

  async function makeFixture(suffix: string) {
    const email = `${EMAIL_PREFIX}${RUN_ID}-${suffix}@example.invalid`;
    const user = await db.user.create({
      data: { email, passwordHash: "not-a-real-hash-for-db-only-test", displayName: `Gate M1B5a ${suffix}` },
    });
    const workspace = await db.workspace.create({ data: { name: `Gate M1B5a Workspace ${suffix}` } });
    await db.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
    const domain = await db.domain.create({ data: { workspaceId: workspace.id, name: "個人", kind: "PERSONAL" } });
    userIds.push(user.id);
    return { userId: user.id, workspaceId: workspace.id, domainId: domain.id };
  }

  async function makeCapture(fx: { workspaceId: string; domainId: string; userId: string }, rawText: string) {
    return db.capture.create({
      data: {
        workspaceId: fx.workspaceId,
        domainId: fx.domainId,
        createdById: fx.userId,
        sourceType: "TEXT",
        rawText,
        processingStatus: "READY",
      },
    });
  }

  try {
    // ============================================================
    // 1. shadowWrite配線: 質問なし(通常TASK) -> REVIEW_READY(質問0件)
    // ============================================================
    {
      const fx = await makeFixture("s1noquestion");
      const rawText = "報告書を提出する";
      const cap = await makeCapture(fx, rawText);
      const candidate = makeCandidate({
        candidateId: "c1",
        type: "TASK",
        title: "報告書を提出する",
        completionCondition: "提出完了メールを受け取る",
      });
      await writeShadowFormationSession({
        capture: { id: cap.id, workspaceId: fx.workspaceId, domainId: fx.domainId, createdById: fx.userId, rawText },
        aiRunId: `airun-${RUN_ID}-s1`,
        schemaVersion: "1.0",
        candidates: [candidate as never],
      });
      const session = await db.formationSession.findFirstOrThrow({ where: { captureId: cap.id, workspaceId: fx.workspaceId } });
      ok(
        "[M1B5a.1] completionCondition有りの通常TASKはREVIEW_READYへ進む(質問を乱発しない)",
        session.state === "REVIEW_READY",
        session.state,
      );
      const questionCount = await db.formationQuestion.count({ where: { sessionId: session.id, workspaceId: fx.workspaceId } });
      ok("[M1B5a.2] 質問0件(fieldの単純欠落だけでは質問しない設計の実DB確認)", questionCount === 0, String(questionCount));
    }

    // ============================================================
    // 2. shadowWrite配線: COMMITMENTでcounterparty欠落 -> CLARIFYING(P0質問1件)
    // ============================================================
    {
      const fx = await makeFixture("s2onequestion");
      const rawText = "山田さんへの提案を約束した";
      const cap = await makeCapture(fx, rawText);
      const candidate = makeCandidate({ candidateId: "c1", type: "COMMITMENT", title: "提案を約束する", completionCondition: "承認を得る" });
      await writeShadowFormationSession({
        capture: { id: cap.id, workspaceId: fx.workspaceId, domainId: fx.domainId, createdById: fx.userId, rawText },
        aiRunId: `airun-${RUN_ID}-s2`,
        schemaVersion: "1.0",
        candidates: [candidate as never],
      });
      const session = await db.formationSession.findFirstOrThrow({ where: { captureId: cap.id, workspaceId: fx.workspaceId } });
      ok("[M1B5a.3] COMMITMENT+counterparty欠落でCLARIFYINGへ進む", session.state === "CLARIFYING", session.state);
      ok("[M1B5a.4] questionCount=1", session.questionCount === 1, String(session.questionCount));
      const question = await db.formationQuestion.findFirstOrThrow({ where: { sessionId: session.id, workspaceId: fx.workspaceId } });
      ok(
        "[M1B5a.5] 生成されたQuestionのquestionCode/priorityが正しい",
        question.questionCode === "COMMITMENT_COUNTERPARTY_MISSING" && question.priority === "P0",
        `${question.questionCode}/${question.priority}`,
      );
      ok("[M1B5a.6] promptTextが空でない(質問本文が実際に保存されている)", question.promptText.length > 0);

      // ---- Answer API: FREE_TEXTで回答 -> REVIEW_READYへ進み、Revisionが増える ----
      const identity = await db.formationCandidateIdentity.findFirstOrThrow({ where: { sessionId: session.id, workspaceId: fx.workspaceId } });
      ok("[M1B5a.7] 回答前のcurrentRevisionは1", identity.currentRevision === 1, String(identity.currentRevision));

      const answerResult = await recordFormationAnswer({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        questionId: question.id,
        clientEventId: `client-evt-${RUN_ID}-s2-a1`,
        answerKind: "FREE_TEXT",
        value: "山田さん",
        actorUserId: fx.userId,
      });
      ok("[M1B5a.8] 回答が成功する", answerResult.ok === true, JSON.stringify(answerResult));
      if (answerResult.ok) {
        ok(
          "[M1B5a.9] 唯一のQuestionに回答したのでREVIEW_READYへ進む",
          answerResult.sessionState === "REVIEW_READY",
          answerResult.sessionState,
        );
        ok(
          "[M1B5a.10] Candidate Revisionが1→2へ進む",
          answerResult.candidateRevision?.previousRevision === 1 && answerResult.candidateRevision?.newRevision === 2,
          JSON.stringify(answerResult.candidateRevision),
        );
      }
      const identityAfter = await db.formationCandidateIdentity.findFirstOrThrow({ where: { id: identity.id, workspaceId: fx.workspaceId } });
      const revision2 = await db.formationCandidateRevision.findFirstOrThrow({
        where: { candidateId: identity.id, workspaceId: fx.workspaceId, revision: identityAfter.currentRevision },
      });
      const proposedFields = revision2.proposedFields as { counterparty?: string };
      ok(
        "[M1B5a.11] 新Revisionのproposed FieldsへFREE_TEXT回答(山田さん)がcounterpartyとして反映されている",
        proposedFields.counterparty === "山田さん",
        JSON.stringify(proposedFields),
      );

      // ---- idempotency: 同一clientEventId・同一payloadはreplay ----
      const replayResult = await recordFormationAnswer({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        questionId: question.id,
        clientEventId: `client-evt-${RUN_ID}-s2-a1`,
        answerKind: "FREE_TEXT",
        value: "山田さん",
        actorUserId: fx.userId,
      });
      ok(
        "[M1B5a.12] 同一clientEventId・同一payloadの再送はreplay=trueで成功する(二重副作用が起きない)",
        replayResult.ok === true && replayResult.replay === true,
        JSON.stringify(replayResult),
      );
      const revisionCountAfterReplay = await db.formationCandidateRevision.count({ where: { candidateId: identity.id, workspaceId: fx.workspaceId } });
      ok(
        "[M1B5a.13] replayではCandidate Revisionが増えない(revision数は2のまま)",
        revisionCountAfterReplay === 2,
        String(revisionCountAfterReplay),
      );

      // ---- idempotency: 同一clientEventId・異payloadはIDEMPOTENCY_KEY_REUSED ----
      const reuseResult = await recordFormationAnswer({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        questionId: question.id,
        clientEventId: `client-evt-${RUN_ID}-s2-a1`,
        answerKind: "FREE_TEXT",
        value: "別の値",
        actorUserId: fx.userId,
      });
      ok(
        "[M1B5a.14] 同一clientEventId・異payloadはIDEMPOTENCY_KEY_REUSEDになる",
        reuseResult.ok === false && (reuseResult as { error: string }).error === "IDEMPOTENCY_KEY_REUSED",
        JSON.stringify(reuseResult),
      );

      // ---- CLARIFYING以外での回答拒否 ----
      const wrongStateResult = await recordFormationAnswer({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        questionId: question.id,
        clientEventId: `client-evt-${RUN_ID}-s2-a2-wrongstate`,
        answerKind: "FREE_TEXT",
        value: "田中さん",
        actorUserId: fx.userId,
      });
      ok(
        "[M1B5a.15] Session=REVIEW_READY(CLARIFYING以外)での新規clientEventId回答はINVALID_SESSION_STATE",
        wrongStateResult.ok === false && (wrongStateResult as { error: string }).error === "INVALID_SESSION_STATE",
        JSON.stringify(wrongStateResult),
      );
    }

    // ============================================================
    // 3. 複数Question同時提示 -> 1問だけ回答しても残りがあればCLARIFYING維持
    //    (実装時に発見・是正したbugの回帰確認)
    // ============================================================
    {
      const fx = await makeFixture("s3twoquestions");
      const rawText = "AとBをそれぞれ約束した";
      const cap = await makeCapture(fx, rawText);
      const candA = makeCandidate({ candidateId: "cA", type: "COMMITMENT", title: "Aを約束する", completionCondition: "Aの承認を得る" });
      const candB = makeCandidate({ candidateId: "cB", type: "COMMITMENT", title: "Bを約束する", completionCondition: "Bの承認を得る" });
      await writeShadowFormationSession({
        capture: { id: cap.id, workspaceId: fx.workspaceId, domainId: fx.domainId, createdById: fx.userId, rawText },
        aiRunId: `airun-${RUN_ID}-s3`,
        schemaVersion: "1.0",
        candidates: [candA as never, candB as never],
      });
      const session = await db.formationSession.findFirstOrThrow({ where: { captureId: cap.id, workspaceId: fx.workspaceId } });
      ok("[M1B5a.16] 2候補ともCOMMITMENT+counterparty欠落でCLARIFYING・questionCount=2", session.state === "CLARIFYING" && session.questionCount === 2, `${session.state}/${session.questionCount}`);

      const questions = await db.formationQuestion.findMany({ where: { sessionId: session.id, workspaceId: fx.workspaceId }, orderBy: { ordinal: "asc" } });
      ok("[M1B5a.17] Question2件生成される", questions.length === 2, String(questions.length));

      // 1問目だけ回答する
      const firstAnswer = await recordFormationAnswer({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        questionId: questions[0].id,
        clientEventId: `client-evt-${RUN_ID}-s3-a1`,
        answerKind: "FREE_TEXT",
        value: "A相手",
        actorUserId: fx.userId,
      });
      ok(
        "[M1B5a.18・回帰確認の核心] 2問中1問だけ回答しても、残り1問が未回答ならCLARIFYINGを維持する(REVIEW_READYへ誤って進まない)",
        firstAnswer.ok === true && firstAnswer.sessionState === "CLARIFYING",
        JSON.stringify(firstAnswer),
      );
      const sessionAfterFirst = await db.formationSession.findFirstOrThrow({ where: { id: session.id, workspaceId: fx.workspaceId } });
      ok(
        "[M1B5a.19] questionCountは新規質問を生成していないので2のまま",
        sessionAfterFirst.questionCount === 2,
        String(sessionAfterFirst.questionCount),
      );

      // 2問目に回答 -> 全問回答済みなのでREVIEW_READYへ
      const secondAnswer = await recordFormationAnswer({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        questionId: questions[1].id,
        clientEventId: `client-evt-${RUN_ID}-s3-a2`,
        answerKind: "FREE_TEXT",
        value: "B相手",
        actorUserId: fx.userId,
      });
      ok(
        "[M1B5a.20] 2問目に回答すると全問回答済みとなりREVIEW_READYへ進む",
        secondAnswer.ok === true && secondAnswer.sessionState === "REVIEW_READY",
        JSON.stringify(secondAnswer),
      );

      // ---- ALREADY_ANSWERED / REVISION_OF_NOT_LATEST ----
      // (Sessionは既にREVIEW_READYのため、まずCLARIFYINGへ戻すのではなく、
      //  「回答済みQuestionへrevisionOfId無しで再送するとどうなるか」は
      //  Session状態がCLARIFYINGである必要があるため、このシナリオ専用に
      //  別Sessionを用意する。)
    }

    // ============================================================
    // 4. ALREADY_ANSWERED / REVISION_OF_NOT_LATEST / 訂正(revisionOfId)
    // ============================================================
    {
      const fx = await makeFixture("s4correction");
      const rawText = "AとBをそれぞれ約束した(訂正確認用)";
      const cap = await makeCapture(fx, rawText);
      const candA = makeCandidate({ candidateId: "cA", type: "COMMITMENT", title: "Aを約束する", completionCondition: "Aの承認を得る" });
      const candB = makeCandidate({ candidateId: "cB", type: "COMMITMENT", title: "Bを約束する", completionCondition: "Bの承認を得る" });
      await writeShadowFormationSession({
        capture: { id: cap.id, workspaceId: fx.workspaceId, domainId: fx.domainId, createdById: fx.userId, rawText },
        aiRunId: `airun-${RUN_ID}-s4`,
        schemaVersion: "1.0",
        candidates: [candA as never, candB as never],
      });
      const session = await db.formationSession.findFirstOrThrow({ where: { captureId: cap.id, workspaceId: fx.workspaceId } });
      const questions = await db.formationQuestion.findMany({ where: { sessionId: session.id, workspaceId: fx.workspaceId }, orderBy: { ordinal: "asc" } });

      const firstAnswer = await recordFormationAnswer({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        questionId: questions[0].id,
        clientEventId: `client-evt-${RUN_ID}-s4-a1`,
        answerKind: "FREE_TEXT",
        value: "A相手(誤)",
        actorUserId: fx.userId,
      });
      ok("[M1B5a.21] 1問目回答成功、残り1問のためCLARIFYING維持", firstAnswer.ok === true && firstAnswer.sessionState === "CLARIFYING", JSON.stringify(firstAnswer));
      const firstAnswerEventId = firstAnswer.ok ? firstAnswer.answerEventId : "";

      // revisionOfId無しで同じ質問に再回答 -> ALREADY_ANSWERED
      const noRevisionOf = await recordFormationAnswer({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        questionId: questions[0].id,
        clientEventId: `client-evt-${RUN_ID}-s4-a2-noRevOf`,
        answerKind: "FREE_TEXT",
        value: "A相手(訂正試行・revisionOfId無し)",
        actorUserId: fx.userId,
      });
      ok(
        "[M1B5a.22] revisionOfId無しで既回答Questionへ再送するとALREADY_ANSWERED",
        noRevisionOf.ok === false && (noRevisionOf as { error: string }).error === "ALREADY_ANSWERED",
        JSON.stringify(noRevisionOf),
      );

      // 誤ったrevisionOfIdを指定 -> REVISION_OF_NOT_LATEST
      const wrongRevisionOf = await recordFormationAnswer({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        questionId: questions[0].id,
        clientEventId: `client-evt-${RUN_ID}-s4-a3-wrongRevOf`,
        answerKind: "FREE_TEXT",
        value: "A相手(訂正試行・誤ったrevisionOfId)",
        revisionOfId: "not-a-real-answer-event-id",
        actorUserId: fx.userId,
      });
      ok(
        "[M1B5a.23] 存在しない/最新でないrevisionOfIdを指定するとREVISION_OF_NOT_LATEST",
        wrongRevisionOf.ok === false && (wrongRevisionOf as { error: string }).error === "REVISION_OF_NOT_LATEST",
        JSON.stringify(wrongRevisionOf),
      );

      // 正しいrevisionOfIdで訂正 -> 成功、append-onlyで新規行が追加される
      const correction = await recordFormationAnswer({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        questionId: questions[0].id,
        clientEventId: `client-evt-${RUN_ID}-s4-a4-correction`,
        answerKind: "FREE_TEXT",
        value: "A相手(訂正後・正)",
        revisionOfId: firstAnswerEventId,
        actorUserId: fx.userId,
      });
      ok(
        "[M1B5a.24] 正しいrevisionOfIdを指定した訂正は成功する",
        correction.ok === true,
        JSON.stringify(correction),
      );
      const answerEventsForQ0 = await db.formationAnswerEvent.findMany({ where: { workspaceId: fx.workspaceId, questionId: questions[0].id } });
      ok(
        "[M1B5a.25] 訂正はappend-only(元のAnswer Eventは削除・上書きされず、2行存在する)",
        answerEventsForQ0.length === 2,
        String(answerEventsForQ0.length),
      );
      const correctionRow = answerEventsForQ0.find((a: { id: string }) => a.id !== firstAnswerEventId);
      ok(
        "[M1B5a.26] 訂正行のrevisionOfIdが元のAnswer Event.idを指している",
        correctionRow?.revisionOfId === firstAnswerEventId,
        JSON.stringify(correctionRow),
      );

      // 2問目に回答して全問完了、REVIEW_READYへ
      const secondAnswer = await recordFormationAnswer({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        questionId: questions[1].id,
        clientEventId: `client-evt-${RUN_ID}-s4-a5`,
        answerKind: "FREE_TEXT",
        value: "B相手",
        actorUserId: fx.userId,
      });
      ok(
        "[M1B5a.27] 2問目回答で全問完了・REVIEW_READYへ進む(訂正を挟んでも正しく完了する)",
        secondAnswer.ok === true && secondAnswer.sessionState === "REVIEW_READY",
        JSON.stringify(secondAnswer),
      );
    }

    // ============================================================
    // 5. HARD_DEADLINE低confidence -> SELECTED回答でdateMentions更新
    // ============================================================
    {
      const fx = await makeFixture("s5deadline");
      const rawText = "来週中に対応が必要かもしれない";
      const cap = await makeCapture(fx, rawText);
      const candidate = makeCandidate({
        candidateId: "c1",
        type: "TASK",
        title: "対応する",
        completionCondition: "対応完了する",
        dateMentions: [{ rawExpression: "来週中", meaning: "HARD_DEADLINE", timezone: "Asia/Tokyo", confidence: 0.3 }],
      });
      await writeShadowFormationSession({
        capture: { id: cap.id, workspaceId: fx.workspaceId, domainId: fx.domainId, createdById: fx.userId, rawText },
        aiRunId: `airun-${RUN_ID}-s5`,
        schemaVersion: "1.0",
        candidates: [candidate as never],
      });
      const session = await db.formationSession.findFirstOrThrow({ where: { captureId: cap.id, workspaceId: fx.workspaceId } });
      ok("[M1B5a.28] HARD_DEADLINE低confidenceでCLARIFYINGへ進む", session.state === "CLARIFYING", session.state);
      const question = await db.formationQuestion.findFirstOrThrow({ where: { sessionId: session.id, workspaceId: fx.workspaceId } });
      ok("[M1B5a.29] questionCodeがHARD_DEADLINE_LOW_CONFIDENCE", question.questionCode === "HARD_DEADLINE_LOW_CONFIDENCE", question.questionCode);

      const identity = await db.formationCandidateIdentity.findFirstOrThrow({ where: { sessionId: session.id, workspaceId: fx.workspaceId } });
      const answer = await recordFormationAnswer({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        questionId: question.id,
        clientEventId: `client-evt-${RUN_ID}-s5-a1`,
        answerKind: "SELECTED",
        value: "CONFIRM_HARD_DEADLINE",
        actorUserId: fx.userId,
      });
      ok("[M1B5a.30] SELECTED回答(締切確認)が成功しREVIEW_READYへ進む", answer.ok === true && answer.sessionState === "REVIEW_READY", JSON.stringify(answer));
      const identityAfter = await db.formationCandidateIdentity.findFirstOrThrow({ where: { id: identity.id, workspaceId: fx.workspaceId } });
      const revisionAfter = await db.formationCandidateRevision.findFirstOrThrow({
        where: { candidateId: identity.id, workspaceId: fx.workspaceId, revision: identityAfter.currentRevision },
      });
      const proposedFields = revisionAfter.proposedFields as { dateMentions?: Array<{ confidence: number; meaning: string }> };
      ok(
        "[M1B5a.31] 締切確認後、dateMentionsのconfidenceが1に更新されている",
        proposedFields.dateMentions?.[0]?.confidence === 1 && proposedFields.dateMentions?.[0]?.meaning === "HARD_DEADLINE",
        JSON.stringify(proposedFields.dateMentions),
      );
    }

    // ============================================================
    // 6. 生涯上限3問(4件目以上の候補があっても質問は3件まで)
    // ============================================================
    {
      const fx = await makeFixture("s6maxthree");
      const rawText = "A/B/C/Dをそれぞれ約束した";
      const cap = await makeCapture(fx, rawText);
      const candidates = ["cA", "cB", "cC", "cD"].map((id, i) =>
        makeCandidate({ candidateId: id, type: "COMMITMENT", title: `${id}を約束する`, completionCondition: `${id}の承認を得る`, evidenceSpans: [{ start: i, end: i + 1 }] }),
      );
      await writeShadowFormationSession({
        capture: { id: cap.id, workspaceId: fx.workspaceId, domainId: fx.domainId, createdById: fx.userId, rawText },
        aiRunId: `airun-${RUN_ID}-s6`,
        schemaVersion: "1.0",
        candidates: candidates as never,
      });
      const session = await db.formationSession.findFirstOrThrow({ where: { captureId: cap.id, workspaceId: fx.workspaceId } });
      ok(
        "[M1B5a.32・EV-F-002相当] 4候補全てP0該当でも、生涯上限どおり質問は3件までしか生成されない",
        session.questionCount === 3,
        String(session.questionCount),
      );
      const questionCount = await db.formationQuestion.count({ where: { sessionId: session.id, workspaceId: fx.workspaceId } });
      ok("[M1B5a.33] DB上のFormationQuestion行数も3件", questionCount === 3, String(questionCount));
    }

    ok(
      "[非課金guard] scenario実行中、AI provider hostへの通信試行は0件(self-test自身の既知の1件を除く)",
      denyGuard.deniedCallAttempts.length === deniedBaseline,
      `total=${denyGuard.deniedCallAttempts.length}`,
    );
  } finally {
    const { db: dbForCleanup } = await import("../app/src/lib/db");
    const cleanupErrors: { step: string; error: unknown }[] = [];
    for (const uid of userIds) {
      const result = await cleanupFormationVerifyUser(dbForCleanup, uid);
      cleanupErrors.push(...result.errors);
    }
    ok(
      "[cleanup] cleanup処理中に例外が0件である(FormationQuestion/FormationAnswerEventのFK順削除を含む)",
      cleanupErrors.length === 0,
      cleanupErrors.map((e) => `${e.step}:${String(e.error)}`).join(" | "),
    );
    const leftover = await assertNoLeftoverFormationVerifyUsers(dbForCleanup, EMAIL_PREFIX);
    ok("[cleanup] cleanup後、test prefixのUserが0件である", leftover.clean, leftover.remainingUserIds.join(","));
  }

  denyGuard.restore();

  console.log(`\n合計: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("失敗一覧:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error("予期しない例外:", err);
    process.exit(1);
  });
