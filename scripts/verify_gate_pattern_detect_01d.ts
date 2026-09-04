#!/usr/bin/env node
/**
 * scripts/verify_gate_pattern_detect_01d.ts
 *
 * PATTERN-DETECT-01D(Embedding・exact cosine matching)の実DB受入証跡。
 * 出典: Claude向け_ISMAY_0fcea2b以降_再監査是正・PATTERN-DETECT連続実装指示_2026-09-03.md
 * §6 PATTERN-DETECT-01D、§7 受入条件 PD-11/PD-14。
 *
 * candidate threshold(0.88)・ambiguity margin(0.03)の厳密な境界値検証は
 * src/lib/patterns/__tests__/casePatternMatching.test.ts(db非依存pure test、
 * float4丸め誤差の影響を受けない)で既に検証済みのため、このスクリプトは
 * DB/pgvector経由の統合的な挙動(current revisionのみ・owner分離・
 * model/dimensions/sourceVersion不一致除外・provider失敗時の扱い・
 * embedding保存のupsert冪等性)を対象とする(重複しない)。
 *
 * [deterministic fake embedding] pgvectorのコサイン距離は入力ベクトルの
 * 大きさに依存せず方向のみで決まるため、2成分だけを使った単位ベクトル
 * (残り1534次元は0)で類似度を厳密に制御できる: A=[1,0,...]と
 * B=[s, sqrt(1-s^2), 0,...]のコサイン類似度は理論上ちょうどsになる
 * (ただしpgvectorのvector型はfloat4精度のため、このスクリプトでは
 * 0.88/0.03ちょうどの境界ではなく余裕を持った値のみを使う。厳密境界は
 * 上記pure testの責務)。
 *
 * AI providerへの実通信は行わない(installAiNetworkDenyGuardで機械的に保証。
 * すべてfake providerで完結させ、getActiveEmbeddingProviderは一切呼ばない)。
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_pattern_detect_01d.ts
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
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
loadDotEnv(join(__dirname, "..", "app", ".env"));

const RUN_ID = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const EMAIL_PREFIX = "gate-pattern-detect-01d-verify-";

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

const DIMENSIONS = 1536;

/** A=[1,0,...,0]との厳密なコサイン類似度がtargetSimilarityになるベクトルを作る。 */
function makeVectorWithSimilarityToBase(targetSimilarity: number): number[] {
  const v = new Array(DIMENSIONS).fill(0);
  v[0] = targetSimilarity;
  v[1] = Math.sqrt(Math.max(0, 1 - targetSimilarity * targetSimilarity));
  return v;
}
function baseVector(): number[] {
  const v = new Array(DIMENSIONS).fill(0);
  v[0] = 1;
  return v;
}
/** baseVector系列とは別の直交方向(全く無関係な埋め込み空間領域)のベクトル。 */
function orthogonalVector(): number[] {
  const v = new Array(DIMENSIONS).fill(0);
  v[2] = 1;
  return v;
}

interface FakeEmbeddingProviderOptions {
  providerName?: string;
  modelName?: string;
  dimensions?: number;
  /** テキスト→ベクトルの決定論的対応表。無いテキストが来たら例外を投げる(想像で補完しない)。 */
  vectorsByText: Map<string, number[]>;
  /** 指定した場合、embed()は常にこの失敗を返す(provider障害の模擬)。 */
  forcedFailure?: { kind: "TRANSIENT" | "FATAL"; message: string };
}

function makeFakeEmbeddingProvider(opts: FakeEmbeddingProviderOptions) {
  return {
    providerName: opts.providerName ?? "fake",
    modelName: opts.modelName ?? "fake-embed-v1",
    dimensions: opts.dimensions ?? DIMENSIONS,
    async embed(input: { text: string }) {
      if (opts.forcedFailure) {
        return { ok: false as const, kind: opts.forcedFailure.kind, message: opts.forcedFailure.message };
      }
      const vector = opts.vectorsByText.get(input.text);
      if (!vector) {
        throw new Error(`[verify script bug] fake providerに未登録のテキストが渡された: ${JSON.stringify(input.text)}`);
      }
      return { ok: true as const, vector, dimensions: opts.dimensions ?? DIMENSIONS, usage: { inputTokens: 0, latencyMs: 0 } };
    },
  };
}

