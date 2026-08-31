import { z } from "zod";
import { RESPONSIBILITY_TYPES } from "@/lib/responsibility";

/**
 * FN-AI-01 責任候補抽出のスキーマ。
 * 出典: ISMAY_AI・PEM設計書v1.0 3章「責任抽出スキーマ」。
 *
 * [重要] UNKNOWNをHard deadlineへ昇格しない、という設計書の明記事項は
 * スキーマ検証だけでは強制できないため、extract.ts側で追加ガードする。
 */

export const DATE_MEANINGS = ["HARD_DEADLINE", "SOFT_TARGET", "FOLLOW_UP", "EVENT", "UNKNOWN"] as const;

const DateMentionSchema = z.object({
  rawExpression: z.string().min(1).max(200),
  /// ISO 8601。解釈不能な場合はモデルが省略してよい(z.undefined相当)。
  /// [2026-08-28修正・実障害2件を反映]
  /// (a) offset:trueを指定しないとzodはUTC('Z'終端)のみ受理し、タイムゾーンオフセット
  ///     付き(例: "+09:00")を拒否する。本アプリはAsia/Tokyo運用(extract.ts
  ///     DEFAULT_TIMEZONE)であり、モデルがローカルタイムゾーンのオフセット付き日時を
  ///     返すのは自然かつ妥当な挙動なので、offset:trueで許容する。
  /// (b) モデルは時刻を伴わない日付のみ("2026-09-01")も高頻度で返す(時刻粒度が
  ///     不明な締切は当然の挙動)。z.string().datetime()は時刻部を必須とするため、
  ///     日付のみも受理できるようz.string().date()とのunionにする。
  /// (実障害: 日付言及を含む候補が高確率でInvalid ISO datetimeとして丸ごと
  /// 落ちていた。候補が1件しか無いCaptureでは、この1件がdropされるだけで
  /// Capture全体がAI_SCHEMA_INVALID→FAILEDになっていた)。
  normalizedAt: z.union([z.string().datetime({ offset: true }), z.string().date()]).optional(),
  meaning: z.enum(DATE_MEANINGS),
  timezone: z.string().min(1).max(64),
  confidence: z.number().min(0).max(1),
});

const EvidenceSpanSchema = z.object({
  /// Capture.rawText内の文字インデックス(0始まり、endは排他的)。UI側でハイライト表示に使う。
  start: z.number().int().min(0),
  end: z.number().int().min(0),
});

/**
 * [M1-B6B新設・2026-08-31指示書§Question Policy P2]
 * 「importance、desired date、location、tool、description補足は、単なる空欄では
 * 質問しない。AI/schemaまたは決定論ruleがambiguity/downstreamImpact/errorRisk/
 * answerCostを構造化して明示した場合だけP2候補にする」を実現するための構造化
 * signal。questionPolicy.tsのScoreComponentsと1対1対応する4値をAI(または
 * 将来の決定論rule)が明示した場合のみ、その値でP2質問のscoreを計算する
 * (questionPolicy.ts側の静的な既定値は使わない=「本当にこの候補で曖昧・
 * 重要」だとAIが判断した場合のみ質問が発生する)。
 *
 * [scope・2026-08-31時点] `field`は既存ResponsibilityCandidate fieldとして
 * 実在するimportance/dateMentions(希望期限)/descriptionの3種のみを対象とする。
 * location/toolは`TaskDetail`(schema.prisma)にのみ存在しCandidate側に対応
 * fieldが無いため、Candidate schema・reducer・TaskDetail materialize連携を
 * 揃えて拡張する必要がある大きめの変更になる。想像でCandidate側にlocation/tool
 * fieldだけ追加してmaterializeへの接続を後回しにすると「回答しても永続化
 * されない」壊れた状態を作るため、このPatchでは意図的に対象外とし、次の
 * 独立したPatchで扱う。
 *
 * `.strict()`により、想定外のfieldが1つでも含まれるとparse全体が失敗する
 * (「想像で新しいsignal語彙を受け入れない」既存方針をschema levelで強制する)。
 */
