/**
 * PEM Phase 0S 不変条件テスト。
 * 実行: npx tsx src/lib/pem/__tests__/phase0sInvariants.test.ts
 * (npm run test:pem-phase0s)
 *
 * 実DB接続は前提にせず、型・ロジックレベルの不変条件のみを検証する
 * (getConsentState/evaluateFeatureGate自体はDBアクセスを伴うため、
 *  ここではPEM_CONSENT_TYPES/ACTIONSの整合性等、DB非依存部分を検証する)。
 */
import assert from "node:assert/strict";
import {
  PEM_CONSENT_ACTIONS,
  PEM_CONSENT_POLICY_VERSION,
  PEM_CONSENT_TYPES,
  PemConsentRequiredError,
} from "@/lib/pem/coreTypes";
// 注意: "@/lib/pem/consent" は db.ts(実Prismaクライアント)へ連鎖するため、
// tsx実行テストではimportしない(サンドボックスでは`prisma generate`が実行できずMODULE_NOT_FOUNDになる。
// consent.ts自体の型検証はtsc --noEmit(Prismaスタブ使用)側で行う)。

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

console.log("PEM Phase 0S 不変条件テスト");

check("PEM_CONSENT_TYPESにPEM_DATA_COLLECTIONとPEM_PLANNING_APPLICATIONが含まれる", () => {
  assert.ok((PEM_CONSENT_TYPES as readonly string[]).includes("PEM_DATA_COLLECTION"));
  assert.ok((PEM_CONSENT_TYPES as readonly string[]).includes("PEM_PLANNING_APPLICATION"));
});

check("PEM_CONSENT_ACTIONSはGRANTED/WITHDRAWNの2値のみ", () => {
  assert.deepEqual([...PEM_CONSENT_ACTIONS].sort(), ["GRANTED", "WITHDRAWN"]);
});

check("PEM_CONSENT_POLICY_VERSIONが空でない", () => {
  assert.ok(PEM_CONSENT_POLICY_VERSION.length > 0);
});

check("PemConsentRequiredErrorがconsentTypeを保持する", () => {
  const err = new PemConsentRequiredError("PEM_DATA_COLLECTION");
  assert.equal(err.consentType, "PEM_DATA_COLLECTION");
  assert.ok(err.message.includes("PEM_DATA_COLLECTION"));
});

console.log(`PEM Phase 0S: ${passed}件のテストがすべて成功しました`);
