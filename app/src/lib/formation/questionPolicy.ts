import type { ResponsibilityCandidate } from "@/lib/ai/schema";
import type { FormationAnswerKind } from "@/lib/formation/coreTypes";

/**
 * V5-M1-B5a Question Policy(統合正本v5.0 §6.4)。
 * 出典: `ISMAY_統合正本仕様書_v5_0.md` §6.4「質問は次の優先順位で最大3問/Session」
 * 「質問価値は ambiguity × downstreamImpact × errorRisk - answerCost で順位付けする。
 * 閾値未満は質問せず、未確定属性として表示する。」
 *
 * db.ts を import しないこと(coreTypes.ts / responsibilityMaterializationCore.ts と
 * 同じ、db非依存pure test runnerパターン)。
 *
 * ============================================================================
 * [2026-08-30是正・最重要] 「fieldが空 = 質問必要」ではない
 * ============================================================================
 * 前回設計案は`actor`/`importance`/`dateMentions`/`description`等が単に空である
 * ことだけを条件に質問を生成しており、これだと通常の個人Taskのほぼ全件へ
 * 3問(上限いっぱい)を出してしまい、ISMAYの「入力負荷削減」という設計思想
 * (統合正本§0.1)そのものを壊す。この設計は撤回し、質問生成条件を次の2categoryに
 * 限定する(2026-08-30指示書 §3.1):
 *
 *   (A) 責任型上の必須契約が不足している場合のみ(型に依存する契約):
 *       - type=COMMITMENT なのに外部約束先(counterparty)が不明
 *       - type=WAITING なのに待ち先(counterparty)が不明
 *       - 完了条件を一文で説明できずMaterialize後の完了判断ができない
 *         (TASK/COMMITMENT/WAITING/EVENTのみ対象。DECISION/RISK/CONCERN/HABIT/IDEA
 *         は「完了」という概念が薄いか別の状態機械を持つため対象外とする
 *         [設計判断・正本に完了条件の型別要否が明記されていないため、対象型を
 *         明示的に限定する形でこのファイル内に判断根拠を残す])。
 *
 *   (B) 明示的な曖昧性・矛盾が存在する場合のみ:
 *       - dateMentions中 meaning=HARD_DEADLINE だが個別confidenceが閾値未満
 *         (=AIが期限だと判定したが自信が無い。これは「fieldが空」ではなく
 *         「値はあるが信頼できない」という明示signalなので質問対象になる)
 *       - unknowns(AIが自己申告した未解決点)が1件以上ある場合、その内容を
 *         要約して1問にまとめる(unknowns件数だけ質問を増やさない)
 *
 * 個人Task(type=TASK等)でactorが省略されているだけの場合は「本人」を安全な
 * 既定推論候補として扱い、P0質問を自動発生させない(actor欠落単体では
 * 質問生成条件に入れていない。ただしFACTへの昇格はService層の責務であり、
 * このPure関数は判定条件を提供するのみ)。
 *
 * P2(重要度・希望期限・場所・道具・説明補足)は、現行`ResponsibilityCandidate`
 * schema(ai/schema.ts)にdownstreamImpact/errorRiskを示す構造化signalが
 * まだ存在しないため、[2026-08-30時点]では自動発生条件を持たない
 * (Question Code Registryには型として存在するが、`condition`が常にfalseを
 * 返す「将来の構造化signal追加を待つ」設計。理由: 指示書§3.1「downstreamImpact/
 * errorRiskが閾値以上、又は原文がそれを必要としている時だけ質問する」を
 * 満たす判定材料が現行schemaに無いため、想像で閾値を作らない)。
 *
 * ============================================================================
 * 構造化Uncertainty(指示書§3.2)について
 * ============================================================================
 * 自由文`unknowns: string[]`だけに長期依存しない、という指示書の方針に対し、
 * このPatchでは`ai/schema.ts`(AI抽出tool JSON schema・プロンプト)自体は
 * 変更していない([設計判断] AI抽出プロンプトの変更はAI応答の分布を変える
 * 実運用影響があり、Question Policy pure関数の実装と同じPatchに混在させると
 * blast radiusが大きくなりすぎる。既存coreTypes.ts是正が「1 Patchで1種類の
 * 変更に絞る」方針を採っているのと同じ理由で、これは意図的に別Gateへ分離する)。
 * 代わりに、このファイルは`ResponsibilityCandidate`(既存schema)をそのまま
 * 入力として受け取り、`unknowns`/`dateMentions[].confidence`という既存の
 * 「値はあるが不確かである」ことを示すfieldから保守的にadaptする設計に留める。
 * 将来AI抽出schemaへ`uncertaintyCode`/`ambiguity`/`downstreamImpact`/
 * `errorRisk`/`answerCost`のoptional構造化fieldが追加された場合は、
 * このファイルの`buildQuestionCandidatesForCandidate`内でそれを優先的に
 * 参照するよう拡張する(既存adapterは後方互換のためfallbackとして残す)。
 */