export const CLARIFICATION_SIGNAL_FIELDS = ["IMPORTANCE", "DESIRED_DATE", "DESCRIPTION"] as const;
export type ClarificationSignalField = (typeof CLARIFICATION_SIGNAL_FIELDS)[number];

const ClarificationSignalSchema = z
  .object({
    field: z.enum(CLARIFICATION_SIGNAL_FIELDS),
    ambiguity: z.number().min(0).max(1),
    downstreamImpact: z.number().min(0).max(1),
    errorRisk: z.number().min(0).max(1),
    answerCost: z.number().min(0).max(1),
  })
  .strict();
export type ClarificationSignal = z.infer<typeof ClarificationSignalSchema>;

export const ResponsibilityCandidateSchema = z
  .object({
    candidateId: z.string().min(1).max(64),
    type: z.enum(RESPONSIBILITY_TYPES),
    title: z.string().min(1).max(300),
    description: z.string().max(20000).optional(),
    actor: z.string().max(200).optional(),
    counterparty: z.string().max(200).optional(),
    dateMentions: z.array(DateMentionSchema).max(10).default([]),
    completionCondition: z.string().max(2000).optional(),
    negationOrChange: z.string().max(2000).optional(),
    evidenceSpans: z.array(EvidenceSpanSchema).min(1).max(20),
    confidence: z.number().min(0).max(1),
    unknowns: z.array(z.string().max(200)).max(10).default([]),
    // [2026-08-20追加] カルキョンさんの指示「重要度・親子関係の自動推定」に対応。
    // 1(低)〜5(高)。原文に重要度の手がかりが無い場合はモデルが省略してよく、
    // その場合はUI側で人手設定を促す(勝手に3等の既定値を作らない)。
    importance: z.number().int().min(1).max(5).optional(),
    // 同一抽出バッチ内(同じCapture由来)の他候補candidateIdのうち、この候補が
    // 完了する前提として必要なもの(前提条件・ブロック元)。責任間関係
    // (ResponsibilityRelation)の自動生成に使う。他Captureの候補までは
    // 参照できない(FN-GR-01の意味照合が別途必要な領域のため、ここでは
    // 同一原文内の明示的な依存関係のみを対象とする)。
    blockedByCandidateIds: z.array(z.string().max(64)).max(10).default([]),
    // [2026-08-21追加] カルキョンさんの指摘「音声ファイルの内容によりカテゴリやタグ付けが
    // 関連付けられるようになっているのか」に対応。既存タグ名と一致・類似するものが
    // あればモデルに挙げさせる(自由入力ではなく、原文の文脈から妥当なラベルを推定させる)。
    // 新規タグの自動作成は候補採用(ACCEPT)時に限り許可し、乱造を防ぐため最大3件に制限する。
    suggestedTags: z.array(z.string().max(50)).max(3).default([]),
    // [M1-B6B新設・2026-08-31指示書] 後方互換optional(.default([])のため旧AI
    // 応答・旧保存済みRevisionは自動的に空配列としてdual-readされ、既存の
    // 「P2は構造化signal無しでは発生しない」挙動を維持する。
    clarificationSignals: z.array(ClarificationSignalSchema).max(5).default([]),
  })
  .refine((c) => c.evidenceSpans.every((s) => s.end > s.start), {
    message: "evidenceSpansのendはstartより大きい必要があります",
  });

export const ExtractionResultSchema = z.object({
  candidates: z.array(ResponsibilityCandidateSchema).max(20),
  // [2026-08-21追加] カルキョンさんの指摘「生成データにタイトルと概要説明が
  // 関連付けられるようになっているのか」に対応。Capture一覧(Inbox)で原文の
  // 冒頭を機械的に切り詰めて表示していたのを、内容を要約した一言に置き換える。
  captureSummary: z.string().max(120).optional(),
});

export type ResponsibilityCandidate = z.infer<typeof ResponsibilityCandidateSchema>;
export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;

