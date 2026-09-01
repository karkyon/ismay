import type { AiTranscriptionSegment } from "@/lib/ai/transcriptionProvider";

/**
 * app/src/lib/formation/transcriptSegmentMapping.ts
 *
 * V5-M1-B6C-2 Source Anchor live配線。
 * 出典: Claude向け ISMAY c503e72以降 M1-B6C・全残件連続実装指示(2026-08-31) §4。
 *
 * [設計方針] `AiTranscriptionSegment`(transcriptionProvider.ts)はProviderから
 * ミリ秒単位のtimecodeと、そのsegmentのtext(音声のその区間の書き起こし文)を
 * 持つが、Capture.rawText(=`outcome.text`、Provider応答の全体書き起こし文)内での
 * 文字offset(char offset)は持たない。候補のevidenceSpan(Capture本文への
 * 文字offset)をAUDIO_TIMECODE Anchorへ変換するには、この2つを橋渡しする
 * 文字offset位置を特定する必要がある。
 *
 * 本moduleは「各segmentのtextを、直前のsegmentが見つかった位置より後ろから
 * 順番に`rawText`内で探す」という決定論的・保守的な方法でこれを行う。
 * 見つからないsegmentは黙って捨てる(捏造しない。UNAVAILABLEへの安全な
 * fallbackは呼出元の責務)。
 *
 * [scope外・既知の限界] 音声の話題自動分割(transcribeAudioJob.ts
 * `processCompletedTranscription`のトピック分割)によりCaptureが複数へ
 * 分割された場合、分割後のCapture.rawTextは元の全文書き起こし(segmentsの
 * 算出元)のsubstringであり、かつ親Captureのrawtext自体も上書きされるため、
 * 分割後のどのCaptureからも「元の全文における自分の開始位置」を復元する手段が
 * 現行スキーマには無い。この場合、この関数群は(親・子いずれのCaptureに対しても)
 * 呼び出し元でsourceType==="VOICE"かつ`splitFromCaptureId`が無い場合に限定して
 * 呼ばれる想定とし、分割されたCaptureに対してはAUDIO_TIMECODE Anchor自体を
 * UNAVAILABLEのまま扱う(誤ったtimecodeを表示するくらいなら、無い方が安全)。
 */

export interface LocatedTranscriptSegment {
  segmentIndex: number;
  startMs: number;
  endMs: number;
  charStart: number;
  charEnd: number;
}

/**
 * segments配列を、rawText内での文字offsetが判明したものだけへ変換する。
 * 各segmentのtextを、直前に見つかったsegmentの終了位置以降から`indexOf`で
 * 探す(Provider応答の順序どおりに音声が進む前提)。見つからないsegment
 * (Providerの書き起こし文とtranscript全体文とで表記が微妙に異なる場合など)は
 * 結果配列に含めない。
 */
export function locateTranscriptSegmentCharOffsets(rawText: string, segments: AiTranscriptionSegment[]): LocatedTranscriptSegment[] {
  const located: LocatedTranscriptSegment[] = [];
  let searchFrom = 0;
  segments.forEach((segment, segmentIndex) => {
    if (!segment.text || segment.text.length === 0) {
      return; // 空文字は位置特定不能として捨てる(indexOfが常にsearchFromへ一致し誤判定するため)。
    }
    const idx = rawText.indexOf(segment.text, searchFrom);
    if (idx === -1) {
      return; // 捏造しない: 見つからないsegmentは黙って捨てる。
    }
    const charStart = idx;
    const charEnd = idx + segment.text.length;
    located.push({ segmentIndex, startMs: segment.startMs, endMs: segment.endMs, charStart, charEnd });
    searchFrom = charEnd;
  });
  return located;
}

/**
 * 候補のevidenceSpan(文字offset)を完全に内包するsegmentを1件だけ返す。
 * 複数segmentにまたがる場合、どのsegmentにも完全には含まれない場合は
 * (捏造せず)nullを返す。呼出元はUNAVAILABLEとして記録する。
 */
export function findAudioSegmentForSpan(located: LocatedTranscriptSegment[], spanStart: number, spanEnd: number): LocatedTranscriptSegment | null {
  return located.find((segment) => spanStart >= segment.charStart && spanEnd <= segment.charEnd) ?? null;
}
