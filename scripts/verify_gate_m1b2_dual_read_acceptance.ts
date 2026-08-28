#!/usr/bin/env node
/**
 * scripts/verify_gate_m1b2_dual_read_acceptance.ts
 *
 * DOC-03(Formation Session仕様書) 10章のロールアップ計画でいう「B2: 既存Inference
 * decisionとdual-read」の受入証跡。
 *
 * [スコープの明示的な境界] このスクリプトはEV-F-*(Gate M1-B本体、DOC-12 4章)の
 * 代替ではない。B2は読み取りのみを追加する段階であり、確定/Materialize/Question
 * PolicyはB3以降で実装される。ここで検証するのは、DOC-03自身が明示するB2の
 * スコープ「既存Inference decisionとの並行読み」が、実際の採否操作
 * (`/inferences/[id]/decision`、B2では一切変更していない)に対して正しく機能する
 * か、という点に限定される。
 *
 * 検証内容:
 *   1. 実Captureを作成し解析→実AI呼び出し→READYまでポーリング(B1と同じ手順)。
 *   2. 得られた候補のうち1件をACCEPT、1件をREJECTし、既存の
 *      `/inferences/[id]/decision`(B2で無変更)を実際に呼ぶ。
 *   3. GET `/formation-sessions/{id}/dual-read`(B2新設)を呼び、
 *      - shadow側(B1書込み)の候補情報が引き続き正しく読めること
 *      - real側(今回の実採否)がACCEPTED/REJECTEDとして正しく反映されていること
 *      - ACCEPTした候補はresponsibilityIdが実際に生成されたResponsibility.idと一致すること
 *      - REJECTした候補はresponsibilityIdがnullのままであること
 *      を実DB/実APIで確認する。
 *   4. dual-read APIを呼んだこと自体がFormationSession.state・
 *      FormationCandidateDecisionEventに一切書込みを行っていない(=読み取り専用)
 *      ことを、呼び出し前後のDB実測値の差分ゼロで確認する。
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_m1b2_dual_read_acceptance.ts
 *
 * 前提: ismay-app.serviceが起動済みで、in-process AI Worker(5秒tick)が動いていること。
 * 有効なAIプロバイダー設定(admin/ai-providers)が必要(実際にAnthropic APIを呼び出す)。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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

// eslint-disable-next-line prefer-const
let db: typeof import("../app/src/lib/db")["db"];

const BASE_URL = process.env.BASE_URL ?? "http://localhost:13000";
const RUN_ID = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const EMAIL_PREFIX = "gate-m1b2-dualread-verify-";
const TEST_EMAIL = `${EMAIL_PREFIX}${RUN_ID}@example.invalid`;
const TEST_PASSWORD = `GateM1B2!${RUN_ID}A1`;

// 2件の明確に分離できるタスク(1件ACCEPT、1件REJECTするため最低2候補必要)。
const RAW_TEXT =
  "来週火曜までに月次レポートを作成して提出する。\n" +
  "田中さんに見積書のレビューを依頼する。";

type CookieJar = Record<string, string>;

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

function parseSetCookies(res: Response, jar: CookieJar): void {
  const raw = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  for (const line of raw) {
    const [pair] = line.split(";");
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
}

function cookieHeader(jar: CookieJar): string {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
}

async function api(
  jar: CookieJar,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (jar["ismay_csrf"]) headers["x-csrf-token"] = jar["ismay_csrf"];
  if (Object.keys(jar).length > 0) headers["Cookie"] = cookieHeader(jar);
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  parseSetCookies(res, jar);
  const text = await res.text().catch(() => "");
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

async function registerAndLogin(email: string, password: string): Promise<{ jar: CookieJar; userId: string }> {
  const jar: CookieJar = {};
  const reg = await api(jar, "POST", "/api/v1/auth/register", { email, password, displayName: "Gate M1B2 DualRead Verify" });
  if (reg.status !== 200 && reg.status !== 201) throw new Error(`登録失敗: ${JSON.stringify(reg.json)}`);
  const login = await api(jar, "POST", "/api/v1/auth/login", { email, password });
  if (login.status !== 200) throw new Error(`ログイン失敗: ${JSON.stringify(login.json)}`);
  return { jar, userId: login.json.data.user.id };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cleanupTestUser(userId: string, workspaceId: string | null): Promise<void> {
  if (workspaceId) {
    const captures = await db.capture.findMany({ where: { workspaceId }, select: { id: true } }).catch(() => [] as { id: string }[]);
    const captureIds = captures.map((c: { id: string }) => c.id);
    if (captureIds.length > 0) {
      const sessions = await db.formationSession.findMany({ where: { captureId: { in: captureIds } }, select: { id: true } }).catch(() => [] as { id: string }[]);
      const sessionIds = sessions.map((s: { id: string }) => s.id);
      if (sessionIds.length > 0) {
        const candidates = await db.formationCandidateIdentity.findMany({ where: { sessionId: { in: sessionIds } }, select: { id: true } }).catch(() => [] as { id: string }[]);
        const candidateIds = candidates.map((c: { id: string }) => c.id);
        if (candidateIds.length > 0) {
          const revisions = await db.formationCandidateRevision.findMany({ where: { candidateId: { in: candidateIds } }, select: { id: true } }).catch(() => [] as { id: string }[]);
          const revisionIds = revisions.map((r: { id: string }) => r.id);
          if (revisionIds.length > 0) {
            await db.formationSourceAnchor.deleteMany({ where: { revisionId: { in: revisionIds } } }).catch(() => null);
            await db.formationCandidateDecisionEvent.deleteMany({ where: { revisionId: { in: revisionIds } } }).catch(() => null);
          }
          await db.formationCandidateRevision.deleteMany({ where: { candidateId: { in: candidateIds } } }).catch(() => null);
          await db.formationCandidateDecisionEvent.deleteMany({ where: { candidateId: { in: candidateIds } } }).catch(() => null);
        }
        const questions = await db.formationQuestion.findMany({ where: { sessionId: { in: sessionIds } }, select: { id: true } }).catch(() => [] as { id: string }[]);
        const questionIds = questions.map((q: { id: string }) => q.id);
        if (questionIds.length > 0) {
          await db.formationAnswerEvent.deleteMany({ where: { questionId: { in: questionIds } } }).catch(() => null);
        }
        await db.formationQuestion.deleteMany({ where: { sessionId: { in: sessionIds } } }).catch(() => null);
        await db.formationCandidateIdentity.deleteMany({ where: { sessionId: { in: sessionIds } } }).catch(() => null);
        await db.materializationReceiptItem.deleteMany({ where: { receipt: { sessionId: { in: sessionIds } } } }).catch(() => null);
        await db.materializationReceipt.deleteMany({ where: { sessionId: { in: sessionIds } } }).catch(() => null);
        await db.formationSessionEvent.deleteMany({ where: { sessionId: { in: sessionIds } } }).catch(() => null);
        await db.formationSession.deleteMany({ where: { id: { in: sessionIds } } }).catch(() => null);
      }
      await db.responsibility.deleteMany({ where: { workspaceId, originCaptureId: { in: captureIds } } }).catch(() => null);
      await db.aiInference.deleteMany({ where: { captureId: { in: captureIds } } }).catch(() => null);
      await db.aiRun.deleteMany({ where: { captureId: { in: captureIds } } }).catch(() => null);
      await db.eventLog.deleteMany({ where: { aggregateId: { in: captureIds } } }).catch(() => null);
      await db.outboxEvent.deleteMany({ where: { aggregateId: { in: captureIds } } }).catch(() => null);
      for (const cid of captureIds) {
        await db.job.deleteMany({ where: { payload: { path: ["captureId"], equals: cid } } }).catch(() => null);
      }
      await db.capture.deleteMany({ where: { id: { in: captureIds } } }).catch(() => null);
    }
  }
  await db.workspaceMember.deleteMany({ where: { userId } }).catch(() => null);
  if (workspaceId) await db.workspace.deleteMany({ where: { id: workspaceId } }).catch(() => null);
  await db.userSession.deleteMany({ where: { userId } }).catch(() => null);
  await db.user.deleteMany({ where: { id: userId } }).catch(() => null);
}

async function sweepOrphans(): Promise<void> {
  const orphans = await db.user.findMany({
    where: { email: { startsWith: EMAIL_PREFIX, endsWith: "@example.invalid" } },
    select: { id: true },
  });
  if (orphans.length === 0) return;
  console.log(`[SWEEP] 過去実行の孤立テストユーザー${orphans.length}件を削除します...`);
  for (const o of orphans) {
    const membership = await db.workspaceMember.findFirst({ where: { userId: o.id }, select: { workspaceId: true } });
    await cleanupTestUser(o.id, membership?.workspaceId ?? null);
  }
}

async function main(): Promise<void> {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  loadDotEnv(join(scriptDir, "..", "app", ".env"));
  ({ db } = await import("../app/src/lib/db"));

  await sweepOrphans();
  console.log(`Gate M1-B「B2: dual-read」Acceptance Evidence (BASE_URL=${BASE_URL})`);
  console.log(`テスト専用ユーザー: ${TEST_EMAIL}`);
  console.log("[注意] このスクリプトは実際にAnthropic APIを呼び出します(トークン課金が発生します)。");

  let userId: string | null = null;
  let workspaceId: string | null = null;
  let otherUserId: string | null = null;
  let otherWorkspaceId: string | null = null;

  try {
    const { jar, userId: uid } = await registerAndLogin(TEST_EMAIL, TEST_PASSWORD);
    userId = uid;
    const warmup = await api(jar, "GET", "/api/v1/captures");
    if (warmup.status !== 200) throw new Error(`ウォームアップ失敗: status=${warmup.status}`);
    const membership = await db.workspaceMember.findFirst({ where: { userId } });
    workspaceId = membership?.workspaceId ?? null;
    if (!workspaceId) throw new Error("Workspaceを特定できませんでした");

    const createRes = await api(jar, "POST", "/api/v1/captures", {
      sourceType: "TEXT",
      rawText: RAW_TEXT,
      clientDraftId: `gate-m1b2-dualread-${RUN_ID}`,
    });
    if (createRes.status !== 201 && createRes.status !== 200) throw new Error(`Capture作成失敗: ${JSON.stringify(createRes.json)}`);
    const captureId: string = createRes.json.data.id;
    console.log(`Capture作成: ${captureId}`);

    const analyzeRes = await api(jar, "POST", `/api/v1/captures/${captureId}/analyze`);
    if (analyzeRes.status !== 200) throw new Error(`解析要求失敗: ${JSON.stringify(analyzeRes.json)}`);

    console.log("AI解析の完了をポーリング中(最大60秒)...");
    let finalStatus: string | null = null;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      await sleep(2000);
      const capture = await db.capture.findUnique({ where: { id: captureId }, select: { processingStatus: true } });
      if (capture && (capture.processingStatus === "READY" || capture.processingStatus === "FAILED")) {
        finalStatus = capture.processingStatus;
        break;
      }
    }
    if (!finalStatus) throw new Error("60秒以内にAI解析が完了しませんでした(タイムアウト)");
    console.log(`AI解析完了: processingStatus=${finalStatus}`);

    const aiRun = await db.aiRun.findFirst({ where: { captureId }, orderBy: { finishedAt: "desc" } });
    if (!aiRun) throw new Error("AiRunが1件も作成されていません");
    const aiInferences = await db.aiInference.findMany({ where: { captureId, aiRunId: aiRun.id }, orderBy: { createdAt: "asc" } });
    ok("0. 候補が2件以上ある(ACCEPT/REJECTを両方試すため)", aiInferences.length >= 2, `count=${aiInferences.length}`);
    if (aiInferences.length < 2) throw new Error("候補数不足のため以降のACCEPT/REJECT検証を中止します");

    const clientSessionKey = `shadow:${aiRun.id}`;
    const session = await db.formationSession.findFirst({ where: { captureId, clientSessionKey } });
    if (!session) throw new Error("shadow FormationSessionが見つかりません(B1の前提が崩れています)");

    // ==== dual-read呼び出し前のDB状態を記録(読み取り専用であることの検証用) ====
    const beforeSession = await db.formationSession.findUnique({ where: { id: session.id } });
    const beforeDecisionEventCount = await db.formationCandidateDecisionEvent.count({ where: { candidate: { sessionId: session.id } } });

    // ==== dual-read(採否操作より前): shadowのみ・realは全てPENDING(null的な扱い) ====
    const dualReadBefore = await api(jar, "GET", `/api/v1/formation-sessions/${session.id}/dual-read`);
    ok("1. dual-read APIが200を返す(採否前)", dualReadBefore.status === 200, `status=${dualReadBefore.status}`);
    const projectionBefore = dualReadBefore.json?.data?.dualRead;
    ok("2. dual-read.aiRunIdがAiRun.idと一致", projectionBefore?.aiRunId === aiRun.id, `actual=${projectionBefore?.aiRunId}`);
    ok(
      "3. dual-read.candidates件数がAiInference件数と一致(採否前)",
      Array.isArray(projectionBefore?.candidates) && projectionBefore.candidates.length === aiInferences.length,
      `actual=${projectionBefore?.candidates?.length}`,
    );
    const allPendingBefore = (projectionBefore?.candidates ?? []).every(
      (c: { real: { decision: string } | null }) => c.real?.decision === "PENDING",
    );
    ok("4. 採否前は全候補のreal.decision=PENDING", allPendingBefore);

    // ==== 実際に1件ACCEPT、1件REJECT(既存route、B2で無変更) ====
    const acceptTarget = aiInferences[0];
    const rejectTarget = aiInferences[1];

    const acceptRes = await api(jar, "POST", `/api/v1/inferences/${acceptTarget.id}/decision`, {
      decision: "ACCEPT",
      expectedInferenceVersion: acceptTarget.version,
    });
    ok("5. ACCEPT操作が201/200を返す", acceptRes.status === 201 || acceptRes.status === 200, `status=${acceptRes.status} body=${JSON.stringify(acceptRes.json)}`);
    const acceptedResponsibilityId: string | null = acceptRes.json?.data?.responsibilityId ?? null;
    ok("6. ACCEPT操作でresponsibilityIdが返る", typeof acceptedResponsibilityId === "string" && acceptedResponsibilityId.length > 0);

    const rejectRes = await api(jar, "POST", `/api/v1/inferences/${rejectTarget.id}/decision`, {
      decision: "REJECT",
      expectedInferenceVersion: rejectTarget.version,
    });
    ok("7. REJECT操作が200を返す", rejectRes.status === 200, `status=${rejectRes.status} body=${JSON.stringify(rejectRes.json)}`);

    // ==== dual-read(採否操作より後) ====
    const dualReadAfter = await api(jar, "GET", `/api/v1/formation-sessions/${session.id}/dual-read`);
    ok("8. dual-read APIが200を返す(採否後)", dualReadAfter.status === 200, `status=${dualReadAfter.status}`);
    const projectionAfter = dualReadAfter.json?.data?.dualRead;

    const acceptedPayload = ResponsibilityCandidateIdFromInference(acceptTarget);
    const rejectedPayload = ResponsibilityCandidateIdFromInference(rejectTarget);

    const acceptedCandidate = (projectionAfter?.candidates ?? []).find(
      (c: { candidateKey: string }) => c.candidateKey === acceptedPayload,
    );
    const rejectedCandidate = (projectionAfter?.candidates ?? []).find(
      (c: { candidateKey: string }) => c.candidateKey === rejectedPayload,
    );

    ok("9. dual-readでACCEPTした候補のreal.decision=ACCEPTED", acceptedCandidate?.real?.decision === "ACCEPTED", `actual=${acceptedCandidate?.real?.decision}`);
    ok(
      "10. dual-readでACCEPTした候補のreal.responsibilityIdが実際に生成されたResponsibility.idと一致",
      acceptedCandidate?.real?.responsibilityId === acceptedResponsibilityId,
      `actual=${acceptedCandidate?.real?.responsibilityId} expected=${acceptedResponsibilityId}`,
    );
    ok("11. dual-readでACCEPTした候補のshadow情報(type/title)がB1書込み時点のまま読める", !!acceptedCandidate?.shadow?.type && !!acceptedCandidate?.shadow?.title);

    ok("12. dual-readでREJECTした候補のreal.decision=REJECTED", rejectedCandidate?.real?.decision === "REJECTED", `actual=${rejectedCandidate?.real?.decision}`);
    ok("13. dual-readでREJECTした候補のreal.responsibilityId=null", rejectedCandidate?.real?.responsibilityId === null);

    ok("14. dual-read.unmatchedInferenceIdsが空(shadow書込みの取りこぼし無し)", Array.isArray(projectionAfter?.unmatchedInferenceIds) && projectionAfter.unmatchedInferenceIds.length === 0, `actual=${JSON.stringify(projectionAfter?.unmatchedInferenceIds)}`);

    // ==== dual-read呼び出しが読み取り専用であることの検証(呼び出し前後でDB実測値が不変) ====
    const afterSession = await db.formationSession.findUnique({ where: { id: session.id } });
    const afterDecisionEventCount = await db.formationCandidateDecisionEvent.count({ where: { candidate: { sessionId: session.id } } });
    ok(
      "15. dual-read呼び出し自体はFormationSession.state/versionを変更していない(採否操作起因の変化を除く)",
      afterSession?.state === beforeSession?.state && afterSession?.version === beforeSession?.version,
      `before=${beforeSession?.state}/${beforeSession?.version} after=${afterSession?.state}/${afterSession?.version}`,
    );
    ok(
      "16. dual-read呼び出し自体はFormationCandidateDecisionEventを一切生成していない(B3実装まで0件のはず)",
      afterDecisionEventCount === beforeDecisionEventCount && afterDecisionEventCount === 0,
      `before=${beforeDecisionEventCount} after=${afterDecisionEventCount}`,
    );

    // ==== 他Workspaceからのdual-read参照が404になること(IDOR対策) ====
    const { jar: otherJar, userId: otherUid } = await registerAndLogin(`${EMAIL_PREFIX}other-${RUN_ID}@example.invalid`, TEST_PASSWORD);
    otherUserId = otherUid;
    const otherWarmup = await api(otherJar, "GET", "/api/v1/captures");
    if (otherWarmup.status === 200) {
      const otherMembership = await db.workspaceMember.findFirst({ where: { userId: otherUserId } });
      otherWorkspaceId = otherMembership?.workspaceId ?? null;
      const otherRes = await api(otherJar, "GET", `/api/v1/formation-sessions/${session.id}/dual-read`);
      ok("17. 他WorkspaceユーザーはRESOURCE_NOT_FOUND(404)になる(IDOR対策)", otherRes.status === 404, `status=${otherRes.status}`);
    }
  } catch (err) {
    failed++;
    failures.push(`予期しない例外: ${err instanceof Error ? err.message : String(err)}`);
    console.error(err);
  } finally {
    console.log("\n[CLEANUP] テストデータを削除します...");
    if (userId) await cleanupTestUser(userId, workspaceId);
    if (otherUserId) await cleanupTestUser(otherUserId, otherWorkspaceId);
    console.log("[CLEANUP] 完了。");
  }

  console.log(`\n合計: ${passed}件成功 / ${failed}件失敗`);
  if (failed > 0) {
    console.log("\n失敗した項目:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }

  console.log("\n=== Gate M1-B「B2: dual-read」Evidence ===");
  console.log(`日時: ${new Date().toISOString()}`);
  console.log("結論: DOC-03 10章のB2スコープ(既存Inference decisionとの並行読み)は、");
  console.log("実際の採否操作(既存/inferences/[id]/decision、無変更)に対して正しく");
  console.log("dual-read APIから読めること、かつdual-read自体が一切書込みを行わない");
  console.log("読み取り専用であることを実DB/実APIで確認した。");
  console.log("EV-F-001〜008(Gate M1-B本体)は引き続き未検証(B3でMaterialize serviceへ");
  console.log("single-writeしてから改めて証跡を取得する)。");
}

function ResponsibilityCandidateIdFromInference(inference: { payload: unknown }): string | undefined {
  const payload = inference.payload as { candidateId?: string } | null;
  return payload?.candidateId;
}

main();
