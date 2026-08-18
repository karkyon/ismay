/**
 * crypto.randomUUID()はセキュアコンテキスト(HTTPS または localhost)専用のブラウザAPIで、
 * LAN IP経由の平文HTTP開発環境(例: http://192.168.1.11:13000)では利用できない
 * (2026-08-18発覚: QuickCaptureForm.tsxで保存が常に失敗していた原因)。
 *
 * crypto.getRandomValues()はセキュアコンテキストを問わず利用できるため、
 * これを用いたRFC 4122 version 4 UUID生成にフォールバックする。
 */
export function generateClientId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    try {
      return crypto.randomUUID();
    } catch {
      // 非セキュアコンテキスト等でここに落ちる。下のフォールバックへ進む。
    }
  }

  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  // version 4 / variant bits (RFC 4122)
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
}
