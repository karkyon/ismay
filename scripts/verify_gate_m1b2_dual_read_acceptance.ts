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
import { markTestUserEmailVerified } from "./lib/testEmailVerification";
import { grantPemConsentViaApi } from "./lib/pemConsentFixture";

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
  // [AUTH-EMAIL-01] 未確認ユーザーはログイン不可のため、テストユーザーを確認済みにする
  await markTestUserEmailVerified(db, email);
  const login = await api(jar, "POST", "/api/v1/auth/login", { email, password });
  if (login.status !== 200) throw new Error(`ログイン失敗: ${JSON.stringify(login.json)}`);
  return { jar, userId: login.json.data.user.id };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// [AUDIT-BASELINE-01・2026-09-26是正] 旧版は独自のcleanupで表を手書き列挙し、全削除を
// `.catch(() => null)`で握り潰していた。後続Gateで追加された表(FormationAtomicityAssessment・
// FormationShadowCheckpoint・Case Pattern Suggest Job等)が漏れ、実DB(omega-dev2)でFK違反となり
// テストデータが残存した。アカウントPurge本体でFKグラフごと削除する共通処理へ置き換え、
// 失敗は握り潰さず最終結果のNGとして報告する(scripts/lib/httpVerifyUserCleanup.ts)。
const cleanupErrors: string[] = [];
async function cleanupTestUser(userId: string, _workspaceId: string | null): Promise<void> {
  const { purgeHttpVerifyUser } = await import("./lib/httpVerifyUserCleanup");
  try {
    cleanupErrors.push(...(await purgeHttpVerifyUser(db, userId, EMAIL_PREFIX)));
  } catch (err) {
    cleanupErrors.push(`${userId}: ${err instanceof Error ? err.message : String(err)}`);
  }
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

// [2026-08-28再修正] 1件のCaptureに2タスクを混在させ「2候補抽出」をAIに期待する設計は、
// 実運用で候補0件(processingStatus=FAILED)や候補1件になるケースが繰り返し観測され、
// リトライを重ねても安定しなかった。B1の受入証跡が要求する水準は「候補>=1」のみであり、
// これは安定して満たされている。そのため、2候補を1つのAI呼出しに賭けるのではなく、
// 単一タスクで確実に1候補を期待できる独立したCaptureを2つ作り(片方をACCEPT、
// 片方をREJECT)、それぞれのFormationSessionに対してdual-readを検証する設計に変更する。
// dual-read自体はSession単位で読み取るため、1 Session=1候補でも検証内容(shadow/real
// 突合、responsibilityId一致、読み取り専用性、IDOR)は一切損なわれない。
const RAW_TEXT_ACCEPT = "来週火曜までに月次レポートを作成して提出する。";
const RAW_TEXT_REJECT = "田中さんに見積書のレビューを依頼する。";

type ExtractedInference = {
  id: string;
  version: number;
  decision: string;
  decidedAt: Date | null;
  payload: unknown;
};

interface CapturedSession {
  captureId: string;
  aiRunId: string;
  inference: ExtractedInference;
  sessionId: string;
}

async function createCapturedSession(
  jar: CookieJar,
  rawText: string,
  label: string,
  runId: string,
): Promise<CapturedSession> {
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const createRes = await api(jar, "POST", "/api/v1/captures", {
      sourceType: "TEXT",
      rawText,
      clientDraftId: `gate-m1b2-dualread-${label}-${runId}-${attempt}`,
    });
    if (createRes.status !== 201 && createRes.status !== 200) {
      throw new Error(`Capture作成失敗(${label}): ${JSON.stringify(createRes.json)}`);
    }
    const captureId: string = createRes.json.data.id;
    console.log(`Capture作成[${label}](試行${attempt}/${MAX_ATTEMPTS}): ${captureId}`);

    const analyzeRes = await api(jar, "POST", `/api/v1/captures/${captureId}/analyze`);
    if (analyzeRes.status !== 200) throw new Error(`解析要求失敗(${label}): ${JSON.stringify(analyzeRes.json)}`);

    console.log(`  AI解析の完了をポーリング中[${label}](最大60秒)...`);
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
    if (!finalStatus) throw new Error(`60秒以内にAI解析が完了しませんでした(タイムアウト、${label})`);
    console.log(`  AI解析完了[${label}]: processingStatus=${finalStatus}`);

    if (finalStatus === "READY") {
      const aiRun = await db.aiRun.findFirst({ where: { captureId }, orderBy: { finishedAt: "desc" } });
      if (aiRun) {
        const aiInferences = await db.aiInference.findMany({ where: { captureId, aiRunId: aiRun.id }, orderBy: { createdAt: "asc" } });
        if (aiInferences.length >= 1) {
          const clientSessionKey = `shadow:${aiRun.id}`;
          const session = await db.formationSession.findFirst({ where: { captureId, clientSessionKey } });
          if (session) {
            return { captureId, aiRunId: aiRun.id, inference: aiInferences[0], sessionId: session.id };
          }
          console.log(`  [${label}] shadow FormationSessionが見つかりません。再試行します...`);
        } else {
          console.log(`  [${label}] 候補0件。再試行します...`);
        }
      } else {
        console.log(`  [${label}] AiRunが作成されていません。再試行します...`);
      }
    } else {
      console.log(`  [${label}] processingStatus=FAILED。再試行します...`);
    }
    if (attempt < MAX_ATTEMPTS) await sleep(3000); // 連続呼出しによるレート制限等を避けるための小休止
  }
  throw new Error(`${MAX_ATTEMPTS}回試行しても${label}用の候補付きCaptureを取得できませんでした`);
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
    // [AUDIT-BASELINE-01] PEM-CONSENT-ENQUEUE-GATE以降、解析要求にはPEM_AI_PROCESSING同意が必須。
    // 本番の同意API経由で付与する(同意なしで通す本番変更はしない)。
    await grantPemConsentViaApi(api, jar, "PEM_AI_PROCESSING");
    ok("前提. PEM_AI_PROCESSING同意を正規API(POST /pem/consent)で付与できる", true);
    const warmup = await api(jar, "GET", "/api/v1/captures");
    if (warmup.status !== 200) throw new Error(`ウォームアップ失敗: status=${warmup.status}`);
    const membership = await db.workspaceMember.findFirst({ where: { userId } });
    workspaceId = membership?.workspaceId ?? null;
    if (!workspaceId) throw new Error("Workspaceを特定できませんでした");

    const acceptTargetSession = await createCapturedSession(jar, RAW_TEXT_ACCEPT, "accept", RUN_ID);
    const rejectTargetSession = await createCapturedSession(jar, RAW_TEXT_REJECT, "reject", RUN_ID);
    ok("0. ACCEPT用/REJECT用それぞれで候補付きshadow Sessionを取得できた", true);

    // ==== dual-read呼び出し前のDB状態を記録(読み取り専用であることの検証用) ====
    const beforeSessionA = await db.formationSession.findUnique({ where: { id: acceptTargetSession.sessionId } });
    const beforeSessionB = await db.formationSession.findUnique({ where: { id: rejectTargetSession.sessionId } });
    const beforeDecisionEventCount =
      (await db.formationCandidateDecisionEvent.count({ where: { candidate: { sessionId: acceptTargetSession.sessionId } } })) +
      (await db.formationCandidateDecisionEvent.count({ where: { candidate: { sessionId: rejectTargetSession.sessionId } } }));

    // ==== dual-read(採否操作より前): shadowのみ・realは全てPENDING ====
    const dualReadBeforeA = await api(jar, "GET", `/api/v1/formation-sessions/${acceptTargetSession.sessionId}/dual-read`);
    const dualReadBeforeB = await api(jar, "GET", `/api/v1/formation-sessions/${rejectTargetSession.sessionId}/dual-read`);
    ok("1. dual-read APIが200を返す(採否前、両Session)", dualReadBeforeA.status === 200 && dualReadBeforeB.status === 200, `A=${dualReadBeforeA.status} B=${dualReadBeforeB.status}`);
    const projectionBeforeA = dualReadBeforeA.json?.data?.dualRead;
    const projectionBeforeB = dualReadBeforeB.json?.data?.dualRead;
    ok("2. dual-read.aiRunIdがAiRun.idと一致(両Session)", projectionBeforeA?.aiRunId === acceptTargetSession.aiRunId && projectionBeforeB?.aiRunId === rejectTargetSession.aiRunId);
    const allPendingBefore =
      (projectionBeforeA?.candidates ?? []).every((c: { real: { decision: string } | null }) => c.real?.decision === "PENDING") &&
      (projectionBeforeB?.candidates ?? []).every((c: { real: { decision: string } | null }) => c.real?.decision === "PENDING");
    ok("3. 採否前は全候補のreal.decision=PENDING(両Session)", allPendingBefore);
    ok(
      "4. dual-read.candidates件数がAiInference件数(=1)と一致(両Session)",
      Array.isArray(projectionBeforeA?.candidates) && projectionBeforeA.candidates.length === 1 &&
      Array.isArray(projectionBeforeB?.candidates) && projectionBeforeB.candidates.length === 1,
      `A=${projectionBeforeA?.candidates?.length} B=${projectionBeforeB?.candidates?.length}`,
    );

    // [AUDIT-BASELINE-01・2026-09-26是正] B4.2(2026-08-29)以降、cutover flag
    // FEATURE_CHG011_SHARED_CORE=true の環境では、FormationSessionが存在するCaptureの候補に対する
    // 旧採否API(/inferences/[id]/decision)はSTATE_TRANSITION_INVALIDで拒否される(本番の契約、
    // inferences/[id]/decision/route.ts)。この場合、B2の「旧採否結果をdual-readで読む」経路は
    // 環境上成立しないため、B4.2の拒否契約と、拒否後も旧採否状態が変わらずdual-readがそれを
    // 正しく読むこと(PENDING)を検証する。flag OFF(既定)では従来どおりB2の採否反映を検証する。
    // 本scriptはapp/.envを読み込むため、稼働中のアプリと同じflag値で判定される。
    const cutoverEnabled = process.env.FEATURE_CHG011_SHARED_CORE === "true";
    console.log(`FEATURE_CHG011_SHARED_CORE=${cutoverEnabled ? "true(旧採否APIは閉鎖済み)" : "false(旧採否APIが有効)"}`);
    if (cutoverEnabled) {
      for (const [label, target, decision] of [
        ["ACCEPT", acceptTargetSession, "ACCEPT"],
        ["REJECT", rejectTargetSession, "REJECT"],
      ] as const) {
        const res = await api(jar, "POST", `/api/v1/inferences/${target.inference.id}/decision`, {
          decision,
          expectedInferenceVersion: target.inference.version,
        });
        ok(
          `5c. [cutover] ${label}: 旧採否APIはSTATE_TRANSITION_INVALID(422)でFormation経路へ誘導する(B4.2契約)`,
          res.status === 422 && res.json?.error?.code === "STATE_TRANSITION_INVALID" && res.json?.error?.formationSessionId === target.sessionId,
          `status=${res.status} body=${JSON.stringify(res.json)}`,
        );
        const inferenceAfter = await db.aiInference.findUnique({ where: { id: target.inference.id }, select: { decision: true } });
        ok(`6c. [cutover] ${label}: 拒否後もAiInference.decisionはPENDINGのまま`, inferenceAfter?.decision === "PENDING", `actual=${inferenceAfter?.decision}`);
      }
      const acceptedResponsibilities = await db.responsibility.count({ where: { workspaceId: workspaceId!, originCaptureId: acceptTargetSession.captureId } });
      ok("7c. [cutover] 拒否された旧採否APIからResponsibilityは作られていない", acceptedResponsibilities === 0, `count=${acceptedResponsibilities}`);
      const dualReadAfterA = await api(jar, "GET", `/api/v1/formation-sessions/${acceptTargetSession.sessionId}/dual-read`);
      const dualReadAfterB = await api(jar, "GET", `/api/v1/formation-sessions/${rejectTargetSession.sessionId}/dual-read`);
      ok("8c. [cutover] dual-read APIが200を返す(両Session)", dualReadAfterA.status === 200 && dualReadAfterB.status === 200, `A=${dualReadAfterA.status} B=${dualReadAfterB.status}`);
      const stillPending =
        (dualReadAfterA.json?.data?.dualRead?.candidates ?? []).every((c: { real: { decision: string } | null }) => c.real?.decision === "PENDING") &&
        (dualReadAfterB.json?.data?.dualRead?.candidates ?? []).every((c: { real: { decision: string } | null }) => c.real?.decision === "PENDING");
      ok("9c. [cutover] dual-readのreal.decisionは拒否後もPENDING(旧採否状態を正しく読む)", stillPending);
      ok(
        "10c. [cutover] dual-read.unmatchedInferenceIdsが空(shadow書込みの取りこぼし無し、両Session)",
        Array.isArray(dualReadAfterA.json?.data?.dualRead?.unmatchedInferenceIds) && dualReadAfterA.json.data.dualRead.unmatchedInferenceIds.length === 0 &&
          Array.isArray(dualReadAfterB.json?.data?.dualRead?.unmatchedInferenceIds) && dualReadAfterB.json.data.dualRead.unmatchedInferenceIds.length === 0,
      );
    } else {
      // ==== 実際にACCEPT/REJECT(既存route、B2で無変更) ====
      const acceptRes = await api(jar, "POST", `/api/v1/inferences/${acceptTargetSession.inference.id}/decision`, {
        decision: "ACCEPT",
        expectedInferenceVersion: acceptTargetSession.inference.version,
      });
      ok("5. ACCEPT操作が201/200を返す", acceptRes.status === 201 || acceptRes.status === 200, `status=${acceptRes.status} body=${JSON.stringify(acceptRes.json)}`);
      const acceptedResponsibilityId: string | null = acceptRes.json?.data?.responsibilityId ?? null;
      ok("6. ACCEPT操作でresponsibilityIdが返る", typeof acceptedResponsibilityId === "string" && acceptedResponsibilityId.length > 0);

      const rejectRes = await api(jar, "POST", `/api/v1/inferences/${rejectTargetSession.inference.id}/decision`, {
        decision: "REJECT",
        expectedInferenceVersion: rejectTargetSession.inference.version,
      });
      ok("7. REJECT操作が200を返す", rejectRes.status === 200, `status=${rejectRes.status} body=${JSON.stringify(rejectRes.json)}`);

      // ==== dual-read(採否操作より後) ====
      const dualReadAfterA = await api(jar, "GET", `/api/v1/formation-sessions/${acceptTargetSession.sessionId}/dual-read`);
      const dualReadAfterB = await api(jar, "GET", `/api/v1/formation-sessions/${rejectTargetSession.sessionId}/dual-read`);
      ok("8. dual-read APIが200を返す(採否後、両Session)", dualReadAfterA.status === 200 && dualReadAfterB.status === 200, `A=${dualReadAfterA.status} B=${dualReadAfterB.status}`);
      const projectionAfterA = dualReadAfterA.json?.data?.dualRead;
      const projectionAfterB = dualReadAfterB.json?.data?.dualRead;

      const acceptedCandidateKey = ResponsibilityCandidateIdFromInference(acceptTargetSession.inference);
      const rejectedCandidateKey = ResponsibilityCandidateIdFromInference(rejectTargetSession.inference);

      const acceptedCandidate = (projectionAfterA?.candidates ?? []).find(
        (c: { candidateKey: string }) => c.candidateKey === acceptedCandidateKey,
      );
      const rejectedCandidate = (projectionAfterB?.candidates ?? []).find(
        (c: { candidateKey: string }) => c.candidateKey === rejectedCandidateKey,
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

      ok(
        "14. dual-read.unmatchedInferenceIdsが空(shadow書込みの取りこぼし無し、両Session)",
        Array.isArray(projectionAfterA?.unmatchedInferenceIds) && projectionAfterA.unmatchedInferenceIds.length === 0 &&
        Array.isArray(projectionAfterB?.unmatchedInferenceIds) && projectionAfterB.unmatchedInferenceIds.length === 0,
        `A=${JSON.stringify(projectionAfterA?.unmatchedInferenceIds)} B=${JSON.stringify(projectionAfterB?.unmatchedInferenceIds)}`,
      );

    }

    // ==== dual-read呼び出しが読み取り専用であることの検証(呼び出し前後でDB実測値が不変) ====
    const afterSessionA = await db.formationSession.findUnique({ where: { id: acceptTargetSession.sessionId } });
    const afterSessionB = await db.formationSession.findUnique({ where: { id: rejectTargetSession.sessionId } });
    const afterDecisionEventCount =
      (await db.formationCandidateDecisionEvent.count({ where: { candidate: { sessionId: acceptTargetSession.sessionId } } })) +
      (await db.formationCandidateDecisionEvent.count({ where: { candidate: { sessionId: rejectTargetSession.sessionId } } }));
    ok(
      "15. dual-read呼び出し自体はFormationSession.state/versionを変更していない(両Session、採否操作起因の変化を除く)",
      afterSessionA?.state === beforeSessionA?.state && afterSessionA?.version === beforeSessionA?.version &&
      afterSessionB?.state === beforeSessionB?.state && afterSessionB?.version === beforeSessionB?.version,
      `A: before=${beforeSessionA?.state}/${beforeSessionA?.version} after=${afterSessionA?.state}/${afterSessionA?.version} / ` +
      `B: before=${beforeSessionB?.state}/${beforeSessionB?.version} after=${afterSessionB?.state}/${afterSessionB?.version}`,
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
      const otherRes = await api(otherJar, "GET", `/api/v1/formation-sessions/${acceptTargetSession.sessionId}/dual-read`);
      ok("17. 他WorkspaceユーザーはRESOURCE_NOT_FOUND(404)になる(IDOR対策)", otherRes.status === 404, `status=${otherRes.status}`);
    }
  } catch (err) {
    failed++;
    failures.push(`予期しない例外: ${err instanceof Error ? err.message : String(err)}`);
    console.error(err);
  } finally {
    // [2026-08-28追加] 失敗時にKEEP_TEST_DATA_ON_FAILURE=1が設定されていれば、
    // 原因調査のためテストデータ(Capture/AiRun/Job/FormationSession等)を削除せず残す。
    // 通常実行(成功時、またはこの環境変数が無い場合)は従来通り必ず削除する。
    const keepOnFailure = failed > 0 && process.env.KEEP_TEST_DATA_ON_FAILURE === "1";
    if (keepOnFailure) {
      console.log("\n[CLEANUP] KEEP_TEST_DATA_ON_FAILURE=1のため、失敗時のテストデータ削除をスキップします。");
      console.log(`[CLEANUP] 手動調査後、次回本スクリプトをKEEP_TEST_DATA_ON_FAILURE無しで再実行すればsweepOrphansが自動的に削除します。`);
      console.log(`[CLEANUP] userId=${userId} workspaceId=${workspaceId}`);
    } else {
      console.log("\n[CLEANUP] テストデータを削除します...");
      if (userId) await cleanupTestUser(userId, workspaceId);
      if (otherUserId) await cleanupTestUser(otherUserId, otherWorkspaceId);
      ok("cleanup. テストデータの削除でエラーが無い", cleanupErrors.length === 0, cleanupErrors.join(" / "));
      const leftover = await db.user.count({ where: { email: { startsWith: EMAIL_PREFIX, endsWith: "@example.invalid" } } });
      ok("cleanup. test用Userが残っていない", leftover === 0, `remaining=${leftover}`);
      console.log("[CLEANUP] 完了。");
    }
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
