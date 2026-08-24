/**
 * PEM Consent Ledger(Phase 0S)。
 * 出典: ISMAY_PEMサブシステム_統合正本仕様書_v4_0 16.1節・16.2節。
 *
 * 設計方針:
 *  - PemConsentEvent はinsert-only。現在の同意状態は最新イベントから都度導出する
 *    投影(getConsentState)として計算し、テーブルへは保存しない。
 *  - 3段階OFF(v3.3.1整合性修正 17.2節):
 *    PEM全体OFF(PEM_DATA_COLLECTION未許諾) / PlanningのみOFF(PEM_PLANNING_APPLICATION未許諾) /
 *    metric単位OFF(Phase 0D: MetricDefinitionレジストリ実装後に対応。現時点は未実装であることを
 *    明示し、architectureとしての余地のみ残す)。
 *  - 既存 schema.prisma の `Consent` モデル(captureId/subjectId/purpose/scope)とは無関係。
 *    あちらはFN-PRV-02(会議同意)向けの別モデルで、コードから未参照。混同しないこと。
 */
import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import {
  PEM_CONSENT_POLICY_VERSION,
  PEM_CONSENT_TYPES,
  PemConsentRequiredError,
  type PemConsentAction,
  type PemConsentType,
} from "./coreTypes";
import type { PemAuthorizationContext } from "./authorizationBoundary";
import { isMetricEnabledByDefault } from "./metricDefinitionRegistry";

// PEM_CONSENT_POLICY_VERSION・PemConsentRequiredErrorはcoreTypes.ts側で定義する
// (db.tsに依存しない純粋な定義にし、tsx実行テストがdb.ts解決を経由しなくて済むようにするため)。
// この2つを本ファイルからimportし直してre-exportし、既存コードからの参照パスを変えない。
export { PEM_CONSENT_POLICY_VERSION, PemConsentRequiredError };

/**
 * [是正・外部批評対応] Execution Ledger書き込み等、既存トランザクション内から
 * 同意確認する場合はtxを渡す(TOCTOU軽減。批評4.6「Consent確認がtransaction外」対応)。
 * 省略時はモジュールレベルの通常dbクライアントを使う(既存呼び出し元との後方互換)。
 * [限界] これはtransaction分離の一貫性を改善するが、Read Committed分離レベル下では
 * commit直前の一瞬の同意撤回まで排除する完全なTOCTOU対策ではない(SERIALIZABLE分離、
 * またはcommit直前の再確認が別途必要。本パッチのスコープ外として明記する)。
 */
type PemDbClient = typeof db | Prisma.TransactionClient;

export interface PemConsentState {
  consentType: PemConsentType;
  action: PemConsentAction | null; // null = 未回答(GRANTED/WITHDRAWNいずれの記録も無い)
  policyVersion: string | null;
  occurredAt: Date | null;
}

/**
 * v4.0 16.1節: Consent Eventはinsert-only。GRANTED/WITHDRAWNを追記するのみで、
 * 既存行を更新しない。
 */
export async function recordConsentEvent(
  ctx: PemAuthorizationContext,
  consentType: PemConsentType,
  action: PemConsentAction,
  source: "ONBOARDING" | "SETTINGS",
): Promise<void> {
  await db.pemConsentEvent.create({
    data: {
      userId: ctx.subjectUserId,
      workspaceId: ctx.tenantId,
      consentType,
      action,
      policyVersion: PEM_CONSENT_POLICY_VERSION,
      source,
    },
  });
}

/**
 * v4.0 16.1節: 現在の同意状態は最新の GRANTED/WITHDRAWN イベントから導出する
 * (投影。テーブルへ保存しない)。全PemConsentType分をまとめて返す。
 */
export async function getConsentState(
  ctx: PemAuthorizationContext,
  client: PemDbClient = db,
): Promise<Record<PemConsentType, PemConsentState>> {
  const events = await client.pemConsentEvent.findMany({
    where: { userId: ctx.subjectUserId, workspaceId: ctx.tenantId },
    orderBy: { occurredAt: "asc" },
    select: { consentType: true, action: true, policyVersion: true, occurredAt: true },
  });

  const latestByType = new Map<string, (typeof events)[number]>();
  for (const e of events) {
    latestByType.set(e.consentType, e); // 昇順で舐めるため、最後に残ったものが最新
  }

  const result = {} as Record<PemConsentType, PemConsentState>;
  for (const consentType of PEM_CONSENT_TYPES) {
    const latest = latestByType.get(consentType);
    // [2026-08-25追加・Completion Gate 1、v4.0 16.1節] 最新イベントのpolicyVersionが
    // 現在のPEM_CONSENT_POLICY_VERSIONと一致しない場合、GRANTEDを有効とみなさない
    // (文言改定後に旧GRANTEDが自動的に有効扱いになる問題を是正)。occurredAt/
    // policyVersion自体は透明性のため保持し、actionだけをnull(未回答扱い)にする。
    const isCurrentPolicy = latest?.policyVersion === PEM_CONSENT_POLICY_VERSION;
    result[consentType] = {
      consentType,
      action: isCurrentPolicy ? ((latest?.action as PemConsentAction | undefined) ?? null) : null,
      policyVersion: latest?.policyVersion ?? null,
      occurredAt: latest?.occurredAt ?? null,
    };
  }
  return result;
}

