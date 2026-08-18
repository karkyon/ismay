"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/auth/client";
import { generateClientId } from "@/lib/uuid";

/**
 * UX原則「Capture First」: 分類・期限なしで10秒以内に保存できる入口。
 * どの主要画面からも同じ形で使えるよう共通コンポーネント化している。
 */
export function QuickCaptureForm({ onCreated }: { onCreated?: () => void }) {
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim() || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const res = await apiFetch("/api/v1/captures", {
        method: "POST",
        body: JSON.stringify({
          sourceType: "TEXT",
          rawText: text.trim(),
          clientDraftId: generateClientId(),
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error?.message ?? "保存に失敗しました");
        return;
      }
      setText("");
      onCreated?.();
    } catch {
      // ネットワーク断・応答不正等。ユーザーに見える形で伝える(以前は未処理例外のみだった)
      setError("通信に失敗しました。ネットワーク状態を確認してもう一度お試しください");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="bg-surface border border-line rounded-2xl shadow-card p-4">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="話す・メモする…（約束、気になっていること、判断が必要なことなど）"
        rows={3}
        className="w-full resize-none bg-transparent text-sm focus:outline-none placeholder:text-faint"
      />
      <div className="flex items-center justify-between mt-2 gap-3">
        <p className="text-[11px] text-faint">分類や期限は不要です。あとからInboxで整理できます</p>
        <button
          type="submit"
          disabled={submitting || !text.trim()}
          className="shrink-0 bg-ink text-white text-sm font-medium px-4 py-2 rounded-xl disabled:opacity-40 hover:bg-black transition"
        >
          {submitting ? "保存中..." : "保存する"}
        </button>
      </div>
      {error && <p className="text-sm text-red-600 mt-2">{error}</p>}
    </form>
  );
}