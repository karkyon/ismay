import { Client } from "minio";

/**
 * MinIOオブジェクトストレージクライアント(2026-08-21新設)。
 * インフラ・運用設計書v1.1で定義済みのMinIOコンテナ(docker-compose.yml)に対し、
 * これまでアプリケーションコード側からの接続実装が一つも存在しなかった
 * (音声ファイル保存用に予約されていたのみ)。API-CAP-02(音声入力)実装の前提として
 * ここで初めて接続層を作る。
 *
 * 接続情報は環境変数から取得する。ローカル開発(docker-compose)の既定値を
 * フォールバックとして持つが、本番相当環境では必ず環境変数で上書きすること。
 */

let client: Client | null = null;

function getClient(): Client {
  if (client) return client;
  client = new Client({
    endPoint: process.env.MINIO_ENDPOINT ?? "localhost",
    port: Number(process.env.MINIO_PORT ?? 19000),
    useSSL: process.env.MINIO_USE_SSL === "true",
    accessKey: process.env.MINIO_ACCESS_KEY ?? "ismay_minio",
    secretKey: process.env.MINIO_SECRET_KEY ?? "ismay_minio_password",
  });
  return client;
}

const BUCKET_NAME = process.env.MINIO_BUCKET ?? "ismay-audio";

/** 初回起動時にバケットが無ければ作成する(冪等)。 */
export async function ensureBucketExists(): Promise<void> {
  const c = getClient();
  const exists = await c.bucketExists(BUCKET_NAME).catch(() => false);
  if (!exists) {
    await c.makeBucket(BUCKET_NAME, process.env.MINIO_REGION ?? "us-east-1");
  }
}

/**
 * 音声ファイルをMinIOへアップロードする。objectKeyはCapture.audioObjectKeyへ
 * そのまま保存する想定(workspaceId/captureId/元ファイル名、で衝突を避ける)。
 */
export async function uploadAudioObject(params: {
  objectKey: string;
  buffer: Buffer;
  contentType: string;
}): Promise<void> {
  await ensureBucketExists();
  const c = getClient();
  await c.putObject(BUCKET_NAME, params.objectKey, params.buffer, params.buffer.length, {
    "Content-Type": params.contentType,
  });
}

/** 保存済み音声ファイルを取得する(Worker側の文字起こし処理で使う)。 */
export async function downloadAudioObject(objectKey: string): Promise<Buffer> {
  const c = getClient();
  const stream = await c.getObject(BUCKET_NAME, objectKey);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export function buildAudioObjectKey(workspaceId: string, captureId: string, originalFileName: string): string {
  const safeName = originalFileName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80);
  return `${workspaceId}/${captureId}/${safeName}`;
}

/**
 * 画像ファイルをMinIOへアップロードする(2026-08-21新設、画像OCR機能用)。
 * バケットは音声と共用する(BUCKET_NAME)。用途別にバケットを分けるほどの規模ではないため、
 * 既存のMINIO_BUCKET設定・接続クライアントをそのまま流用する(汎用オブジェクトストレージとして運用)。
 */
export async function uploadImageObject(params: {
  objectKey: string;
  buffer: Buffer;
  contentType: string;
}): Promise<void> {
  await ensureBucketExists();
  const c = getClient();
  await c.putObject(BUCKET_NAME, params.objectKey, params.buffer, params.buffer.length, {
    "Content-Type": params.contentType,
  });
}

/** 保存済み画像ファイルを取得する(Worker側のOCR処理で使う)。 */
export async function downloadImageObject(objectKey: string): Promise<Buffer> {
  const c = getClient();
  const stream = await c.getObject(BUCKET_NAME, objectKey);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * [2026-08-21修正] 複数ページ(CaptureImage)対応のためpageIndexを必須引数に追加。
 * 同名ファイル(例: 全ページ"IMG_0001.jpg"のような連番リセットされたファイル名)が
 * 複数ページで衝突しMinIO上で上書きされる事故を防ぐ。
 */
export function buildImageObjectKey(workspaceId: string, captureId: string, pageIndex: number, originalFileName: string): string {
  const safeName = originalFileName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80);
  return `${workspaceId}/${captureId}/p${pageIndex}_${safeName}`;
}