export const QUESTION_POLICY_VERSION = "v1";

export type QuestionPriority = "P0" | "P1" | "P2";

export const QUESTION_CODES = [
  "COMMITMENT_COUNTERPARTY_MISSING",
  "WAITING_COUNTERPARTY_MISSING",
  "COMPLETION_CONDITION_MISSING",
  "HARD_DEADLINE_LOW_CONFIDENCE",
  "UNKNOWNS_CLARIFICATION",
  "IMPORTANCE_MISSING",
  "DESIRED_DATE_MISSING",
  "DESCRIPTION_MISSING",
] as const;
export type QuestionCode = (typeof QUESTION_CODES)[number];

export function isValidQuestionCode(value: string): value is QuestionCode {
  return (QUESTION_CODES as readonly string[]).includes(value);
}

/**
 * score成分(統合正本§6.4「ambiguity × downstreamImpact × errorRisk - answerCost」)。
 * 各成分は0〜1(answerCostのみ0〜1、質問の回答負荷)。
 *
 * [数値根拠・2026-08-30設計判断、正本に数値の明記が無いため実装判断として明記する]
 * - ambiguity: 「値が完全に無い」場合を0.9、「値はあるが信頼度が低い」場合は
 *   実測confidenceから逆算(1 - confidence)する(値が存在する分、完全欠落より
 *   多少ambiguityは低いと扱う)。
 * - downstreamImpact: 契約不足(COMMITMENT/WAITINGのcounterparty欠落、
 *   completionCondition欠落)はMaterialize後の追跡・完了判定を直接壊すため0.8。
 *   HARD_DEADLINE低confidenceは締切を誤って見せる/隠すリスクがあるため0.85。
 *   unknowns由来の一般clarificationは、AI自身が「自信が無い」と自己申告した
 *   signalであり無視すると誤った候補がそのままMaterializeされうるため0.6とする。
 * - errorRisk: 「本人が後で違うと気づいて訂正するコスト」の見積り。契約不足は
 *   Materialize後の訂正が難しい(既にResponsibility化されている)ため0.7、
 *   締切誤りは重大な見落としに繋がるため0.75、unknowns由来は0.6とする。
 * - answerCost: 定型のcounterparty/completionConditionは短い自由文で0.15、
 *   締切確認はYES/NO相当の選択式にできるため0.1、unknowns要約は複数件を
 *   1問へ要約表示する分、回答の負荷はやや下がるため0.15とする。
 *
 * これらは`QUESTION_POLICY_VERSION`に紐付くversion付き定数であり、閾値・重みを
 * 変える場合は新versionとして追加し、既存Question行のscoreValueへ遡及適用しない
 * (指示書§3.3「Question行には最終scoreを保存し…再現可能にする」)。
 */
export interface ScoreComponents {
  ambiguity: number;
  downstreamImpact: number;
  errorRisk: number;
  answerCost: number;
}

export function computeQuestionScore(c: ScoreComponents): number {
  return c.ambiguity * c.downstreamImpact * c.errorRisk - c.answerCost;
}

/** priority別の質問要否閾値(この値未満は「質問せず、未確定属性として表示」)。 */
export const QUESTION_SCORE_THRESHOLDS: Record<QuestionPriority, number> = {
  P0: 0.15,
  P1: 0.12,
  P2: 0.1,
};

const PRIORITY_ORDER: Record<QuestionPriority, number> = { P0: 0, P1: 1, P2: 2 };

