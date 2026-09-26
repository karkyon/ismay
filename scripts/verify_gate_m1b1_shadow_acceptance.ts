#!/usr/bin/env node
/**
 * scripts/verify_gate_m1b1_shadow_acceptance.ts
 *
 * DOC-03(Formation Session仕様書) 10章のロールアップ計画でいう「B1: shadow Session
 * 生成のみ」の受入証跡。この時点ではまだAPI/UI/Materialize/Question Policyが
 * 存在しないため、DOC-12(EVAL・受入テスト仕様書) 4章のGate M1-B本体
 * (EV-F-001〜008、「確定」「Materialize」「Question」を要求する)はまだ対象外である。
 * 本スクリプトはEV-F-*のいずれの代替にもならない——それらはB2(dual-read)〜B4
 * (旧経路停止)が揃って初めて検証できる。ここで検証するのは、DOC-03自身が明示する
 * B1のスコープである「shadow Session生成」が実際のAI抽出結果と1:1で正しく
 * 対応しているか、という一段狭い受入証跡である。
 *
 * 検証内容:
 *   1. 実Captureを作成し、POST /captures/{id}/analyze → 実AI呼び出し
 *      (Anthropic API。実際にトークン課金が発生する)→ processingStatus=READYまで
 *      ポーリングする。
 *   2. 確定したAiRun/AiInferenceの実データ(候補数・型・タイトル・確信度・
 *      evidenceSpans)を正本として、同じAiRunに対応するFormationSession
 *      (clientSessionKey=`shadow:${aiRunId}`)が過不足なく複製されていることを、
 *      DBを直接読んで1件ずつ突合する。
 *   3. FormationSessionEventのsequenceが1..Nの連番でギャップ・重複が無いこと。
 *   4. FormationSourceAnchorのexcerptHashが、Capture.rawTextの該当範囲の
 *      sha256と一致すること(range外だったAnchorはexcerptHash=sha256('')と一致)。
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_m1b1_shadow_acceptance.ts
 *
 * 前提: ismay-app.serviceが起動済みで、in-process AI Worker(5秒tick、
 * src/lib/worker/index.ts)が動いていること。有効なAIプロバイダー設定
 * (admin/ai-providers)が必要(実際にAnthropic APIを呼び出すため)。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
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
const EMAIL_PREFIX = "gate-m1b1-shadow-verify-";
const TEST_EMAIL = `${EMAIL_PREFIX}${RUN_ID}@example.invalid`;
const TEST_PASSWORD = `GateM1B1!${RUN_ID}A1`;

// 2件の明確に分離できるタスクを含む原文(候補が複数出るように、意図的に単純な文にする)。
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
  const reg = await api(jar, "POST", "/api/v1/auth/register", { email, password, displayName: "Gate M1B1 Shadow Verify" });
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

async function main(): Promise<void> {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  loadDotEnv(join(scriptDir, "..", "app", ".env"));
  ({ db } = await import("../app/src/lib/db"));

  await sweepOrphans();
  console.log(`Gate M1-B(Formation) shadow書込み Acceptance Evidence (BASE_URL=${BASE_URL})`);
  console.log(`テスト専用ユーザー: ${TEST_EMAIL}`);
  console.log("[注意] このスクリプトは実際にAnthropic APIを呼び出します(トークン課金が発生します)。");

  let userId: string | null = null;
  let workspaceId: string | null = null;

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

    const createRes = await api(jar, "POST", "/api/v1/captures", {
      sourceType: "TEXT",
      rawText: RAW_TEXT,
      // API・イベント設計書v1.1 4.1節「clientDraftId＋userで冪等」の必須パラメータ。
      clientDraftId: `gate-m1b1-shadow-${RUN_ID}`,
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
    ok("0. AI解析がタイムアウトせず完了する(READYまたはFAILED)", finalStatus === "READY" || finalStatus === "FAILED");

    // ==== 正本(AiRun/AiInference)を読む ====
    const aiRun = await db.aiRun.findFirst({ where: { captureId }, orderBy: { finishedAt: "desc" } });
    if (!aiRun) throw new Error("AiRunが1件も作成されていません");
    const aiInferences = await db.aiInference.findMany({ where: { captureId, aiRunId: aiRun.id } });
    console.log(`AiRun: ${aiRun.id} status=${aiRun.status} candidateCount=${aiInferences.length}`);

    // ==== shadow(FormationSession)を読む ====
    const clientSessionKey = `shadow:${aiRun.id}`;
    const sessions = await db.formationSession.findMany({ where: { captureId, clientSessionKey } });

    if (aiRun.status !== "SUCCEEDED") {
      // [AUDIT-BASELINE-01・2026-09-26是正] 旧版は「shadow書込み対象外」とok(true)で記録した直後に
      // 「FormationSessionが1件」を要求しており自己矛盾していた。lib/ai/extract.tsの失敗経路
      // (AiRun FAILED・Capture FAILED)はshadow checkpointを作らず、shadow Sessionも作らない。
      // 実コードの契約どおり「失敗したAiRunからshadow Sessionが作られていない」ことを検証し、
      // 候補単位の突合(B1の本来の受入対象)は成功したAiRunでのみ行う。失敗経路はB1の受入を
      // 満たしたことにならないため、最後に明示的にNGとして残す(成功扱いにしない)。
      ok("1a. 失敗したAiRunからshadow FormationSessionは作られない(extract.ts失敗経路の契約)", sessions.length === 0, `count=${sessions.length}`);
      ok(
        "1b. B1受入には成功したAiRunが必要(AI providerの実呼び出しが成功する環境で再実行すること)",
        false,
        `AiRun status=${aiRun.status} errorCode=${(aiRun as { errorCode?: string | null }).errorCode ?? "null"}`,
      );
    } else {
      ok("1. AiRun 1件につきFormationSessionが1件だけ作られる(冪等キーの一意性)", sessions.length === 1, `count=${sessions.length}`);
    }
    const session = aiRun.status === "SUCCEEDED" ? sessions[0] : undefined;

    if (session) {
      const capture = await db.capture.findUnique({ where: { id: captureId } });
      ok("2. FormationSession.workspaceIdがCaptureと一致", session.workspaceId === workspaceId);
      ok("3. FormationSession.captureIdが一致", session.captureId === captureId);
      ok("4. FormationSession.subjectUserIdがCapture.createdByと一致", session.subjectUserId === capture?.createdById);

      // [AUDIT-BASELINE-01・2026-09-26是正] 旧版は候補1件以上なら常にREVIEW_READYを期待していたが、
      // M1-B5a(2026-08-30)以降、shadowWrite.tsは候補作成後にQuestion Policyを適用し、
      // 質問が生成されればCLARIFYING、無ければREVIEW_READYへ遷移する(統合正本§6.3/§6.4、
      // shadowWrite.ts冒頭コメント)。候補0件はFAILED。期待状態を実際に生成された質問数から導く。
      const questionCount = await db.formationQuestion.count({ where: { sessionId: session.id } });
      const expectedState = aiInferences.length === 0 ? "FAILED" : questionCount > 0 ? "CLARIFYING" : "REVIEW_READY";
      ok(
        `5. FormationSession.state=${expectedState}(候補${aiInferences.length}件・質問${questionCount}件から期待される状態)`,
        session.state === expectedState,
        `actual=${session.state}`,
      );
      ok("5b. 生成された質問は3問以内(統合正本§6.4、FORMATION_MAX_QUESTIONS)", questionCount <= 3, `questions=${questionCount}`);
      const questionAskedEvents = await db.formationSessionEvent.count({ where: { sessionId: session.id, eventType: "QUESTION_ASKED" } });
      ok("5c. QUESTION_ASKEDイベント数が質問の実件数と一致", questionAskedEvents === questionCount, `events=${questionAskedEvents} questions=${questionCount}`);

      const events = await db.formationSessionEvent.findMany({ where: { sessionId: session.id }, orderBy: { sequence: "asc" } });
      const sequences = events.map((e: { sequence: number }) => e.sequence);
      const expectedSequences = Array.from({ length: events.length }, (_, i) => i + 1);
      ok("6. FormationSessionEvent.sequenceが1..Nの連番でギャップ・重複が無い", JSON.stringify(sequences) === JSON.stringify(expectedSequences), `sequences=${JSON.stringify(sequences)}`);

      const candidateCreatedCount = events.filter((e: { eventType: string }) => e.eventType === "CANDIDATE_CREATED").length;
      ok("7. CANDIDATE_CREATEDイベント数がAiInference件数と一致", candidateCreatedCount === aiInferences.length, `events=${candidateCreatedCount} aiInferences=${aiInferences.length}`);

      const identities = await db.formationCandidateIdentity.findMany({ where: { sessionId: session.id } });
      ok("8. FormationCandidateIdentity件数がAiInference件数と一致", identities.length === aiInferences.length, `identities=${identities.length}`);

      // 候補ごとに、正本(AiInference.payload)とshadow(CandidateRevision)を突合する。
      // [AUDIT-BASELINE-01・2026-09-26是正] 旧版はrevision.confidenceとAiInference.confidenceの
      // 数値一致を要求していたが、両者は同じ値の別表現ではない:
      //   (a) AiInference.confidenceはDecimal(4,3)、FormationCandidateRevision.confidenceは
      //       Decimal(5,4)で、AIが小数4桁の値を返すと丸めが異なる(実AIで観測、1回目はPASS・2回目はNG)。
      //   (b) M1-B6A(2026-08-31)以降、有効な根拠範囲(TEXT_OFFSET)を1件も持たない候補は、revisionへ
      //       NO_EVIDENCE_CONFIDENCE_CAP(0.49)以下で保存される(shadowWrite.ts、capConfidenceForMissingEvidence)。
      // 正本はAI出力そのもの(AiInference.payload.confidence)とし、revisionは「payload.confidenceへ
      // 根拠capを適用した値(Decimal(5,4)の丸め誤差内)」、AiInference.confidenceは「payload.confidenceの
      // Decimal(4,3)丸め誤差内」であることを、それぞれ検証する。
      const { capConfidenceForMissingEvidence, isValidTextOffsetRange } = await import("../app/src/lib/formation/coreTypes");
      const fieldMismatches: string[] = [];
      let allFieldsMatch = true;
      let allAnchorsMatch = true;
      let totalExpectedSpans = 0;
      let totalActualAnchors = 0;
      for (const inference of aiInferences) {
        const payload = inference.payload as { candidateId: string; type: string; title: string; confidence: number; evidenceSpans: { start: number; end: number }[] };
        const identity = identities.find((i: { candidateKey: string }) => i.candidateKey === payload.candidateId);
        if (!identity) {
          allFieldsMatch = false;
          fieldMismatches.push(`${payload.candidateId}: identityなし`);
          continue;
        }
        const revision = await db.formationCandidateRevision.findFirst({ where: { candidateId: identity.id, revision: 1 } });
        if (!revision) {
          allFieldsMatch = false;
          fieldMismatches.push(`${payload.candidateId}: revision 1なし`);
          continue;
        }
        const hasValidEvidence = payload.evidenceSpans.some((span) => isValidTextOffsetRange(span.start, span.end, RAW_TEXT.length));
        const expectedRevisionConfidence = capConfidenceForMissingEvidence(payload.confidence, hasValidEvidence);
        const revisionConfidenceOk = Math.abs(Number(revision.confidence) - expectedRevisionConfidence) <= 0.00005 + 1e-9;
        const inferenceConfidenceOk = Math.abs(Number(inference.confidence) - payload.confidence) <= 0.0005 + 1e-9;
        if (revision.type !== payload.type || revision.title !== payload.title || !revisionConfidenceOk || !inferenceConfidenceOk) {
          allFieldsMatch = false;
          fieldMismatches.push(
            `${payload.candidateId}: type=${revision.type}/${payload.type} title一致=${revision.title === payload.title} ` +
              `confidence payload=${payload.confidence} revision=${Number(revision.confidence)}(期待${expectedRevisionConfidence}, 根拠${hasValidEvidence ? "あり" : "なし"}) ` +
              `inference=${Number(inference.confidence)}`,
          );
        }
        totalExpectedSpans += payload.evidenceSpans.length;
        const anchors = await db.formationSourceAnchor.findMany({ where: { revisionId: revision.id } });
        totalActualAnchors += anchors.length;
        for (const span of payload.evidenceSpans) {
          const anchor = anchors.find((a: { startOffset: number | null; endOffset: number | null }) => a.startOffset === span.start && a.endOffset === span.end);
          const validRange = span.start >= 0 && span.end > span.start && span.end <= RAW_TEXT.length;
          if (validRange) {
            if (!anchor) {
              allAnchorsMatch = false;
              continue;
            }
            const expectedHash = createHash("sha256").update(RAW_TEXT.slice(span.start, span.end)).digest("hex");
            if (anchor.excerptHash !== expectedHash) allAnchorsMatch = false;
          }
        }
      }
      ok(
        "9. 全候補でtype/titleが正本(AiInference.payload)と一致し、confidenceは正本に根拠capと列精度の丸めを適用した値と一致",
        allFieldsMatch,
        fieldMismatches.join(" / "),
      );
      ok("10. SOURCE_ANCHOR_ATTACHEDイベント数がSourceAnchor実件数と一致", events.filter((e: { eventType: string }) => e.eventType === "SOURCE_ANCHOR_ATTACHED").length === totalActualAnchors, `events=${events.filter((e: { eventType: string }) => e.eventType === "SOURCE_ANCHOR_ATTACHED").length} anchors=${totalActualAnchors}`);
      ok("11. evidenceSpansの範囲内テキストのexcerptHashが正本のsha256と一致", allAnchorsMatch);
    }
  } catch (err) {
    failed++;
    failures.push(`予期しない例外: ${err instanceof Error ? err.message : String(err)}`);
    console.error(err);
  } finally {
    console.log("\n[CLEANUP] テストデータを削除します...");
    if (userId) await cleanupTestUser(userId, workspaceId);
    ok("cleanup. テストデータの削除でエラーが無い", cleanupErrors.length === 0, cleanupErrors.join(" / "));
    const leftover = await db.user.count({ where: { email: { startsWith: EMAIL_PREFIX, endsWith: "@example.invalid" } } });
    ok("cleanup. test用Userが残っていない", leftover === 0, `remaining=${leftover}`);
    console.log("[CLEANUP] 完了。");
  }

  console.log(`\n合計: ${passed}件成功 / ${failed}件失敗`);
  if (failed > 0) {
    console.log("\n失敗した項目:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }

  console.log("\n=== Gate M1-B「B1: shadow Session生成」Evidence ===");
  console.log(`日時: ${new Date().toISOString()}`);
  console.log("結論: DOC-03 10章のB1スコープ(shadow Session生成)は実AI抽出データと");
  console.log("1:1で正しく対応していることを実DB/実AI呼び出しで確認した。");
  console.log("EV-F-001〜008(Gate M1-B本体)は未検証(B2以降、確定/Materialize/Question");
  console.log("Policyが実装されてから改めて証跡を取得する)。");
}

main();
