"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/auth/client";
import { generateClientId } from "@/lib/uuid";
import { debugLog } from "@/lib/debug";
import { MicIcon } from "@/components/icons";
import { FOCUS_CAPTURE_EVENT } from "@/components/app/AppShell";

// [2026-08-21再設計] Otter.aiの「Record / Import」を横並びタブにする構成を参考にした。
// カルキョンさんの指摘「音声ファイルどうやって登録するねん」「UIUXがわかりづらい」に対応。
// 従来は小さいボタン1つで音声投入を用意していたが発見性が低かったため、
// テキスト/音声を対等な入口として最上部に並べる形にした。
const ACCEPTED_AUDIO_EXTENSIONS = ["mp3", "mp4", "m4a", "wav", "webm", "ogg"];

type Mode = "text" | "audio";

/**
 * UX原則「Capture First」: 分類・期限なしで10秒以内に保存できる入口。
 * どの主要画面からも同じ形で使えるよう共通コンポーネント化している。
 *
 * "C"キー(AppShellがグローバルに拾う)でこのフォームへフォーカスできる
 * (Linearの"新規作成はどこからでも1キー"仕様を踏襲)。
 * 保存成功時は右下にトースト表示する(Linear/Height系の成功フィードバック)。
 */
export function QuickCaptureForm({ onCreated }: { onCreated?: () => void }) {
  const [mode, setMode] = useState<Mode>("text");
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [savedFlash, setSavedFlash] = useState(false);
  const [uploadingAudio, setUploadingAudio] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onFocusRequest() {
      setMode("text");
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
      flashSaved();
      onCreated?.();
    } catch (err) {
      debugLog.error("QuickCaptureForm", "submit", err);
      setError("通信に失敗しました。ネットワーク状態を確認してもう一度お試しください");
    } finally {
      setSubmitting(false);
    }
  }

  function flashSaved() {
    setSavedFlash(true);
    window.setTimeout(() => setSavedFlash(false), 2200);
  }

  async function uploadAudioFile(file: File) {
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    if (!ACCEPTED_AUDIO_EXTENSIONS.includes(ext)) {
      setError(`対応していない形式です(対応: ${ACCEPTED_AUDIO_EXTENSIONS.join(" / ")})`);
      return;
    }
    debugLog.event("QuickCaptureForm", "audio upload start", { fileName: file.name, size: file.size });
    setUploadingAudio(true);
    setError("");
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("clientDraftId", generateClientId());
      const res = await apiFetch("/api/v1/captures/audio", { method: "POST", body: form });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        debugLog.event("QuickCaptureForm", "audio upload failed", body?.error);
        setError(body?.error?.message ?? "音声のアップロードに失敗しました");
        return;
      }
      debugLog.event("QuickCaptureForm", "audio upload succeeded", body?.data);
      flashSaved();
      onCreated?.();
    } catch (err) {
      debugLog.error("QuickCaptureForm", "audio upload", err);
      setError("通信に失敗しました。ネットワーク状態を確認してもう一度お試しください");
    } finally {
      setUploadingAudio(false);
    }
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) void uploadAudioFile(file);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void uploadAudioFile(file);
  }

  return (
    <div className="relative">
      <div className="bg-surface border border-line rounded-2xl shadow-card overflow-hidden">
        {/* [2026-08-21追加] Otter.aiの「Record / Import」構成を踏襲したモード切替タブ。
            従来は音声投入が小さいボタン1つで発見しづらかったため、テキストと対等の
            入口として最上部に並べた。 */}
        <div className="flex border-b border-line">
          <button
            type="button"
            onClick={() => setMode("text")}
            className={`flex-1 flex items-center justify-center gap-2 py-2.5 text-xs font-semibold transition ${
              mode === "text" ? "bg-canvas text-ink" : "text-faint hover:text-muted"
            }`}
          >
            <MicIcon width={14} height={14} />
            話す・メモする
          </button>
          <button
            type="button"
            onClick={() => setMode("audio")}
            className={`flex-1 flex items-center justify-center gap-2 py-2.5 text-xs font-semibold transition border-l border-line ${
              mode === "audio" ? "bg-canvas text-ink" : "text-faint hover:text-muted"
            }`}
          >
            🎧 音声ファイルを取り込む
          </button>
        </div>

        {mode === "text" ? (
          <form onSubmit={submit} className="p-4">
            <textarea
              ref={textareaRef}
              value={text}
              onChange={(e) => handleChange(e.target.value)}
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
          </form>
        ) : (
          <div className="p-4">
            <input
              ref={audioInputRef}
              type="file"
              accept="audio/*,.mp3,.mp4,.m4a,.wav,.webm,.ogg"
              onChange={handleFileInput}
              className="hidden"
            />
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragActive(true);
              }}
              onDragLeave={() => setDragActive(false)}
              onDrop={handleDrop}
              onClick={() => !uploadingAudio && audioInputRef.current?.click()}
              className={`flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed py-8 cursor-pointer transition ${
                dragActive ? "border-brand bg-brand-50" : "border-line hover:border-brand/60 hover:bg-canvas"
              } ${uploadingAudio ? "opacity-60 pointer-events-none" : ""}`}
            >
              <span className="text-2xl">{uploadingAudio ? "⏳" : "🎧"}</span>
              <p className="text-sm font-medium text-ink">
                {uploadingAudio ? "アップロード中..." : "音声ファイルをドラッグ＆ドロップ、またはクリックして選択"}
              </p>
              <p className="text-[11px] text-faint">対応形式: mp3 / mp4 / m4a / wav / webm / ogg(25MBまで)</p>
            </div>
            <p className="text-[11px] text-faint mt-2">
              取り込むと自動で文字起こしされ、通常のメモと同じようにAIがタスク候補を抽出します。
            </p>
          </div>
        )}
        {error && <p className="text-sm text-red-600 px-4 pb-3">{error}</p>}
      </div>

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