async function main(): Promise<void> {
  const { installAiNetworkDenyGuard } = await import("./lib/aiNetworkDenyGuard");
  const guard = installAiNetworkDenyGuard();

  const { db } = await import("../app/src/lib/db");
  const { cleanupFormationVerifyUser } = await import("./lib/formationVerifyCleanup");
  const { createCasePatternRevision } = await import("../app/src/lib/patterns/casePatternRevisionService");
  const { embedAndStoreCasePatternRevision, matchCasePattern } = await import("../app/src/lib/patterns/casePatternMatching");

  const createdFixtures: { userId: string; workspaceId: string }[] = [];

  async function cleanupCasePatternRowsByWorkspace(workspaceId: string): Promise<void> {
    await db.casePatternSourceLink.deleteMany({ where: { workspaceId } }).catch(() => null);
    await db.casePatternEvidenceAggregate.deleteMany({ where: { workspaceId } }).catch(() => null);
    await db.casePatternEmbedding.deleteMany({ where: { workspaceId } }).catch(() => null);
    await db.casePatternFeedbackEvent.deleteMany({ where: { workspaceId } }).catch(() => null);
    await db.casePatternRevision.deleteMany({ where: { workspaceId } }).catch(() => null);
    await db.casePattern.deleteMany({ where: { workspaceId } }).catch(() => null);
  }

  async function cleanupTestUser(userId: string, knownWorkspaceId: string | null): Promise<void> {
    let workspaceId = knownWorkspaceId;
    if (!workspaceId) {
      const membership = await db.workspaceMember.findFirst({ where: { userId }, select: { workspaceId: true } }).catch(() => null);
      workspaceId = membership?.workspaceId ?? null;
      if (!workspaceId) {
        const ctx = await db.projectContext.findFirst({ where: { OR: [{ ownerSubjectUserId: userId }, { createdById: userId }] }, select: { workspaceId: true } }).catch(() => null);
        workspaceId = ctx?.workspaceId ?? null;
      }
      if (!workspaceId) {
        const pat = await db.casePattern.findFirst({ where: { ownerSubjectUserId: userId }, select: { workspaceId: true } }).catch(() => null);
        workspaceId = pat?.workspaceId ?? null;
      }
    }
    if (workspaceId) await cleanupCasePatternRowsByWorkspace(workspaceId);

    // [PATTERN-DETECT-01C是正踏襲] workspaceMember/captureからしかworkspaceId
    // を解決できないcleanupFormationVerifyUserは、ProjectContextが
    // userId直接所有/作成のケースを取りこぼす場合があるため、先に直接消しておく。
    const ownedOrCreatedContexts = await db.projectContext
      .findMany({ where: { OR: [{ ownerSubjectUserId: userId }, { createdById: userId }] }, select: { id: true } })
      .catch(() => []);
    const contextIds = ownedOrCreatedContexts.map((c) => c.id);
    if (contextIds.length > 0) {
      await db.projectContextLinkEvent.deleteMany({ where: { contextId: { in: contextIds } } }).catch(() => null);
      await db.projectContextLink.deleteMany({ where: { contextId: { in: contextIds } } }).catch(() => null);
      await db.eventLog.deleteMany({ where: { aggregateId: { in: contextIds } } }).catch(() => null);
      await db.outboxEvent.deleteMany({ where: { aggregateId: { in: contextIds } } }).catch(() => null);
      await db.projectContext.deleteMany({ where: { id: { in: contextIds } } }).catch(() => null);
    }

    const result = await cleanupFormationVerifyUser(db, userId);
    if (result.errors.length > 0) {
      console.log(`  [cleanup警告] userId=${userId} errors=${result.errors.length}:`);
      for (const e of result.errors) console.log(`    - ${e.step}: ${String(e.error)}`);
    }
  }

  const orphans = await db.user.findMany({
    where: { email: { startsWith: EMAIL_PREFIX, endsWith: "@example.invalid" } },
    select: { id: true },
  });
  if (orphans.length > 0) {
    console.log(`[SWEEP] 過去実行の孤立テストユーザー${orphans.length}件を削除します...`);
    for (const o of orphans) await cleanupTestUser(o.id, null);
  }

  async function makeFixture(suffix: string): Promise<{ userId: string; workspaceId: string }> {
    const email = `${EMAIL_PREFIX}${RUN_ID}-${suffix}@example.invalid`;
    const user = await db.user.create({
      data: { email, passwordHash: "not-a-real-hash-for-db-only-test", displayName: `PATTERN-DETECT-01D ${suffix}` },
    });
    const workspace = await db.workspace.create({ data: { name: `PATTERN-DETECT-01D Workspace ${suffix}` } });
    await db.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
    createdFixtures.push({ userId: user.id, workspaceId: workspace.id });
    return { userId: user.id, workspaceId: workspace.id };
  }

  async function makePattern(fx: { workspaceId: string; userId: string }, key: string) {
    const pattern = await db.casePattern.create({
      data: { workspaceId: fx.workspaceId, ownerSubjectUserId: fx.userId, patternKey: `pk-${RUN_ID}-${key}`, title: `検証パターン ${key}` },
    });
    const rev = await createCasePatternRevision({
      workspaceId: fx.workspaceId,
      patternId: pattern.id,
      representativeText: `検証用テキスト ${key}`,
      decompositionTemplate: { key },
      thresholds: {},
      schemaVersion: "1.0",
    });
    return { patternId: pattern.id, revisionId: rev.revisionId, representativeText: `検証用テキスト ${key}`, decompositionTemplate: { key } };
  }

  try {
    console.log("=== PATTERN-DETECT-01D 実DB受入試験 ===");

    // ================================================================
    // embedAndStoreCasePatternRevision: 保存・upsert冪等性
    // ================================================================
    {
      const fx = await makeFixture("embed");
      const pat = await makePattern(fx, "embed");
      const provider = makeFakeEmbeddingProvider({
        vectorsByText: new Map([[`検証用テキスト embed\n{"key":"embed"}`, baseVector()]]),
      });

      const result1 = await embedAndStoreCasePatternRevision(
        { workspaceId: fx.workspaceId, revisionId: pat.revisionId, representativeText: pat.representativeText, decompositionTemplate: pat.decompositionTemplate },
        { getProvider: async () => provider },
      );
      ok("[embed] 初回保存は成功する", result1.ok === true, JSON.stringify(result1));

      const count1 = await db.casePatternEmbedding.count({ where: { revisionId: pat.revisionId } });
      ok("[embed] 保存件数は1件", count1 === 1, `count=${count1}`);

      const result2 = await embedAndStoreCasePatternRevision(
        { workspaceId: fx.workspaceId, revisionId: pat.revisionId, representativeText: pat.representativeText, decompositionTemplate: pat.decompositionTemplate },
        { getProvider: async () => provider },
      );
      ok("[embed] 2回目の保存も成功する(upsert)", result2.ok === true);
      const count2 = await db.casePatternEmbedding.count({ where: { revisionId: pat.revisionId } });
      ok("[embed] 再実行後も件数は1件のまま(revisionId+model単位でupsert)", count2 === 1, `count=${count2}`);
    }

    // ================================================================
    // matchCasePattern 基本動作: 明確に近いベクトルはMATCHED、明確に遠いベクトルはNO_MATCH
    // ================================================================
    let sharedFx: { userId: string; workspaceId: string };
    let sharedPatternId: string;
    {
      sharedFx = await makeFixture("basic");
      const pat = await makePattern(sharedFx, "basic");
      const storeProvider = makeFakeEmbeddingProvider({
        vectorsByText: new Map([[`検証用テキスト basic\n{"key":"basic"}`, baseVector()]]),
      });
      await embedAndStoreCasePatternRevision(
        { workspaceId: sharedFx.workspaceId, revisionId: pat.revisionId, representativeText: pat.representativeText, decompositionTemplate: pat.decompositionTemplate },
        { getProvider: async () => storeProvider },
      );
      sharedPatternId = pat.patternId;

      const closeText = "close-candidate";
      const closeProvider = makeFakeEmbeddingProvider({
        vectorsByText: new Map([[closeText, makeVectorWithSimilarityToBase(0.97)]]),
      });
      const closeResult = await matchCasePattern(
        { workspaceId: sharedFx.workspaceId, ownerSubjectUserId: sharedFx.userId, candidateText: closeText },
        { getProvider: async () => closeProvider },
      );
      ok("[基本] 明確に近い候補(sim≒0.97)はMATCHED", closeResult.kind === "MATCHED", `kind=${closeResult.kind}`);
      if (closeResult.kind === "MATCHED") {
        ok("[基本] MATCHEDのpatternIdが正しい", closeResult.patternId === sharedPatternId);
        ok("[基本] similarityが概ね期待通り(0.95〜1.0)", closeResult.similarity >= 0.95 && closeResult.similarity <= 1.0001, `similarity=${closeResult.similarity}`);
      }

      const farText = "far-candidate";
      const farProvider = makeFakeEmbeddingProvider({
        vectorsByText: new Map([[farText, orthogonalVector()]]),
      });
      const farResult = await matchCasePattern(
        { workspaceId: sharedFx.workspaceId, ownerSubjectUserId: sharedFx.userId, candidateText: farText },
        { getProvider: async () => farProvider },
      );
      ok("[基本] 明確に遠い候補(直交ベクトル)はNO_MATCH", farResult.kind === "NO_MATCH", `kind=${farResult.kind}`);
    }

    // ================================================================
    // current revisionのみ対象: 旧revisionのEmbeddingは横断してマッチしない
    // ================================================================
    {
      const fx = await makeFixture("revscope");
      const pat = await makePattern(fx, "revscope");
      const provider = makeFakeEmbeddingProvider({
        vectorsByText: new Map([[`検証用テキスト revscope\n{"key":"revscope"}`, baseVector()]]),
      });
      await embedAndStoreCasePatternRevision(
        { workspaceId: fx.workspaceId, revisionId: pat.revisionId, representativeText: pat.representativeText, decompositionTemplate: pat.decompositionTemplate },
        { getProvider: async () => provider },
      );
      await createCasePatternRevision({
        workspaceId: fx.workspaceId,
        patternId: pat.patternId,
        representativeText: "検証用v2",
        decompositionTemplate: {},
        thresholds: {},
        schemaVersion: "1.0",
      });

      const closeText = "revscope-close-candidate";
      const closeProvider = makeFakeEmbeddingProvider({
        vectorsByText: new Map([[closeText, makeVectorWithSimilarityToBase(0.97)]]),
      });
      const result = await matchCasePattern(
        { workspaceId: fx.workspaceId, ownerSubjectUserId: fx.userId, candidateText: closeText },
        { getProvider: async () => closeProvider },
      );
      ok(
        "[current revisionのみ] revision1のEmbeddingは(revision2が現行のため)マッチ対象から外れNO_MATCH",
        result.kind === "NO_MATCH",
        `kind=${result.kind}`,
      );
    }

    // ================================================================
    // owner分離: 他ownerのCasePatternはマッチ対象に含まれない
    // ================================================================
    {
      const fxOwner = await makeFixture("ownerA");
      const fxOther = await makeFixture("ownerB");
      const pat = await makePattern(fxOwner, "ownerA");
      const provider = makeFakeEmbeddingProvider({
        vectorsByText: new Map([[`検証用テキスト ownerA\n{"key":"ownerA"}`, baseVector()]]),
      });
      await embedAndStoreCasePatternRevision(
        { workspaceId: fxOwner.workspaceId, revisionId: pat.revisionId, representativeText: pat.representativeText, decompositionTemplate: pat.decompositionTemplate },
        { getProvider: async () => provider },
      );

      const closeText = "owner-isolation-candidate";
      const closeProvider = makeFakeEmbeddingProvider({
        vectorsByText: new Map([[closeText, makeVectorWithSimilarityToBase(0.97)]]),
      });
      const result = await matchCasePattern(
        { workspaceId: fxOwner.workspaceId, ownerSubjectUserId: fxOther.userId, candidateText: closeText },
        { getProvider: async () => closeProvider },
      );
      ok("[owner分離] 他ownerのPatternはマッチ対象に含まれずNO_MATCH", result.kind === "NO_MATCH", `kind=${result.kind}`);
    }

    // ================================================================
    // PD-11: model不一致は混合比較しない
    // ================================================================
    {
      const fx = await makeFixture("modeldiff");
      const pat = await makePattern(fx, "modeldiff");
      const storeProvider = makeFakeEmbeddingProvider({
        providerName: "fakeA",
        modelName: "model-A",
        vectorsByText: new Map([[`検証用テキスト modeldiff\n{"key":"modeldiff"}`, baseVector()]]),
      });
      await embedAndStoreCasePatternRevision(
        { workspaceId: fx.workspaceId, revisionId: pat.revisionId, representativeText: pat.representativeText, decompositionTemplate: pat.decompositionTemplate },
        { getProvider: async () => storeProvider },
      );

      const closeText = "modeldiff-candidate";
      const queryProvider = makeFakeEmbeddingProvider({
        providerName: "fakeB",
        modelName: "model-B",
        vectorsByText: new Map([[closeText, makeVectorWithSimilarityToBase(0.99)]]),
      });
      const result = await matchCasePattern(
        { workspaceId: fx.workspaceId, ownerSubjectUserId: fx.userId, candidateText: closeText },
        { getProvider: async () => queryProvider },
      );
      ok(
        "[PD-11] modelが異なるEmbedding同士は(ベクトルが近くても)比較されずNO_MATCH",
        result.kind === "NO_MATCH",
        `kind=${result.kind}`,
      );
    }

    // ================================================================
    // provider失敗時: 文字列一致へsilent fallbackせず明示エラーを返す
    // ================================================================
    {
      const fx = await makeFixture("providerfail");
      const failProvider = makeFakeEmbeddingProvider({
        vectorsByText: new Map(),
        forcedFailure: { kind: "TRANSIENT", message: "verify-forced-provider-failure" },
      });
      const result = await matchCasePattern(
        { workspaceId: fx.workspaceId, ownerSubjectUserId: fx.userId, candidateText: "irrelevant" },
        { getProvider: async () => failProvider },
      );
      ok("[provider失敗] EMBEDDING_FAILEDが返る(silent fallbackしない)", result.kind === "EMBEDDING_FAILED", `kind=${result.kind}`);
      if (result.kind === "EMBEDDING_FAILED") {
        ok("[provider失敗] errorKindがTRANSIENT(再試行可能と分かる)", result.errorKind === "TRANSIENT");
      }

      const embedFailResult = await embedAndStoreCasePatternRevision(
        { workspaceId: fx.workspaceId, revisionId: "irrelevant-revision-id", representativeText: "x", decompositionTemplate: {} },
        { getProvider: async () => failProvider },
      );
      ok("[provider失敗] embedAndStoreCasePatternRevisionもok:falseを返す", embedFailResult.ok === false);
    }

    ok("[AI課金] AI providerへの通信は0件(全てfake providerで完結)", guard.deniedCallAttempts.length === 0, `attempts=${guard.deniedCallAttempts.length}`);
  } finally {
    console.log("\n[CLEANUP] テスト用データを削除します...");
    for (const fx of createdFixtures) await cleanupTestUser(fx.userId, fx.workspaceId);
    const leftover = await db.user.findMany({ where: { email: { startsWith: EMAIL_PREFIX, endsWith: "@example.invalid" } }, select: { id: true } });
    ok("[cleanup] test用Userが1件も残っていない", leftover.length === 0, `remaining=${leftover.length}`);
    guard.restore();
  }

  console.log(`\n合計: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("\n失敗した項目:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
