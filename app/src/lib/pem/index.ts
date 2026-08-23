/**
 * PEMサブシステム Phase 0G 成果物の入口(v2)。
 * 出典: ISMAY_PEMサブシステム_統合正本仕様書_v4_0 21章「実装ゲート」Phase 0G。
 *
 * Phase 0Gの完了条件(v4.0 21章): 「enum、Event Definition、Evidence Class、
 * 削除mode、認可境界確定」。
 *
 * v2での主な是正: 既存Responsibility状態・既存Workspace/WorkspaceMemberモデルとの
 * 統合、Evidence Class→Ledgerの誤対応の解消、Registry網羅性のコンパイル時保証、
 * 検証関数の一本化。詳細は PHASE_0G_COMPATIBILITY_LEDGER.md を参照。
 *
 * 未確定のまま残る事項(Phase 0G-D台帳で追跡): 既存PemHypothesis.userVerdict等の
 * 語彙不一致は、Prismaスキーマ変更を伴うためPhase 0C/0Aで解消する(本Phaseの
 * スコープ外。コード上の正本語彙のみ先に確定した)。
 *
 * 未着手(次回以降): Phase 0S(Consent/OFF/tenant isolation/Export・Deletion経路)、
 * Phase 0A(Execution Event Ledgerの実DBスキーマ・API)以降。
 */
export * from "./coreTypes";
export * from "./eventDefinitionRegistry";
export * from "./authorizationBoundary";
