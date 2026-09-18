/**
 * Case Pattern ActionSlot Decomposition Proposal Builder(PATTERN-PROPOSAL-02
 * 新設・2026-09-18)。
 * 出典: Claude向け_ISMAY_d68e9bf以降_ActionSlot正本準拠・CasePattern実分解
 * 完遂・残工程連続実装指示_2026-09-17.md P1「6. PATTERN-PROPOSAL-02:
 * ActionSlotからversion付きdecomposition proposalを生成。stable child key、
 * 根拠、confidence、欠損を含める」。
 *
 * [scope宣言] このファイルは「1つのCasePatternについて、現在のActionSlot群
 * (各slotのcurrent revision)から読み取り専用のproposal DTOを組み立てる」
 * ことのみを行う。書込みは一切行わない(ActionSlot自体の学習はGate 5
 * casePatternActionSlotLearnService.tsの責務)。適用(Split確定への接続)は
 * Gate 8 PATTERN-APPLY-02Bの責務。
 *
 * [stable child key] slotKeyは既存ActionSlot設計(Gate 3 Decision Record
 * §3.2)により初回生成後は不変のため、このDTOのpartのidentityとして
 * そのまま使う(想像で新しいkeyを発明しない)。
 *
 * [根拠・confidence] 各partのoccurrenceProbability・rawSampleSizeを
 * 「根拠」および「信頼度」の一次情報としてそのまま公開する(ActionSlotの
 * 既存計算をそのまま転記するのみで、新しい確信度アルゴリズムは発明しない)。
 *
 * [欠損の表現] Patternに帰属するActionSlotが1件も無い場合(=まだ本人が
 * このPattern選択でのSPLIT実例を確定させていない)、`hasData: false`かつ
 * `parts: []`という明示的な状態で表す(空配列と「データ欠損」を区別しない
 * 実装は、UI側が「分解案なし」と「確認中」を区別できなくなるため避ける)。
 */
import { db } from "@/lib/db";

/** ActionSlotDecompositionProposal.schemaVersion(このGateで確定した最初のversion)。 */
export const CASE_PATTERN_ACTION_SLOT_PROPOSAL_SCHEMA_VERSION = "1.0";
/** partの選定・整列に使ったpolicy(現状はActionSlotのpolicyVersionをそのまま転記)。 */
export const CASE_PATTERN_ACTION_SLOT_PROPOSAL_POLICY_VERSION = "1.0";

export interface ActionSlotProposalPart {
  /** stable child key(ActionSlot.slotKeyをそのまま使う、初回生成後は不変)。 */
  slotKey: string;
  /** 分解内での典型的な順序(中央値、0始まり、表示・整列に使う)。 */
  typicalOrder: number;
  suggestedType: string;
  /** 直近instanceのtitleそのまま(要約・自然言語汎化はしない)。 */
  titleExample: string;
  /** このslotを含む適格Split instance数の割合(0..1、根拠かつ信頼度の一次情報)。 */
  occurrenceProbability: number;
  /** このslotの算出に使った適格Split instance数。 */
  rawSampleSize: number;
  /** 直前slotとして頻出するslotKey一覧(最小sample2・閾値0.3以上、Gate 3 Decision Record §3.4)。 */
  predecessorSlotKeys: string[];
  /** この内容の出典(CasePatternActionSlotRevision.id、UI側で「なぜこの提案か」を遡及可能にする)。 */
  sourceActionSlotRevisionId: string;
}

export interface ActionSlotDecompositionProposal {
  kind: "ACTION_SLOT_PROPOSAL";
  schemaVersion: string;
  policyVersion: string;
  /** false: このPatternにはまだ学習済みActionSlotが1件も無い(欠損の明示)。 */
  hasData: boolean;
  /** typicalOrder昇順。 */
  parts: ActionSlotProposalPart[];
}

/**
 * このPattern(patternId)の現在のActionSlot群から、version付きdecomposition
 * proposalを組み立てる(読み取り専用)。
 */
export async function buildActionSlotDecompositionProposal(
  workspaceId: string,
  patternId: string,
): Promise<ActionSlotDecompositionProposal> {
  const slots = await db.casePatternActionSlot.findMany({
    where: { workspaceId, patternId, currentRevision: { gt: 0 } },
    select: { id: true, slotKey: true, currentRevision: true },
  });

  if (slots.length === 0) {
    return {
      kind: "ACTION_SLOT_PROPOSAL",
      schemaVersion: CASE_PATTERN_ACTION_SLOT_PROPOSAL_SCHEMA_VERSION,
      policyVersion: CASE_PATTERN_ACTION_SLOT_PROPOSAL_POLICY_VERSION,
      hasData: false,
      parts: [],
    };
  }

  const parts: ActionSlotProposalPart[] = [];
  for (const slot of slots) {
    const rev = await db.casePatternActionSlotRevision.findFirst({
      where: { workspaceId, slotId: slot.id, revision: slot.currentRevision },
    });
    // [防御的スキップ] currentRevisionが指すrevision行が見つからない場合
    // (理論上到達しないはずだが、部分的なdata不整合に対しfail closedで
    // このslotをproposalから除外する。他のslotの提案は継続する)。
    if (!rev) continue;
    parts.push({
      slotKey: slot.slotKey,
      typicalOrder: Number(rev.typicalOrder),
      suggestedType: rev.suggestedType,
      titleExample: rev.normalizedIntent,
      occurrenceProbability: Number(rev.occurrenceProbability),
      rawSampleSize: rev.rawSampleSize,
      predecessorSlotKeys: rev.predecessorSlotKeys,
      sourceActionSlotRevisionId: rev.id,
    });
  }
  parts.sort((a, b) => a.typicalOrder - b.typicalOrder);

  return {
    kind: "ACTION_SLOT_PROPOSAL",
    schemaVersion: CASE_PATTERN_ACTION_SLOT_PROPOSAL_SCHEMA_VERSION,
    policyVersion: CASE_PATTERN_ACTION_SLOT_PROPOSAL_POLICY_VERSION,
    hasData: parts.length > 0,
    parts,
  };
}