/**
 * [2026-08-28追加] ExtractionResultSchema(厳格版)は、20件中1件でも候補の
 * 構造が壊れていると"candidates"配列全体がinvalidになり、残り19件の正しい候補まで
 * 道連れで失われてAI_SCHEMA_INVALID→Capture=FAILEDになってしまう欠陥があった
 * (実例: claude-haiku-4-5がevidenceSpansを配列ではなく説明文字列で返した1件が
 * あっただけで、他の妥当な候補も含め抽出結果が丸ごと破棄された)。
 *
 * この関数は「候補単位」で検証し、壊れた候補だけを落として、有効な候補が
 * 1件でも残ればそれを採用する(全滅した場合のみ従来通り失敗扱いにする)。
 * トップレベルの形(candidatesが配列であること等)はそのまま厳格にチェックする
 * (AIの応答がJSON構造そのものとして壊れている場合は、個別候補の問題ではなく
 * 再試行対象の構造的失敗として扱う)。
 */
const ExtractionShapeSchema = z.object({
  candidates: z.array(z.unknown()).max(20),
  captureSummary: z.string().max(120).optional(),
});

export interface LenientExtractionParseSuccess {
  ok: true;
  candidates: ResponsibilityCandidate[];
  captureSummary?: string;
  /** 構造上位は妥当だが、個々の候補として検証に失敗し破棄した件数。 */
  droppedCount: number;
  /** 破棄理由(候補index付き)。debugServer.eventでの観測用。 */
  dropReasons: string[];
}
export interface LenientExtractionParseFailure {
  ok: false;
  reason: string;
}

/**
 * [2026-08-28追加] 実障害の再現: claude-haiku-4-5がまれに`candidates`フィールドを
 * (ツール呼び出しのJSON構造上は配列であるべきところ)JSON化した文字列として
 * 返すことがある(zodはこれを受け取ると、型不一致"expected array, received string"と、
 * 文字列としてのサイズ超過"Too big: expected string to have <=20 characters"の
 * 2つのissueを同時に出す。max(20)は本来「配列の要素数上限20」の意図だが、実行時の
 * 値が文字列だったためzod v4は文字列の長さとして評価している)。
 *
 * candidatesが文字列であり、かつそれが妥当なJSON配列としてparseできる場合のみ
 * 配列へ差し替える。parseに失敗する場合(本当に配列ではない不正な文字列)は、
 * 元のrawJsonのまま返し、従来通り構造的失敗として扱う(想像で救済範囲を広げない)。
 */
function coerceStringifiedCandidates(rawJson: unknown): unknown {
  if (
    typeof rawJson !== "object" ||
    rawJson === null ||
    !("candidates" in rawJson) ||
    typeof (rawJson as { candidates: unknown }).candidates !== "string"
  ) {
    return rawJson;
  }
  const candidatesStr = (rawJson as { candidates: string }).candidates;

  // 素直にJSONとしてparseを試みる(candidates文字列そのものが完全なJSON配列の場合)。
  const direct = tryParseJsonArray(candidatesStr);
  if (direct) return { ...(rawJson as Record<string, unknown>), candidates: direct };

  // [2026-08-28追加・実障害再現] claude-haiku-4-5が、配列自体は正しく閉じた直後に
  // 本来トップレベルの別フィールドであるべき内容(例: `<parameter
  // name="captureSummary">...` というXML風の余剰テキストや、`"captureSummary":
  // "..."` というJSONの続き)を同じcandidates文字列の中に混入させて返すことがある
  // (実ログで複数回確認)。配列部分自体は毎回有効なJSONとして完結しているため、
  // 文字列内で最後に現れる"]"までを配列の終端とみなして切り出し、再度parseを試みる。
  const lastBracket = candidatesStr.lastIndexOf("]");
  if (lastBracket !== -1) {
    const truncated = tryParseJsonArray(candidatesStr.slice(0, lastBracket + 1));
    if (truncated) return { ...(rawJson as Record<string, unknown>), candidates: truncated };
  }

  return rawJson;
}