/** 完了条件の要否をチェックする対象型(§3.1、このファイル内の設計判断根拠は上部コメント参照)。 */
const COMPLETION_CONDITION_REQUIRED_TYPES = new Set(["TASK", "COMMITMENT", "WAITING", "EVENT"]);

/** dateMentions内、HARD_DEADLINEの個別confidenceがこの値未満なら明示的曖昧性とみなす。 */
const HARD_DEADLINE_CONFIDENCE_THRESHOLD = 0.6;

export interface QuestionCandidate {
  questionCode: QuestionCode;
  priority: QuestionPriority;
  targetField: string;
  reasonCode: string;
  promptText: string;
  answerKind: Extract<FormationAnswerKind, "SELECTED" | "FREE_TEXT">;
  options?: Array<{ id: string; label: string }>;
  scoreComponents: ScoreComponents;
  score: number;
}

/** Question Code Registry。1エントリ = 1判定条件 + 1 promptテンプレート + 1 score設定。 */
interface QuestionCodeDefinition {
  code: QuestionCode;
  priority: QuestionPriority;
  targetField: string;
  answerKind: Extract<FormationAnswerKind, "SELECTED" | "FREE_TEXT">;
  /** この候補に対してこの質問を生成すべきか(true=適用対象)。 */
  condition: (candidate: ResponsibilityCandidate) => boolean;
  reasonCode: string;
  promptText: (candidate: ResponsibilityCandidate) => string;
  options?: (candidate: ResponsibilityCandidate) => Array<{ id: string; label: string }>;
  scoreComponents: (candidate: ResponsibilityCandidate) => ScoreComponents;
}

function hardDeadlineLowConfidence(candidate: ResponsibilityCandidate) {
  return candidate.dateMentions.find(
    (d) => d.meaning === "HARD_DEADLINE" && d.confidence < HARD_DEADLINE_CONFIDENCE_THRESHOLD,
  );
}

const HARD_DEADLINE_CONFIRM_OPTIONS = [
  { id: "CONFIRM_HARD_DEADLINE", label: "はい、締切です" },
  { id: "NOT_A_DEADLINE", label: "いいえ、締切ではありません" },
];
const IMPORTANCE_SELECT_OPTIONS = [1, 2, 3, 4, 5].map((n) => ({ id: String(n), label: `${n}` }));

