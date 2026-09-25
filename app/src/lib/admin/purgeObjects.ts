/**
 * 30日PurgeのObject Storage(MinIO)段(PURGE-OPS-03B・2026-09-25新設、DB非依存)。
 *
 * DEC-PURGE-02B §7.1(利用者決定)の順序:
 *   1) DB・Object Storage対象を台帳へsnapshot → 2) MinIO object削除 → 3) object不存在を確認
 *   → 4) DB物理削除 → 5) 匿名化・監査記録 → 6) PurgeRun完了
 * DBを先に削除するとobject keyを失い回収不能になるため、object段はDB変更より前に行う。
 *
 * 削除対象objectは2系統の和集合でsnapshotする:
 *   - DB_REFERENCE: 削除対象行が持つobject key列(OBJECT_KEY_COLUMNS)。
 *   - PREFIX_LISTING: 対象workspaceのkey接頭辞(`${workspaceId}/`、lib/storage.tsの
 *     buildAudioObjectKey/buildImageObjectKeyと同じ規約)の一覧。upload成功後のDB更新
 *     失敗等でDBから参照されなくなったobjectも回収するため。
 */
import { createHash } from "node:crypto";

/**
 * object keyを保持する列の登録。schema.prismaに`ObjectKey`列を追加したらここにも
 * 追加すること(`__tests__/purgeObjects.test.ts`がschema.prismaとの一致を検査する)。
 */
export const OBJECT_KEY_COLUMNS: readonly { tableName: string; columnNames: readonly string[] }[] = [
  { tableName: "captures", columnNames: ["audio_object_key", "image_object_key"] },
  { tableName: "capture_images", columnNames: ["object_key"] },
];

/** lib/storage.tsのkey規約(`${workspaceId}/${captureId}/...`)に対応するworkspace単位の接頭辞。 */
export function workspaceObjectPrefix(workspaceId: string): string {
  if (!workspaceId || workspaceId.includes("/")) {
    throw new Error(`[purgeObjects] workspaceIdが不正です(接頭辞を作れません): ${workspaceId}`);
  }
  return `${workspaceId}/`;
}

/** 台帳に残すobject keyのhash(key自体は元ファイル名を含むため完了後に墨消しする)。 */
export function hashObjectKey(bucket: string, objectKey: string): string {
  return createHash("sha256").update(`${bucket}\u0000${objectKey}`).digest("hex");
}

/** Purgeが使うObject Storage操作(実装はlib/storage.tsのMinIO版。検証では障害注入用に差し替える)。 */
export interface PurgeObjectStore {
  readonly bucket: string;
  /** 接頭辞に一致する全objectのkey。 */
  list(prefix: string): Promise<string[]>;
  /** 指定keyを削除する(存在しないkeyは成功扱いでよい)。 */
  remove(keys: string[]): Promise<void>;
  /** objectが存在すればtrue。存在しなければfalse。それ以外の障害は例外。 */
  exists(key: string): Promise<boolean>;
}

export type PurgeObjectSource = "DB_REFERENCE" | "PREFIX_LISTING" | "LATE_PREFIX_LISTING";

export interface PurgeObjectTarget {
  objectKey: string;
  source: PurgeObjectSource;
}

/** DB参照keyと接頭辞一覧を重複除去して統合する(DB_REFERENCEを優先表示)。 */
export function mergeObjectTargets(dbKeys: string[], listedKeys: string[], listedSource: PurgeObjectSource = "PREFIX_LISTING"): PurgeObjectTarget[] {
  const map = new Map<string, PurgeObjectSource>();
  for (const k of dbKeys) if (k) map.set(k, "DB_REFERENCE");
  for (const k of listedKeys) if (k && !map.has(k)) map.set(k, listedSource);
  return [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([objectKey, source]) => ({ objectKey, source }));
}

export class ObjectVerificationError extends Error {
  constructor(readonly remainingKeyCount: number) {
    super(`[purgeObjects] 削除後もobjectが${remainingKeyCount}件残っています(不存在を確認できないためDB削除へ進みません)`);
  }
}

/** retry間隔(指数backoff、上限1時間)。attemptsは1始まり。 */
export function purgeRetryDelayMs(attempts: number): number {
  const base = 30_000 * 2 ** Math.max(0, attempts - 1);
  return Math.min(base, 60 * 60 * 1000);
}