/** 指定Consent種別が現在GRANTEDかどうかを判定する。 */
export async function isConsentGranted(
  ctx: PemAuthorizationContext,
  consentType: PemConsentType,
  client: PemDbClient = db,
): Promise<boolean> {
  const state = await getConsentState(ctx, client);
  return state[consentType].action === "GRANTED";
}

/** GRANTEDでなければ例外を投げる(Execution Ledger書き込み経路等から呼ぶ想定)。 */
export async function assertConsentGranted(
  ctx: PemAuthorizationContext,
  consentType: PemConsentType,
  client: PemDbClient = db,
): Promise<void> {
  if (!(await isConsentGranted(ctx, consentType, client))) {
    throw new PemConsentRequiredError(consentType);
  }
}

/**
 * 3段階OFF判定(v3.3.1整合性修正 17.2節)。
 *
 * | 操作 | 既存データ | 新規収集 | Planning利用 |
 * |---|---|---|---|
 * | PEM全体OFF | 保持/削除選択 | 停止 | 停止 |
 * | PlanningのみOFF | 保持 | 継続 | 停止 |
 * | metric単位OFF | 保持/除外選択 | 継続可 | 当該metricのみ不使用 |
 *
 * metric単位OFFは、metricの実体(MetricDefinitionレジストリ)がPhase 0Dまで
 * 存在しないため、本関数のインターフェースには含めるが常にfalse(未実装)を返す。
 * これは先送りではなく、実体が無いため判定不能という事実の表明である。
 */
export interface PemFeatureGate {
  dataCollectionEnabled: boolean; // PEM全体OFFでない
  aiProcessingEnabled: boolean;
  planningApplicationEnabled: boolean; // PlanningのみOFFでない
  /** registry登録済み かつ 本人がmetric単位OFFにしていないmetricでtrue。 */
  isMetricEnabled: (metricKey: string) => boolean;
}

/**
 * [2026-08-25追加・Completion Gate 1、v4.0 16.2節「metric OFF」]
 * ユーザーが個別に無効化(WITHDRAWN)したmetricKeyの集合を返す(投影)。
 */
export async function getWithdrawnMetricKeys(
  ctx: PemAuthorizationContext,
  client: PemDbClient = db,
): Promise<Set<string>> {
  const events = await client.pemMetricConsentEvent.findMany({
    where: { userId: ctx.subjectUserId, workspaceId: ctx.tenantId },
    orderBy: { occurredAt: "asc" },
    select: { metricKey: true, action: true },
  });
  const latestByMetric = new Map<string, string>();
  for (const e of events) {
    latestByMetric.set(e.metricKey, e.action); // 昇順で舐めるため、最後に残ったものが最新
  }
  const withdrawn = new Set<string>();
  for (const [metricKey, action] of latestByMetric) {
    if (action === "WITHDRAWN") withdrawn.add(metricKey);
  }
  return withdrawn;
}

/** v4.0 16.2節「metric OFF」。GRANTEDの記録はinsert-onlyのopt back-in。 */
export async function recordMetricConsentEvent(
  ctx: PemAuthorizationContext,
  metricKey: string,
  action: PemConsentAction,
  source: "ONBOARDING" | "SETTINGS",
): Promise<void> {
  await db.pemMetricConsentEvent.create({
    data: {
      userId: ctx.subjectUserId,
      workspaceId: ctx.tenantId,
      metricKey,
      action,
      policyVersion: PEM_CONSENT_POLICY_VERSION,
      source,
    },
  });
}

export async function evaluateFeatureGate(ctx: PemAuthorizationContext): Promise<PemFeatureGate> {
  const state = await getConsentState(ctx);
  const withdrawnMetrics = await getWithdrawnMetricKeys(ctx);
  return {
    dataCollectionEnabled: state.PEM_DATA_COLLECTION.action === "GRANTED",
    aiProcessingEnabled: state.PEM_AI_PROCESSING.action === "GRANTED",
    planningApplicationEnabled: state.PEM_PLANNING_APPLICATION.action === "GRANTED",
    // registryに登録済み かつ 本人がmetric単位OFFにしていない場合のみtrue。
    isMetricEnabled: (metricKey: string) =>
      isMetricEnabledByDefault(metricKey) && !withdrawnMetrics.has(metricKey),
  };
}
