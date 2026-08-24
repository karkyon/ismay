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
): Promise<Record<PemConsentType, PemConsentState>> {
  const events = await db.pemConsentEvent.findMany({
    where: { userId: ctx.subjectUserId },
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
    result[consentType] = {
      consentType,
      action: (latest?.action as PemConsentAction | undefined) ?? null,
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
): Promise<boolean> {
  const state = await getConsentState(ctx);
  return state[consentType].action === "GRANTED";
}

/** GRANTEDでなければ例外を投げる(Execution Ledger書き込み経路等から呼ぶ想定)。 */
export async function assertConsentGranted(
  ctx: PemAuthorizationContext,
  consentType: PemConsentType,
): Promise<void> {
  if (!(await isConsentGranted(ctx, consentType))) {
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
  isMetricEnabled: (metricKey: string) => boolean; // Phase 0Dまでは常にtrue(制御なし)を返す
}

export async function evaluateFeatureGate(ctx: PemAuthorizationContext): Promise<PemFeatureGate> {
  const state = await getConsentState(ctx);
  return {
    dataCollectionEnabled: state.PEM_DATA_COLLECTION.action === "GRANTED",
    aiProcessingEnabled: state.PEM_AI_PROCESSING.action === "GRANTED",
    planningApplicationEnabled: state.PEM_PLANNING_APPLICATION.action === "GRANTED",
    // Phase 0D-1: 登録済みmetricKeyかどうかで判定する。ユーザーごとの個別無効化
    // (metric単位OFF)は永続化先の設計確定後に別途追加する(現状は未実装)。
    isMetricEnabled: (metricKey: string) => isMetricEnabledByDefault(metricKey),
  };
}
