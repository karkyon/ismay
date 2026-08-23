/**
 * PEMサブシステム Phase 0G 成果物の入口。
 * 出典: ISMAY_PEMサブシステム_統合正本仕様書_v4_0 21章「実装ゲート」Phase 0G。
 *
 * Phase 0Gの完了条件(v4.0 21章): 「enum、Event Definition、Evidence Class、
 * 削除mode、認可境界確定」。本ディレクトリはこの4点をコードとして確定したもの。
 *
 * 未着手(次回以降): Phase 0S(Consent/OFF/tenant isolation/Export・Deletion経路)、
 * Phase 0A(Execution Event Ledgerの実DBスキーマ・API)以降。
 * v4.0 1章「実装判断」・21章の実装ゲート原則により、Phase 0D(Metric Catalog)等の
 * 分冊が未確定のフェーズへは着手しない。
 */
export * from "./coreTypes";
export * from "./eventDefinitionRegistry";
export * from "./authorizationBoundary";
