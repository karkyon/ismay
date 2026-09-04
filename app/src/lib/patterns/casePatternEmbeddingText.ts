/**
 * Case Pattern Embedding入力テキスト構築(PATTERN-DETECT-01D新設・2026-09-04)。
 * 出典: Claude向け_ISMAY_0fcea2b以降_再監査是正・PATTERN-DETECT連続実装指示_2026-09-03.md
 * §5「Embedding入力は、正本の情報だけで決定論的に構成する」
 * (Responsibility/Candidateのtype、title/representative text、decomposition
 * templateの正規化表現、Project Contextの機密でない意味情報)。
 *
 * [scope注記] 現時点でこの関数が実際に受け取れるのはCasePatternRevisionが
 * 保持する情報(representativeText・decompositionTemplate)までであり、
 * 呼び出し元(Responsibility/Candidate/Context)側の個別フィールドを渡すかは
 * 呼び出し元の判断に委ねる(このモジュールはテキスト正規化の決定論的手順のみを
 * 担当し、どのデータソースから何を集めるかは知らない)。lib/ai/embeddingText.ts
 * (buildEmbeddingText、Responsibility用)と同型の設計だが、Case Pattern側は
 * JSON構造(decompositionTemplate)を含む点が異なるため別モジュールとする。
 */

export interface CasePatternEmbeddingTextInput {
  /** CasePatternRevision.representativeText、または候補側のtitle相当。 */
  representativeText: string;
  /** CasePatternRevision.decompositionTemplate(Json)。正規化のためkeyをソートしてから文字列化する。 */
  decompositionTemplate: unknown;
}

/** JSON.stringifyはkey順を保証しないため、決定論的な入力を得るためkeyをソートして再帰的に構築する。 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const entries = keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(",")}}`;
}

/**
 * Case Pattern比較用の決定論的テキストを構築する。同じ入力からは常に同じ
 * 文字列になる(key順の揺れによる無意味なembedding変化を防ぐ)。
 */
export function buildCasePatternEmbeddingText(input: CasePatternEmbeddingTextInput): string {
  const templateStr = stableStringify(input.decompositionTemplate ?? {});
  return [input.representativeText, templateStr].join("\n").slice(0, 8000);
}
