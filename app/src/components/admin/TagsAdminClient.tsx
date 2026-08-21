"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch, debugFetch } from "@/lib/auth/client";
import { debugLog } from "@/lib/debug";

interface TagItem {
  id: string;
  name: string;
  color: string;
  usageCount: number;
}

const COLOR_PALETTE = ["#2563eb", "#c026d3", "#ea580c", "#16a34a", "#dc2626", "#7c3aed", "#0891b2", "#6b7280"];

/**
 * /tags: タグの一覧・作成・リネーム・色変更・削除を行う管理画面。
 * 2026-08-21新設。カルキョンさんの指摘「カテゴリ、タグの管理はどこでやるんじゃ」に対応。
 * 従来はタスク詳細パネルからその場で作成することしかできず、専用の管理画面が
 * 存在しなかった。
 */
export function TagsAdminClient() {
  const [tags, setTags] = useState<TagItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(COLOR_PALETTE[0]);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const res = await debugFetch("/api/v1/tags");
    if (res.ok) {
      const body = await res.json();
      debugLog.state("TagsAdminClient", "tags", { count: body.data.tags.length });
      setTags(body.data.tags);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function createTag(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim() || creating) return;
    setCreating(true);
    setError("");
    const res = await apiFetch("/api/v1/tags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName.trim(), color: newColor }),
    });
    if (res.ok) {
      setNewName("");
      await load();
    } else {
      const body = await res.json().catch(() => null);
      setError(body?.error?.message ?? "作成に失敗しました");
    }
    setCreating(false);
  }

  async function saveRename(id: string) {
    if (!editName.trim()) return;
    const res = await apiFetch(`/api/v1/tags/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: editName.trim() }),
    });
    if (res.ok) {
      setEditingId(null);
      await load();
    } else {
      const body = await res.json().catch(() => null);
      setError(body?.error?.message ?? "更新に失敗しました");
    }
  }

  async function changeColor(id: string, color: string) {
    const res = await apiFetch(`/api/v1/tags/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ color }),
    });
    if (res.ok) await load();
  }

  async function deleteTag(id: string, usageCount: number) {
    if (usageCount > 0) {
      const ok = window.confirm(`このタグは${usageCount}件の責任に付いています。削除すると全て外れます。よろしいですか？`);
      if (!ok) return;
    }
    const res = await apiFetch(`/api/v1/tags/${id}`, { method: "DELETE" });
    if (res.ok) await load();
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <p className="text-xs text-faint font-mono mb-1">管理</p>
        <h1 className="font-serif text-3xl">タグ</h1>
        <p className="text-sm text-muted mt-1">
          責任に付けるタグの作成・名称変更・色変更・削除をここで行えます。タスク詳細画面からも作成できますが、一覧はここに集約されます。
        </p>
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3">{error}</div>}

      <form onSubmit={createTag} className="bg-surface border border-line rounded-2xl shadow-card p-4 flex items-center gap-3">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="新しいタグ名"
          className="flex-1 text-sm border border-line rounded-lg px-3 py-2 focus:outline-none focus:border-brand"
        />
        <div className="flex gap-1">
          {COLOR_PALETTE.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setNewColor(c)}
              style={{ background: c }}
              className={`w-6 h-6 rounded-full ${newColor === c ? "ring-2 ring-offset-2 ring-ink" : ""}`}
            />
          ))}
        </div>
        <button
          type="submit"
          disabled={creating || !newName.trim()}
          className="text-xs bg-ink text-white rounded-lg px-4 py-2 disabled:opacity-40"
        >
          追加
        </button>
      </form>

      {loading ? (
        <p className="text-sm text-faint">読み込み中...</p>
      ) : tags.length === 0 ? (
        <p className="text-sm text-faint px-1">まだタグがありません。上のフォームから作成してください。</p>
      ) : (
        <div className="bg-surface border border-line rounded-2xl shadow-card divide-y divide-line">
          {tags.map((tag) => (
            <div key={tag.id} className="flex items-center gap-3 px-4 py-3">
              <div className="flex gap-1">
                {COLOR_PALETTE.map((c) => (
                  <button
                    key={c}
                    onClick={() => changeColor(tag.id, c)}
                    style={{ background: c }}
                    className={`w-4 h-4 rounded-full ${tag.color === c ? "ring-2 ring-offset-1 ring-ink" : ""}`}
                    title={c}
                  />
                ))}
              </div>
              {editingId === tag.id ? (
                <input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && saveRename(tag.id)}
                  onBlur={() => saveRename(tag.id)}
                  autoFocus
                  className="flex-1 text-sm border border-line rounded-md px-2 py-1"
                />
              ) : (
                <button
                  onClick={() => {
                    setEditingId(tag.id);
                    setEditName(tag.name);
                  }}
                  className="flex-1 text-left text-sm text-ink hover:underline"
                  style={{ color: tag.color }}
                >
                  {tag.name}
                </button>
              )}
              <span className="text-xs text-faint">{tag.usageCount}件で使用中</span>
              <button onClick={() => deleteTag(tag.id, tag.usageCount)} className="text-xs text-red-600 hover:underline">
                削除
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
