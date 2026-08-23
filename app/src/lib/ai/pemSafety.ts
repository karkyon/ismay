/**
 * PEM SafetyValidator。
 * 出典: ISMAY_AI・PEM設計書v1.0 6章「PEMの目的と禁止」・10章「助言テンプレート」末尾の
 * 禁止例・13章「Prompt Injection・安全」・EVAL-04「根拠・母数・確度充足、安全違反」。
 *
 * 「あなたは計画性がない」「先延ばし癖がある」のような人格断定、医療心理診断、
 * 保護属性への言及、母数の記載が無い断定的な仮説文を検出する。違反時は呼び出し元
 * (pemOnboarding.ts / 今後実装のpemAdvice.ts)が非公開化しテンプレートへフォールバックする。
 *
 * [設計判断・2026-08-23] 完全な自然言語理解ではなく、キーワード・パターンベースの
 * 軽量検出とする(個人利用規模のMVP、かつ「検出漏れより誤検出の方が安全」という
 * 非負けの方針)。将来精度が問題になった場合はEVAL-05相当の評価データセットで
 * 閾値・パターンを調整する。
 */

/** 人格・能力の固定ラベル(「〜な人」「〜癖がある」等の断定表現)。 */
const PERSONALITY_LABEL_PATTERNS: RegExp[] = [
  /計画性が(ない|欠けて)/,
  /先延ばし(癖|グセ)/,
  /怠け(癖|グセ|がち)/,
  /(飽きっぽい|意志が弱い|だらしない)(性格|人|人間)?/,
  /(あなた|ユーザー)は.{0,10}(できない人|苦手な人)/,
];

/** 医療・心理診断を示唆する語。 */
const DIAGNOSIS_PATTERNS: RegExp[] = [/ADHD|注意欠陥|発達障害|うつ(病)?|双極性|診断/];

/** 保護属性(性別・年齢・国籍・障害等)への言及。 */
const PROTECTED_ATTRIBUTE_PATTERNS: RegExp[] = [
  /(男性|女性)だから/,
  /(高齢|若い)(から|ので)(できない|苦手)/,
  /(国籍|人種|宗教)/,
];

export interface PemSafetyCheckResult {
  safe: boolean;
  /** 検出された違反理由(複数可)。ログ・監査用。本文はそのまま保存せず理由コードのみ扱う。 */
  violations: string[];
}

export function checkPemSafety(text: string): PemSafetyCheckResult {
  const violations: string[] = [];
  if (PERSONALITY_LABEL_PATTERNS.some((p) => p.test(text))) violations.push("PERSONALITY_LABEL");
  if (DIAGNOSIS_PATTERNS.some((p) => p.test(text))) violations.push("DIAGNOSIS_LANGUAGE");
  if (PROTECTED_ATTRIBUTE_PATTERNS.some((p) => p.test(text))) violations.push("PROTECTED_ATTRIBUTE");
  return { safe: violations.length === 0, violations };
}

/**
 * 仮説文の母数充足チェック(§9「1件で恒常仮説を作らない」)。
 * sampleSizeが初期表示の推奨母数(5件)未満の場合はUI側で「一時観察」表示に留める必要があるが、
 * ここでは「母数0件で断定的に保存すること」自体を防ぐ最低限のガードとする。
 */
export function checkSampleSizeGuard(sampleSize: number): PemSafetyCheckResult {
  if (sampleSize <= 0) {
    return { safe: false, violations: ["MISSING_SAMPLE_SIZE"] };
  }
  return { safe: true, violations: [] };
}

/** 違反時のフォールバック文言(テンプレート)。 */
export const PEM_SAFETY_FALLBACK_MESSAGE =
  "すみません、うまく言葉にできませんでした。もう一度、状況を教えていただけますか。";