function tryParseJsonArray(str: string): unknown[] | null {
  try {
    const parsed = JSON.parse(str);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function parseExtractionResultLenient(
  rawJson: unknown,
): LenientExtractionParseSuccess | LenientExtractionParseFailure {
  const shape = ExtractionShapeSchema.safeParse(coerceStringifiedCandidates(rawJson));
  if (!shape.success) {
    return { ok: false, reason: shape.error.issues.map((i) => i.message).join("; ").slice(0, 500) };
  }

  const candidates: ResponsibilityCandidate[] = [];
  const dropReasons: string[] = [];
  shape.data.candidates.forEach((item, index) => {
    const parsed = ResponsibilityCandidateSchema.safeParse(item);
    if (parsed.success) {
      candidates.push(parsed.data);
    } else {
      dropReasons.push(`candidates[${index}]: ${parsed.error.issues.map((i) => i.message).join(", ").slice(0, 200)}`);
    }
  });

  // 元々0件(AIが「抽出対象なし」と判断)は正常系。全滅(1件以上あったが全部壊れていた)のみ失敗扱い。
  if (candidates.length === 0 && shape.data.candidates.length > 0) {
    return {
      ok: false,
      reason: `全${shape.data.candidates.length}件の候補が個別検証に失敗しました: ${dropReasons.join(" | ").slice(0, 400)}`,
    };
  }

  return {
    ok: true,
    candidates,
    captureSummary: shape.data.captureSummary,
    droppedCount: dropReasons.length,
    dropReasons,
  };
}

/**
 * Anthropic Tool Use用のJSON Schema(手書き。上記zodスキーマと意味的に対応させる)。
 * zodスキーマは「保存前の最終防衛線」、こちらは「モデルに構造化出力を強制する側」であり、
 * 二重チェックになる(片方だけでは、モデルがJSON Schemaを無視した出力をした場合に守れない)。
 */
export const EXTRACTION_TOOL_JSON_SCHEMA = {
  type: "object",
  properties: {
    candidates: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        properties: {
          candidateId: { type: "string" },
          type: { type: "string", enum: RESPONSIBILITY_TYPES as unknown as string[] },
          title: { type: "string" },
          description: { type: "string" },
          actor: { type: "string" },
          counterparty: { type: "string" },
          dateMentions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                rawExpression: { type: "string" },
                normalizedAt: { type: "string", description: "ISO 8601。解釈不能なら省略" },
                meaning: { type: "string", enum: DATE_MEANINGS as unknown as string[] },
                timezone: { type: "string" },
                confidence: { type: "number" },
              },
              required: ["rawExpression", "meaning", "timezone", "confidence"],
            },
          },
          completionCondition: { type: "string" },
          negationOrChange: { type: "string" },
          evidenceSpans: {
            type: "array",
            items: {
              type: "object",
              properties: {
                start: { type: "integer" },
                end: { type: "integer" },
              },
              required: ["start", "end"],
            },
          },
          confidence: { type: "number", description: "0〜1" },
          unknowns: { type: "array", items: { type: "string" } },
          importance: {
            type: "integer",
            description: "1(低)〜5(高)。原文に手がかりが無ければ省略してよい",
          },
          blockedByCandidateIds: {
            type: "array",
            items: { type: "string" },
            description: "この候補の完了前提として必要な、同一原文内の他候補のcandidateId",
          },
          suggestedTags: {
            type: "array",
            items: { type: "string" },
            description: "この候補に付けるべきタグ名(最大3件)。既存タグ一覧が渡されている場合はそこから優先的に選ぶ",
          },
        },
        required: ["candidateId", "type", "title", "evidenceSpans", "confidence"],
      },
    },
    captureSummary: {
      type: "string",
      description: "原文全体を要約した一言(120文字以内)。一覧画面での表示用",
    },
  },
  required: ["candidates"],
} as const;
