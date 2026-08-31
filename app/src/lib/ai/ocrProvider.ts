/**
 * FR-CAP-02拡張: 画像(会議メモ写真・ホワイトボード等)のOCR文字起こしプロバイダーの
 * 共通インターフェース(2026-08-21新設)。lib/ai/transcriptionProvider.tsと同じ
 * 抽象化方針を踏襲する(AI事業者を切り替え可能にする、FR-AI-07)。
 *
 * [2026-08-21修正] 複数ページ(ノート数枚を1メモとして結合)対応のため、単一画像から
 * 画像配列(ページ順)へ変更した。Anthropic Vision APIは1リクエストで複数画像を
 * 受け付けられるため、ページをまたいだ文脈(「前ページの続き」等)を保ったまま
 * 1回のAPI呼び出しで書き起こせる(ページごとに個別OCRしてから文字列結合する方式より
 * 精度が高いと判断)。
 *
 * [M1-B6A §3.2.2・現状の記録] `pages`をAiTranscriptionSegmentと対になる形で
 * 型としては用意したが、現行実装(anthropicOcrProvider.ts)はこれを一切
 * 設定しない。理由: Anthropic Vision(Claude自身)は「複数ページを1つの連続した
 * 書き起こしとして結合してください」と明示的に指示しており(ページ境界を
 * 出力に含めない設計)、応答からpageIndex単位でtextを切り分ける手段が
 * 現状無い。true OCR API(bbox/confidenceを返す専用事業者)ではなく
 * vision-LLMによる自由文書き起こしのため、bbox座標やOCR confidenceに
 * 相当する情報もそもそも存在しない。想像でpageIndex=0を割り当てる、
 * confidenceを1.0で埋める等の捏造はしない。したがってIMAGE_BBOX Anchorは
 * 現行Providerでは常にUNAVAILABLE(TEXT Anchorへfallback)であり、これは
 * 「未実装」ではなく「現行アーキテクチャでは提供不能」という診断結果である。
 * 真のpage/bbox対応が必要になった場合、専用OCR事業者への切替
 * (registry.ts 1行追加で対応可能な設計、下記コメント参照)が前提となる。
 */

export interface AiOcrImageInput {
  buffer: Buffer;
  /** image/jpeg, image/png, image/gif, image/webp のいずれか。 */
  contentType: string;
  fileName: string;
}

export interface AiOcrInput {
  /** ページ順(pageIndex昇順)。1枚のみの場合も要素数1の配列。 */
  images: AiOcrImageInput[];
}

/** [M1-B6A §3.2.2新設] ページ単位の正規化OCR結果。上記型docの通り現行
 *  Providerからは得られないが、将来の真OCR事業者導入時にそのまま使える
 *  形で型を先に用意しておく。 */
export interface AiOcrPage {
  pageIndex: number;
  text: string;
  /** 0..1。Providerが返す場合のみ設定。 */
  confidence?: number;
}

export type AiOcrOutcome =
  | {
      ok: true;
      text: string;
      /** [M1-B6A §3.2.2新設] 現行Provider(anthropicOcrProvider.ts)は設定しない
       *  (上記型doc参照)。未設定=undefinedのまま。 */
      pages?: AiOcrPage[];
      usage: { inputTokens: number; outputTokens: number; latencyMs: number };
    }
  | {
      ok: false;
      kind: "TRANSIENT" | "FATAL";
      message: string;
      usage?: { inputTokens: number; outputTokens: number; latencyMs: number };
    };

export interface AiOcrProvider {
  providerName: string;
  modelName: string;
  extractText(input: AiOcrInput): Promise<AiOcrOutcome>;
  /** [2026-08-21追加] Batch API対応。対応プロバイダーのみ実装する(現状Anthropicのみ)。 */
  submitOcrBatch?(input: AiOcrInput): Promise<import("@/lib/ai/provider").AiBatchSubmitResult>;
  checkBatch?(batchId: string): Promise<import("@/lib/ai/provider").AiBatchCheckResult>;
  fetchOcrBatchResult?(resultsUrl: string): Promise<AiOcrOutcome>;
}