const QUESTION_CODE_REGISTRY: QuestionCodeDefinition[] = [
  {
    code: "COMMITMENT_COUNTERPARTY_MISSING",
    priority: "P0",
    targetField: "counterparty",
    answerKind: "FREE_TEXT",
    condition: (c) => c.type === "COMMITMENT" && !c.counterparty,
    reasonCode: "COMMITMENT_REQUIRES_COUNTERPARTY",
    promptText: (c) => `「${c.title}」は誰(どの相手)への約束ですか？`,
    scoreComponents: () => ({ ambiguity: 0.9, downstreamImpact: 0.8, errorRisk: 0.7, answerCost: 0.15 }),
  },
  {
    code: "WAITING_COUNTERPARTY_MISSING",
    priority: "P1",
    targetField: "counterparty",
    answerKind: "FREE_TEXT",
    condition: (c) => c.type === "WAITING" && !c.counterparty,
    reasonCode: "WAITING_REQUIRES_COUNTERPARTY",
    promptText: (c) => `「${c.title}」は誰(どこ)からの返答・対応待ちですか？`,
    scoreComponents: () => ({ ambiguity: 0.9, downstreamImpact: 0.7, errorRisk: 0.6, answerCost: 0.15 }),
  },
  {
    code: "COMPLETION_CONDITION_MISSING",
    priority: "P1",
    targetField: "completionCondition",
    answerKind: "FREE_TEXT",
    condition: (c) => COMPLETION_CONDITION_REQUIRED_TYPES.has(c.type) && !c.completionCondition,
    reasonCode: "COMPLETION_JUDGEMENT_REQUIRED",
    promptText: (c) => `「${c.title}」は何をもって完了とみなしますか？`,
    scoreComponents: () => ({ ambiguity: 0.85, downstreamImpact: 0.8, errorRisk: 0.7, answerCost: 0.15 }),
  },
  {
    code: "HARD_DEADLINE_LOW_CONFIDENCE",
    priority: "P0",
    targetField: "dateMentions",
    answerKind: "SELECTED",
    condition: (c) => hardDeadlineLowConfidence(c) !== undefined,
    reasonCode: "HARD_DEADLINE_CONFIDENCE_BELOW_THRESHOLD",
    promptText: (c) => {
      const m = hardDeadlineLowConfidence(c);
      return `「${c.title}」の期限として「${m?.rawExpression ?? "(不明)"}」を検出しましたが確信が持てません。これは締切ですか？`;
    },
    options: () => HARD_DEADLINE_CONFIRM_OPTIONS,
    scoreComponents: (c) => {
      const m = hardDeadlineLowConfidence(c);
      const confidence = m?.confidence ?? 0;
      return { ambiguity: Math.min(0.95, 1 - confidence), downstreamImpact: 0.85, errorRisk: 0.75, answerCost: 0.1 };
    },
  },
  {
    code: "UNKNOWNS_CLARIFICATION",
    priority: "P1",
    targetField: "unknowns",
    answerKind: "FREE_TEXT",
    condition: (c) => c.unknowns.length > 0,
    reasonCode: "AI_SELF_REPORTED_UNKNOWNS",
    promptText: (c) =>
      `「${c.title}」についてAIが自信を持てなかった点があります: ${c.unknowns.join(" / ")}。補足があれば教えてください。`,
    scoreComponents: () => ({ ambiguity: 0.8, downstreamImpact: 0.6, errorRisk: 0.6, answerCost: 0.15 }),
  },
  // [2026-08-30時点・意図的にcondition=false] P2(重要度・希望期限・説明補足)は
  // downstreamImpact/errorRiskを示す構造化signalが現行schemaに無いため、
  // 判定材料が揃うまで自動発生させない(このファイル冒頭コメント参照)。
  // Registry・promptTextは将来の構造化signal追加に備えて先行定義するが、
  // condition側を常にfalseにすることで実際には質問を生成しない。
  {
    code: "IMPORTANCE_MISSING",
    priority: "P2",
    targetField: "importance",
    answerKind: "SELECTED",
    condition: () => false,
    reasonCode: "IMPORTANCE_SIGNAL_UNAVAILABLE",
    promptText: (c) => `「${c.title}」の重要度を教えてください。`,
    options: () => IMPORTANCE_SELECT_OPTIONS,
    scoreComponents: () => ({ ambiguity: 0.3, downstreamImpact: 0.3, errorRisk: 0.2, answerCost: 0.1 }),
  },
  {
    code: "DESIRED_DATE_MISSING",
    priority: "P2",
    targetField: "dateMentions",
    answerKind: "FREE_TEXT",
    condition: () => false,
    reasonCode: "DESIRED_DATE_SIGNAL_UNAVAILABLE",
    promptText: (c) => `「${c.title}」の希望期限はありますか？`,
    scoreComponents: () => ({ ambiguity: 0.3, downstreamImpact: 0.3, errorRisk: 0.2, answerCost: 0.15 }),
  },
  {
    code: "DESCRIPTION_MISSING",
    priority: "P2",
    targetField: "description",
    answerKind: "FREE_TEXT",
    condition: () => false,
    reasonCode: "DESCRIPTION_SIGNAL_UNAVAILABLE",
    promptText: (c) => `「${c.title}」について補足しておきたいことはありますか？`,
    scoreComponents: () => ({ ambiguity: 0.25, downstreamImpact: 0.25, errorRisk: 0.15, answerCost: 0.2 }),
  },
];

/**
 * [2026-08-30新設・CLARIFYING UI対応] `FormationQuestion`テーブルには
 * questionCode/priority/reasonCode/promptText等は永続化されるが、`answerKind`
 * (SELECTED/FREE_TEXT)と`options`(SELECTED時の選択肢)はQuestion Code Registry
 * 側にのみ存在し、DBカラムとしては保存していない(schema.prisma参照、
 * M1-B5a §3.2で追加した列にこの2つは含まれない)。UI(FormationSessionPanel.tsx)は
 * 回答フォームを描画するためにこれらを知る必要があるため、Registryを唯一の
 * 正本としてlookupするexport関数を用意する(UI側で別途ハードコードして
 * 二重管理・drift させない)。
 */
