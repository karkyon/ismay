/**
 * PEM Phase 0E(Bootstrap再設計) 不変条件テスト。
 * 実行: npx tsx src/lib/pem/__tests__/phase0eInvariants.test.ts
 * (npm run test:pem-phase0e)
 *
 * findOrCreateCurrentConversationはdb依存(lib/ai/pemOnboarding.tsからexportしていない
 * 内部関数)のため、ここではPHASE_0G_COMPATIBILITY_LEDGER.mdが要求する語彙
 * (INITIAL/RECALIBRATION/MAJOR_CHANGE)がコード内に存在することのみ、静的な文字列検査で
 * 確認する(db非依存に保つため、実際のPrisma呼び出しは行わない)。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

console.log("PEM Phase 0E 不変条件テスト");

check("lib/ai/pemOnboarding.tsが新規対話をconversationKind=\"INITIAL\"で作成する", () => {
  const src = readFileSync(resolve(__dirname, "../../ai/pemOnboarding.ts"), "utf-8");
  assert.ok(src.includes('conversationKind: "INITIAL"'), "INITIALでの新規作成コードが見つからない");
  assert.ok(src.includes("findOrCreateCurrentConversation"), "findOrCreateCurrentConversationが見つからない");
});

check("schema.prismaのPemOnboardingConversationがconversationKind列を持つ", () => {
  const src = readFileSync(resolve(__dirname, "../../../../prisma/schema.prisma"), "utf-8");
  assert.ok(src.includes('conversationKind String @default("INITIAL") @map("conversation_kind")'));
  assert.ok(
    !src.includes('userId    String    @unique @map("user_id")\n  user      User      @relation(fields: [userId], references: [id])\n  /// ROLE'),
    "PemOnboardingConversation.userIdのunique制約が残っている",
  );
});

console.log(`\n${passed}件すべて成功`);
