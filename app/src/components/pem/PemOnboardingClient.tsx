"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, debugFetch } from "@/lib/auth/client";
import { debugLog } from "@/lib/debug";

interface ChatMessage {
  role: "assistant" | "user";
  content: string;
}

interface ProposedFact {
  kind: "FACT" | "SELF_REPORT";
  statement: string;
}

interface ProposedHypothesis {
  statement: string;
  confidence: number;
}

const STATE_ORDER = ["ROLE", "CURRENT_LOAD", "FIXED_CONSTRAINTS", "EXECUTION_CONTEXT", "VALUES", "REVIEW", "DONE"] as const;
type ConversationState = (typeof STATE_ORDER)[number];

const STATE_LABEL: Record<ConversationState, string> = {
  ROLE: "役割",
  CURRENT_LOAD: "現在責任",
  FIXED_CONSTRAINTS: "固定制約",
  EXECUTION_CONTEXT: "実行条件",
  VALUES: "判断価値",
  REVIEW: "確認",
  DONE: "完了",
};

/**
 * UI-02 初回対話。API-PEM-01(POST /pem/onboarding/messages)を呼び出す。
 * ワイヤーフレーム(ISMAY_画面UX設計書v2.1)のUI-02を実装として再現する。
 * 「後で続ける」でUI-03へ離脱しても、PemOnboardingConversationに保存された
 * ConversationStateから次回再開できる(サーバー側で保証)。
 */