export function getAnswerKindForQuestionCode(
  questionCode: QuestionCode,
): Extract<FormationAnswerKind, "SELECTED" | "FREE_TEXT"> {
  const def = QUESTION_CODE_REGISTRY.find((d) => d.code === questionCode);
  return def?.answerKind ?? "FREE_TEXT";
}

/**
 * SELECTED質問の選択肢一覧を返す(FREE_TEXT質問、またはoptionsが候補データに
 * 依存する定義の場合はundefinedを返す)。[2026-08-30時点]全SELECTED質問の
 * optionsは候補データに依存しない静的な値のため、questionCodeのみから
 * 一意に決まる(将来、候補依存のoptionsを持つquestionCodeを追加する場合は、
 * この関数のシグネチャ自体を候補入力ありに変更する必要がある)。
 */
export function getStaticQuestionOptions(
  questionCode: QuestionCode,
): Array<{ id: string; label: string }> | undefined {
  switch (questionCode) {
    case "HARD_DEADLINE_LOW_CONFIDENCE":
      return HARD_DEADLINE_CONFIRM_OPTIONS;
    case "IMPORTANCE_MISSING":
      return IMPORTANCE_SELECT_OPTIONS;
    default:
      return undefined;
  }
}

/** この候補1件について、生成しうる質問候補一覧(閾値未満は既にここで除外)を返す。 */
export function buildQuestionCandidatesForCandidate(candidate: ResponsibilityCandidate): QuestionCandidate[] {
  const out: QuestionCandidate[] = [];
  for (const def of QUESTION_CODE_REGISTRY) {
    if (!def.condition(candidate)) continue;
    const scoreComponents = def.scoreComponents(candidate);
    const score = computeQuestionScore(scoreComponents);
    if (score < QUESTION_SCORE_THRESHOLDS[def.priority]) continue;
    out.push({
      questionCode: def.code,
      priority: def.priority,
      targetField: def.targetField,
      reasonCode: def.reasonCode,
      promptText: def.promptText(candidate),
      answerKind: def.answerKind,
      options: def.options ? def.options(candidate) : undefined,
      scoreComponents,
      score,
    });
  }
  return out;
}

export interface SessionCandidateInput {
  /** FormationCandidateIdentity.id(DB確定後)またはcandidateKey(pre-persist時)。 */
  candidateRef: string;
  /** tie-break用の作成順(候補生成順、通常は配列index相当)。 */
  createdOrder: number;
  candidate: ResponsibilityCandidate;
}

export interface SelectedQuestion extends QuestionCandidate {
  candidateRef: string;
}

/**
 * Session全体でのQuestion選定(統合正本§6.4「最大3問/Session」)。
 *
 * @param candidates Session内の全候補(通常はANALYZING時点の全Revision)。
 * @param remainingSlots 残り生成可能数(= FORMATION_MAX_QUESTIONS - session.questionCount)。
 *   [指示書§3.4] 回答後の再評価でも生涯合計3問を超えないよう、呼び出し元が
 *   `FormationSession.questionCount`から算出して渡す(このpure関数はDBを見ない)。
 * @param alreadyAsked 既に質問済みの(candidateRef, questionCode)組。同じ組を再質問しない
 *   (指示書§3.4「同じcandidate/questionCodeを回答後に再質問しない」)。
 */
export function selectSessionQuestions(
  candidates: SessionCandidateInput[],
  remainingSlots: number,
  alreadyAsked: ReadonlySet<string> = new Set(),
): SelectedQuestion[] {
  if (remainingSlots <= 0) return [];

  const askedKey = (candidateRef: string, code: QuestionCode) => `${candidateRef}::${code}`;

  const pool: Array<SelectedQuestion & { createdOrder: number }> = [];
  for (const entry of candidates) {
    const qs = buildQuestionCandidatesForCandidate(entry.candidate);
    for (const q of qs) {
      if (alreadyAsked.has(askedKey(entry.candidateRef, q.questionCode))) continue;
      pool.push({ ...q, candidateRef: entry.candidateRef, createdOrder: entry.createdOrder });
    }
  }

  // tie-break(指示書§3.4): score降順 → P0>P1>P2 → candidate作成順 → questionCode安定順。
  pool.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (PRIORITY_ORDER[a.priority] !== PRIORITY_ORDER[b.priority]) {
      return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    }
    if (a.createdOrder !== b.createdOrder) return a.createdOrder - b.createdOrder;
    return a.questionCode.localeCompare(b.questionCode);
  });

  return pool.slice(0, remainingSlots).map((entry): SelectedQuestion => {
    const { candidateRef, questionCode, priority, targetField, reasonCode, promptText, answerKind, options, scoreComponents, score } = entry;
    return { candidateRef, questionCode, priority, targetField, reasonCode, promptText, answerKind, options, scoreComponents, score };
  });
}

