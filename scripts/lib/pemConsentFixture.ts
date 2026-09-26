/**
 * scripts/lib/pemConsentFixture.ts
 *
 * [AUDIT-BASELINE-01・2026-09-26新設] HTTP受入scriptのテストユーザーへ、本番と同じ正規経路
 * (`POST /api/v1/pem/consent`、認証Cookie+CSRF)でPEM同意をGRANTEDとして記録する。
 * DBへ行を直接挿入しないため、policyVersion・workspace/subject境界は本番の
 * `recordConsentEvent`がそのまま設定する。記録後の応答で「現行policyVersionで
 * GRANTED」になっていることまで確認し、満たさなければ例外にする(fixtureの失敗を
 * 後続試験の失敗と取り違えないため)。
 *
 * 背景: PEM-CONSENT-ENQUEUE-GATE以降、`POST /captures/{id}/analyze`は
 * PEM_AI_PROCESSING同意がGRANTEDでなければ403 CONSENT_REQUIREDを返す。
 * これを満たさないfixtureはGate M1-B1/B2の受入対象(shadow Session・dual-read)に到達できない。
 */

export type PemConsentTypeForFixture = "PEM_DATA_COLLECTION" | "PEM_AI_PROCESSING" | "PEM_PLANNING_APPLICATION";

type ApiFn<J> = (jar: J, method: string, path: string, body?: unknown) => Promise<{ status: number; json: any }>;

export async function grantPemConsentViaApi<J>(api: ApiFn<J>, jar: J, consentType: PemConsentTypeForFixture): Promise<void> {
  const res = await api(jar, "POST", "/api/v1/pem/consent", { consentType, action: "GRANTED", source: "SETTINGS" });
  if (res.status !== 201) {
    throw new Error(`${consentType}同意の付与に失敗しました: status=${res.status} body=${JSON.stringify(res.json)}`);
  }
  const state = res.json?.data?.consent?.[consentType];
  if (state?.action !== "GRANTED") {
    throw new Error(`${consentType}同意が現行policyVersionでGRANTEDになっていません: ${JSON.stringify(state)}`);
  }
}