export function PemOnboardingClient() {
  const router = useRouter();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [state, setState] = useState<ConversationState>("ROLE");
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [summary, setSummary] = useState<{ facts: number; hypotheses: number } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // 初回マウント時: 対話が既にある場合は状態確認のみ(GET)。無ければ最初の質問を
  // もらうため、空メッセージではなく「開始」相当の最初のPOSTを1回送る。
  useEffect(() => {
    let active = true;
    (async () => {
      const statusRes = await debugFetch("/api/v1/pem/onboarding/messages");
      if (!active) return;
      if (statusRes.ok) {
        const body = await statusRes.json();
        if (body.data.completed) {
          setCompleted(true);
          setLoading(false);
          return;
        }
        if (body.data.hasStarted) {
          // 続きから: 既存の対話は保存済みメッセージをそのまま表示したいが、GET側は
          // 一覧を返さない設計のため、ここでは状態だけ復元し、最初のメッセージ入力を
          // 促す(サーバー側の会話履歴は次のPOSTでそのまま使われる)。
          setState(body.data.state);
          setMessages([{ role: "assistant", content: "続きからお聞きしますね。" }]);
          setLoading(false);
          return;
        }
      }
      // 初回: skip=trueで最初の質問だけをもらう(ユーザー発言なしのターン)。
      const res = await apiFetch("/api/v1/pem/onboarding/messages", {
        method: "POST",
        body: JSON.stringify({ skip: true }),
      });
      if (!active) return;
      if (res.ok) {
        const body = await res.json();
        setMessages([{ role: "assistant", content: body.data.assistantMessage }]);
        setState(body.data.state);
      } else {
        debugLog.error("PemOnboardingClient", "初回質問取得に失敗", null);
      }
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, []);

  async function send(skip: boolean) {
    if (sending) return;
    const text = input.trim();
    if (!skip && !text) return;
    setSending(true);
    if (!skip) {
      setMessages((prev) => [...prev, { role: "user", content: text }]);
      setInput("");
    }
    try {
      const res = await apiFetch("/api/v1/pem/onboarding/messages", {
        method: "POST",
        body: JSON.stringify({ message: skip ? "" : text, skip }),
      });
      if (!res.ok) {
        debugLog.error("PemOnboardingClient", "送信失敗", null);
        return;
      }
      const body = await res.json();
      setMessages((prev) => [...prev, { role: "assistant", content: body.data.assistantMessage }]);
      setState(body.data.state);
      if (body.data.completion) {
        const facts = (body.data.proposedFacts as ProposedFact[] | undefined)?.length ?? 0;
        const hypotheses = (body.data.proposedHypotheses as ProposedHypothesis[] | undefined)?.length ?? 0;
        setSummary({ facts, hypotheses });
        setCompleted(true);
      }
    } finally {
      setSending(false);
    }
  }

  if (loading) {
    return <p className="text-sm text-faint">読み込み中...</p>;
  }

  if (completed) {
    return (
      <div className="max-w-xl mx-auto mt-6 bg-safe-50 border border-safe/20 rounded-2xl p-6 text-center">
        <div className="w-10 h-10 rounded-full bg-safe text-white mx-auto flex items-center justify-center mb-3">
          <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3}>
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </div>
        <p className="text-sm font-medium text-ink">暫定モデルができました</p>
        <p className="text-[12px] text-muted mt-1">
          {summary ? `事実${summary.facts}件・仮説${summary.hypotheses}件を記録しました。` : ""}
          運用しながら精度を上げていきます。あとからいつでも訂正できます。
        </p>
        <button
          onClick={() => router.push("/today")}
          className="mt-4 bg-ink text-white text-sm font-medium px-5 py-2.5 rounded-xl"
        >
          今日の画面へ進む
        </button>
      </div>
    );
  }

  const currentIndex = STATE_ORDER.indexOf(state);

  return (
    <div className="max-w-xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="font-serif text-2xl">はじめまして。少し教えてください</h1>
          <p className="text-sm text-muted mt-1">数値評価ではなく、会話からあなたの実行モデルを組み立てます</p>
        </div>
        <button onClick={() => router.push("/today")} className="text-xs text-faint hover:text-muted whitespace-nowrap ml-4">
          後で続ける
        </button>
      </div>

      <div className="flex items-center gap-1.5 mb-2">
        {STATE_ORDER.slice(0, 5).map((s, i) => (
          <div key={s} className={`h-1 flex-1 rounded-full ${i <= currentIndex ? "bg-brand" : "bg-line"}`} />
        ))}
      </div>
      <p className="text-[11px] font-mono text-faint mb-6">
        {STATE_ORDER.slice(0, 5)
          .map((s) => (s === state ? `[${STATE_LABEL[s]}]` : STATE_LABEL[s]))
          .join(" → ")}
      </p>

      <div className="space-y-4">
        {messages.map((m, i) =>
          m.role === "assistant" ? (
            <div key={i} className="flex gap-3">
              <div className="w-7 h-7 rounded-full bg-brand shrink-0 flex items-center justify-center text-white text-xs font-serif italic">
                i
              </div>
              <div className="bg-surface border border-line rounded-2xl rounded-tl-sm px-4 py-3 text-sm max-w-[85%] shadow-card whitespace-pre-wrap">
                {m.content}
              </div>
            </div>
          ) : (
            <div key={i} className="flex gap-3 justify-end">
              <div className="bg-brand text-white rounded-2xl rounded-tr-sm px-4 py-3 text-sm max-w-[85%] whitespace-pre-wrap">
                {m.content}
              </div>
            </div>
          ),
        )}
        <div ref={bottomRef} />
      </div>

      <div className="mt-6 flex items-center gap-2 bg-surface border border-line rounded-full px-2 py-1.5 shadow-card">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(false);
            }
          }}
          disabled={sending}
          className="flex-1 bg-transparent text-sm px-3 focus:outline-none"
          placeholder="返信を入力…"
        />
        <button
          onClick={() => send(false)}
          disabled={sending || !input.trim()}
          className="w-9 h-9 rounded-full bg-ink text-white flex items-center justify-center shrink-0 disabled:opacity-40"
        >
          <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
            <path d="M5 12h14M13 5l7 7-7 7" />
          </svg>
        </button>
      </div>
      <div className="flex items-center justify-between mt-3">
        <p className="text-[11px] text-faint">1ターンにつき質問は最大3問まで ・ FR-PEM-01/02</p>
        <button onClick={() => send(true)} disabled={sending} className="text-[11px] text-faint hover:text-muted underline disabled:opacity-40">
          この質問をスキップ
        </button>
      </div>
    </div>
  );
}