/**
 * Answer → Candidate Revision reducer(指示書§4.1「answer→Candidate Revision reducer」)。
 * pure関数。既存proposedFields(=ResponsibilityCandidate相当)を直接変更せず、
 * 新しいオブジェクトを返す(FormationCandidateRevisionはimmutable・append-onlyのため、
 * 呼び出し元がこの戻り値で新規revision行を作る)。
 *
 * UNKNOWN/DEFERRED/DO_NOT_MATERIALIZEは「本人がまだ確定させない」という意思表示
 * であり、fieldへ値を書き込まない(指示書§4.3「SELF_REPORTとして記録し、FACTへ
 * 変換しない」はAnswer Event記録側の責務、こちらはRevision反映側の責務として
 * 「値を変えない」という形で対称に実装する)。
 */
export function applyAnswerToCandidate(
  candidate: ResponsibilityCandidate,
  questionCode: QuestionCode,
  answerKind: FormationAnswerKind,
  value: unknown,
): ResponsibilityCandidate {
  if (answerKind === "UNKNOWN" || answerKind === "DEFERRED" || answerKind === "DO_NOT_MATERIALIZE") {
    return candidate;
  }

  switch (questionCode) {
    case "COMMITMENT_COUNTERPARTY_MISSING":
    case "WAITING_COUNTERPARTY_MISSING": {
      if (answerKind !== "FREE_TEXT" || typeof value !== "string" || value.trim() === "") return candidate;
      return { ...candidate, counterparty: value.trim() };
    }
    case "COMPLETION_CONDITION_MISSING": {
      if (answerKind !== "FREE_TEXT" || typeof value !== "string" || value.trim() === "") return candidate;
      return { ...candidate, completionCondition: value.trim() };
    }
    case "HARD_DEADLINE_LOW_CONFIDENCE": {
      if (answerKind !== "SELECTED" || typeof value !== "string") return candidate;
      const target = hardDeadlineLowConfidence(candidate);
      if (!target) return candidate;
      const dateMentions = candidate.dateMentions.map((d) => {
        if (d !== target) return d;
        if (value === "CONFIRM_HARD_DEADLINE") return { ...d, confidence: 1 };
        if (value === "NOT_A_DEADLINE") return { ...d, meaning: "UNKNOWN" as const, confidence: 1 };
        return d;
      });
      return { ...candidate, dateMentions };
    }
    case "UNKNOWNS_CLARIFICATION": {
      if (answerKind !== "FREE_TEXT" || typeof value !== "string" || value.trim() === "") return candidate;
      // unknowns自体は「AIの自己申告」というaudit記録として残し(削除しない)、
      // 本人の補足はdescriptionへ追記する(既存descriptionを上書きしない)。
      const supplement = `[本人補足] ${value.trim()}`;
      const description = candidate.description ? `${candidate.description}\n${supplement}` : supplement;
      return { ...candidate, description };
    }
    case "IMPORTANCE_MISSING": {
      if (answerKind !== "SELECTED" || typeof value !== "string") return candidate;
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 5) return candidate;
      return { ...candidate, importance: n as 1 | 2 | 3 | 4 | 5 };
    }
    case "DESIRED_DATE_MISSING":
    case "DESCRIPTION_MISSING":
      // [2026-08-30時点] condition=falseのため実際には発火しないが、reducerとしては
      // 将来の構造化signal追加時にそのまま使えるよう安全なno-opにしておく。
      return candidate;
    default:
      return candidate;
  }
}
