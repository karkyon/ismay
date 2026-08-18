"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/auth/client";
import { generateClientId } from "@/lib/uuid";
import { debugLog } from "@/lib/debug";
import { MicIcon } from "@/components/icons";
import { FOCUS_CAPTURE_EVENT } from "@/components/app/AppShell";

/**
 * UX原則「Capture First」: 分類・期限なしで10秒以内に保存できる入口。
 * どの主要画面からも同じ形で使えるよう共通コンポーネント化している。
 *
 * "C"キー(AppShellがグローバルに拾う)でこのフォームへフォーカスできる
 * (Linearの"新規作成はどこからでも1キー"仕様を踏襲)。
 * 保存成功時は右下にトースト表示する(Linear/Height系の成功フィードバック)。
 */
export function QuickCaptureForm({ onCreated }: { onCreated?: () => void }) {
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [savedFlash, setSavedFlash] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    function onFocusRequest() {
      textareaRef.current?.focus();
    }
    window.addEventListener(FOCUS_CAPTURE_EVENT, onFocusRequest);
    return () => window.removeEventListener(FOCUS_CAPTURE_EVENT, onFocusRequest);
  }, []);

  function handleChange(value: string) {
    setText(value);
    debugLog.input("QuickCaptureForm", "text", value);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim() || submitting) return;
    debugLog.event("QuickCaptureForm", "submit start", { length: text.trim().length });
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
        debugLog.event("QuickCaptureForm", "submit failed", body?.error);
        setError(body?.error?.message ?? "保存に失敗しました");
        return;
      }
      debugLog.event("QuickCaptureForm", "submit succeeded", body?.data);
      setText("");
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 2200);
      onCreated?.();
    } catch (err) {
      debugLog.error("QuickCaptureForm", "submit", err);
      setError("通信に失敗しました。ネットワーク状態を確認してもう一度お試しください");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="relative">
      <form onSubmit={submit} className="bg-surface border border-line rounded-2xl shadow-card p-4">
        <div className="flex items-start gap-3">
          <MicIcon width={16} height={16} className="text-faint mt-0.5 shrink-0" />
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => handleChange(e.target.value)}
            placeholder="話す・メモする…（約束、気になっていること、判断が必要なことなど）"
            rows={3}
            className="flex-1 resize-none bg-transparent text-sm focus:outline-none placeholder:text-faint"
          />
        </div>
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

      <div
        aria-live="polite"
        className={`pointer-events-none fixed bottom-6 right-6 z-50 transition-all duration-300 ${
          savedFlash ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2"
        }`}
      >
        <div className="flex items-center gap-2 bg-ink text-white text-sm rounded-xl shadow-pop px-4 py-3">
          <span className="w-1.5 h-1.5 rounded-full bg-safe" />
          保存しました
        </div>
      </div>
    </div>
  );
}
