import type { ConversationState } from "@/lib/ai/pemSchema";

/**
 * FN-PEM-01 初回対話(AI-06 PEM対話)のAI Gateway抽象化。
 * lib/ai/provider.ts(抽出)・lib/ai/segmentProvider.ts(話題分割)と同じ方針
 * (FR-AI-07「AIモデルを交換可能にする」、事業者固有形状に上位層を依存させない)。
 */

export interface PemOnboardingTurnInput {
  /** 現在の会話ブロック(ROLE等)。VALUES完了後はREVIEW、ユーザー確認後にDONE。 */
  state: ConversationState;
  /** これまでの対話履歴({role, content}[])。非信頼データとして扱う。 */
  history: Array<{ role: "assistant" | "user"; content: string }>;
  /** 今回のユーザー発言。skipの場合は空文字。 */
  userMessage: string;
  skip: boolean;
  nowIso: string;
  timezone: string;
}

export interface PemOnboardingUsage {
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export type PemOnboardingOutcome =
  /** rawJsonはJSON Schema検証前の生出力(呼び出し元がPemOnboardingTurnResultSchemaでzod検証する)。
   *  lib/ai/provider.ts(FN-AI-01)と同じ「二段階検証」方針。 */
  | { ok: true; rawJson: unknown; usage: PemOnboardingUsage }
  | { ok: false; kind: "TRANSIENT" | "STRUCTURAL" | "FATAL"; message: string; usage?: PemOnboardingUsage };

export interface PemDialogueProvider {
  readonly providerName: string;
  readonly modelName: string;
  readonly promptVersion: string;
  readonly schemaVersion: string;
  runOnboardingTurn(input: PemOnboardingTurnInput): Promise<PemOnboardingOutcome>;
}
