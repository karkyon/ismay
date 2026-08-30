"use client";

import { useCallback, useEffect, useState, startTransition } from "react";
import { apiFetch, debugFetch } from "@/lib/auth/client";
import { debugLog } from "@/lib/debug";
import { formatRelativeTime } from "@/lib/format";
import {
  PROJECT_CONTEXT_LIFECYCLE_STATES,
  PROJECT_CONTEXT_LIFECYCLE_TRANSITIONS,
  PROJECT_CONTEXT_LINK_ROLES,
  VISIBILITIES,
  type ProjectContextLifecycleState,
  type ProjectContextLinkRole,
  type Visibility,
} from "@/lib/projectContext/coreTypes";

/**
 * /project-contexts: 軽量Project Context(M1-CTX-01)の一覧・作成・詳細画面。
 * 2026-08-27新設(V5-M1-A UI)。統合正本v5.0 8章、M1-A1(DB)・M1-A2(API)に続くUI部分。
 * ResponsibilitiesClient/TagsAdminClientと同じ「一覧+選択でinline詳細パネル」規約に揃える
 * (このGateでは/project-contexts/[id]のような別ルートは新設しない)。
 *
 * [DEC-M1A-UI-1] domainId選択UIはここでは出さない。POST /project-contextsはdomainId省略時に
 *   ensureDefaultWorkspaceの既定Domainを使うため(route.ts参照)、M1では既定Domain運用に揃える。
 * [DEC-M1A-UI-2] ExternalContextReferenceのdirection/syncPolicy/statusはCode Registry未確定
 *   (coreTypes.ts [DEC-5]参照)のため、UIもselectではなく自由入力のtext inputとする
 *   (存在しない値の集合を勝手に発明しない)。
 */

const LIFECYCLE_LABELS: Record<ProjectContextLifecycleState, string> = {
  ACTIVE: "進行中",
  PAUSED: "一時停止",
  COMPLETED: "完了",
  ARCHIVED: "Archive",
};

const VISIBILITY_LABELS: Record<Visibility, string> = {
  PRIVATE: "非公開",
  CONTEXT: "Context内",
  WORKSPACE: "Workspace",
  EXPLICIT: "明示共有",
};

const LINK_ROLE_LABELS: Record<ProjectContextLinkRole, string> = {
  PRIMARY: "主務(PRIMARY)",
  SUPPORTING: "支援(SUPPORTING)",
  REFERENCE: "参照(REFERENCE)",
};

interface ProjectContextListItem {
  id: string;
  name: string;
  description: string | null;
  lifecycleState: string;
  visibility: string;
  domainId: string;
  startedAt: string | null;
  targetEndAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface LinkedResponsibilityRef {
  id: string;
  title: string;
  type: string;
  status: string;
}

interface ContextLinkItem {
  id: string;
  responsibilityId: string;
  role: string;
  sourceKind: string;
  linkedAt: string;
  responsibility: LinkedResponsibilityRef;
}

interface ExternalReferenceItem {
  id: string;
  provider: string;
  externalWorkspaceKey: string;
  externalProjectKey: string;
  canonicalUrl: string | null;
  direction: string;
  syncPolicy: string;
  status: string;
  createdAt: string;
}

interface ProjectContextDetail extends ProjectContextListItem {
  links: ContextLinkItem[];
  externalReferences: ExternalReferenceItem[];
}

interface ResponsibilityPickerItem {
  id: string;
  title: string;
  type: string;
  status: string;
}

function nextIdempotencyKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `idem-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function ProjectContextsClient() {
  const [items, setItems] = useState<ProjectContextListItem[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [lifecycleFilter, setLifecycleFilter] = useState<string>("");
  const [listError, setListError] = useState("");

  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newVisibility, setNewVisibility] = useState<Visibility>("PRIVATE");
  const [createError, setCreateError] = useState("");

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProjectContextDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [transitioning, setTransitioning] = useState(false);

  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editVisibility, setEditVisibility] = useState<Visibility>("PRIVATE");
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState("");

  const [linkFormOpen, setLinkFormOpen] = useState(false);
  const [linkQuery, setLinkQuery] = useState("");
  const [linkCandidates, setLinkCandidates] = useState<ResponsibilityPickerItem[]>([]);
  const [linkTargetId, setLinkTargetId] = useState("");
  const [linkRole, setLinkRole] = useState<ProjectContextLinkRole>("SUPPORTING");
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState("");
  const [unlinkingId, setUnlinkingId] = useState<string | null>(null);

  const [refFormOpen, setRefFormOpen] = useState(false);
  const [refProvider, setRefProvider] = useState("");
  const [refWorkspaceKey, setRefWorkspaceKey] = useState("");
  const [refProjectKey, setRefProjectKey] = useState("");
  const [refUrl, setRefUrl] = useState("");
  const [refDirection, setRefDirection] = useState("READ_ONLY");
  const [refSyncPolicy, setRefSyncPolicy] = useState("MANUAL");
  const [refStatus, setRefStatus] = useState("ACTIVE");
  const [addingRef, setAddingRef] = useState(false);
  const [refError, setRefError] = useState("");

  const loadList = useCallback(async (lifecycleState: string) => {
    setLoadingList(true);
    setListError("");
    const qs = lifecycleState ? `?lifecycleState=${encodeURIComponent(lifecycleState)}` : "";
    const res = await debugFetch(`/api/v1/project-contexts${qs}`);
    if (res.ok) {
      const body = await res.json();
      debugLog.state("ProjectContextsClient", "projectContexts", { count: body.data.projectContexts.length });
      setItems(body.data.projectContexts);
    } else {
      const body = await res.json().catch(() => null);
      setListError(body?.error?.message ?? "一覧の取得に失敗しました");
    }
    setLoadingList(false);
  }, []);

  // [Gate Q0是正] react-hooks/set-state-in-effect対応(既存パターンを踏襲)。
  useEffect(() => {
    startTransition(() => {
      loadList(lifecycleFilter);
    });
  }, [loadList, lifecycleFilter]);

  const loadDetail = useCallback(async (id: string) => {
    setLoadingDetail(true);
    setDetailError("");
    const res = await debugFetch(`/api/v1/project-contexts/${id}`);
    if (res.ok) {
      const body = await res.json();
      setDetail(body.data.projectContext);
    } else {
      const body = await res.json().catch(() => null);
      setDetailError(body?.error?.message ?? "詳細の取得に失敗しました");
      setDetail(null);
    }
    setLoadingDetail(false);
  }, []);

  // [Gate Q0是正] react-hooks/set-state-in-effect対応(既存パターンを踏襲)。
  useEffect(() => {
    startTransition(() => {
      if (selectedId) {
        loadDetail(selectedId);
        setLinkFormOpen(false);
        setRefFormOpen(false);
        setEditOpen(false);
      } else {
        setDetail(null);
      }
    });
  }, [selectedId, loadDetail]);

  async function createContext(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim() || creating) return;
    setCreating(true);
    setCreateError("");
    const res = await apiFetch("/api/v1/project-contexts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: newName.trim(),
        description: newDescription.trim() ? newDescription.trim() : null,
        visibility: newVisibility,
      }),
    });
    if (res.ok) {
      const body = await res.json();
      setNewName("");
      setNewDescription("");
      setNewVisibility("PRIVATE");
      setCreateOpen(false);
      await loadList(lifecycleFilter);
      setSelectedId(body.data.id);
    } else {
      const body = await res.json().catch(() => null);
      setCreateError(body?.error?.message ?? "作成に失敗しました");
    }
    setCreating(false);
  }

  function openEdit() {
    if (!detail) return;
    setEditName(detail.name);
    setEditDescription(detail.description ?? "");
    setEditVisibility(detail.visibility as Visibility);
    setEditError("");
    setEditOpen(true);
  }

  async function saveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!detail || saving) return;
    setSaving(true);
    setEditError("");
    const res = await apiFetch(`/api/v1/project-contexts/${detail.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: editName.trim(),
        description: editDescription.trim() ? editDescription.trim() : null,
        visibility: editVisibility,
        version: detail.version,
      }),
    });
    if (res.ok) {
      setEditOpen(false);
      await Promise.all([loadDetail(detail.id), loadList(lifecycleFilter)]);
    } else {
      const body = await res.json().catch(() => null);
      setEditError(body?.error?.message ?? "更新に失敗しました");
    }
    setSaving(false);
  }

  async function transitionTo(next: ProjectContextLifecycleState) {
    if (!detail || transitioning) return;
    setTransitioning(true);
    setDetailError("");
    const res = await apiFetch(`/api/v1/project-contexts/${detail.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lifecycleState: next, version: detail.version }),
    });
    if (res.ok) {
      await Promise.all([loadDetail(detail.id), loadList(lifecycleFilter)]);
    } else {
      const body = await res.json().catch(() => null);
      setDetailError(body?.error?.message ?? "状態遷移に失敗しました");
    }
    setTransitioning(false);
  }

  async function openLinkForm() {
    setLinkError("");
    setLinkTargetId("");
    setLinkRole("SUPPORTING");
    setLinkFormOpen(true);
    if (linkCandidates.length === 0) {
      // [DEC-M1A-UI-3] responsibilities一覧APIはキーワード検索クエリを持たないため
      // (route.ts確認済み)、最新順に上限100件を取得しクライアント側で絞り込む。
      const res = await debugFetch(`/api/v1/responsibilities?limit=100&sort=updatedAt`);
      if (res.ok) {
        const body = await res.json();
        setLinkCandidates(
          (body.data.responsibilities as Array<{ id: string; title: string; type: string; status: string }>).map(
            (r) => ({ id: r.id, title: r.title, type: r.type, status: r.status }),
          ),
        );
      }
    }
  }

  async function submitLink(e: React.FormEvent) {
    e.preventDefault();
    if (!detail || !linkTargetId || linking) return;
    setLinking(true);
    setLinkError("");
    const res = await apiFetch(`/api/v1/project-contexts/${detail.id}/links`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": nextIdempotencyKey() },
      body: JSON.stringify({ responsibilityId: linkTargetId, role: linkRole }),
    });
    if (res.ok) {
      setLinkFormOpen(false);
      await loadDetail(detail.id);
    } else {
      const body = await res.json().catch(() => null);
      setLinkError(body?.error?.message ?? "Linkの作成に失敗しました");
    }
    setLinking(false);
  }

  async function unlink(responsibilityId: string) {
    if (!detail) return;
    setUnlinkingId(responsibilityId);
    const res = await apiFetch(`/api/v1/project-contexts/${detail.id}/links/${responsibilityId}`, {
      method: "DELETE",
      headers: { "Idempotency-Key": nextIdempotencyKey() },
    });
    if (res.ok) {
      await loadDetail(detail.id);
    } else {
      const body = await res.json().catch(() => null);
      setDetailError(body?.error?.message ?? "Unlinkに失敗しました");
    }
    setUnlinkingId(null);
  }

  async function submitExternalReference(e: React.FormEvent) {
    e.preventDefault();
    if (!detail || addingRef) return;
    if (!refProvider.trim() || !refWorkspaceKey.trim() || !refProjectKey.trim()) return;
    setAddingRef(true);
    setRefError("");
    const res = await apiFetch(`/api/v1/project-contexts/${detail.id}/external-references`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: refProvider.trim(),
        externalWorkspaceKey: refWorkspaceKey.trim(),
        externalProjectKey: refProjectKey.trim(),
        canonicalUrl: refUrl.trim() ? refUrl.trim() : null,
        direction: refDirection.trim(),
        syncPolicy: refSyncPolicy.trim(),
        status: refStatus.trim(),
      }),
    });
    if (res.ok) {
      setRefFormOpen(false);
      setRefProvider("");
      setRefWorkspaceKey("");
      setRefProjectKey("");
      setRefUrl("");
      await loadDetail(detail.id);
    } else {
      const body = await res.json().catch(() => null);
      setRefError(body?.error?.message ?? "外部参照の登録に失敗しました");
    }
    setAddingRef(false);
  }

  const availableTransitions = detail
    ? PROJECT_CONTEXT_LIFECYCLE_TRANSITIONS.filter((t) => t.from === detail.lifecycleState)
    : [];
  const filteredCandidates = linkCandidates.filter(
    (c) => !linkQuery.trim() || c.title.toLowerCase().includes(linkQuery.trim().toLowerCase()),
  );

  return (
    <div className="flex gap-6 h-full min-h-0">
      <div className="w-full max-w-md flex flex-col min-h-0">
        <div className="flex items-start justify-between mb-1">
          <div>
            <p className="text-xs text-faint font-mono mb-1">4. Project Context</p>
            <h1 className="font-serif text-3xl">案件</h1>
          </div>
          <button
            onClick={() => {
              setCreateOpen((v) => !v);
              setCreateError("");
            }}
            className="text-xs bg-ink text-white rounded-lg px-4 py-2 h-fit"
          >
            {createOpen ? "閉じる" : "＋ 新規Context"}
          </button>
        </div>
        <p className="text-sm text-muted mb-4">
          大型案件や小規模検討を、WBSではない軽量な文脈として保持します。配下の責任はここではLinkの役割(主務/支援/参照)でのみ束ねられ、Contextの状態変更が責任側の状態を連鎖変更することはありません。
        </p>

        {createOpen && (
          <form
            onSubmit={createContext}
            className="bg-surface border border-line rounded-2xl shadow-card p-4 mb-4 space-y-3"
          >
            {createError && <div className="text-xs text-red-600">{createError}</div>}
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Context名(必須)"
              className="w-full text-sm border border-line rounded-lg px-3 py-2 focus:outline-none focus:border-brand"
              autoFocus
            />
            <textarea
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
              placeholder="概要(任意)"
              rows={2}
              className="w-full text-sm border border-line rounded-lg px-3 py-2 focus:outline-none focus:border-brand"
            />
            <div className="flex items-center gap-2">
              <label className="text-xs text-faint">公開範囲</label>
              <select
                value={newVisibility}
                onChange={(e) => setNewVisibility(e.target.value as Visibility)}
                className="text-xs border border-line rounded-lg px-2 py-1.5"
              >
                {VISIBILITIES.map((v) => (
                  <option key={v} value={v}>
                    {VISIBILITY_LABELS[v]}
                  </option>
                ))}
              </select>
              <button
                type="submit"
                disabled={creating || !newName.trim()}
                className="ml-auto text-xs bg-ink text-white rounded-lg px-4 py-2 disabled:opacity-40"
              >
                作成
              </button>
            </div>
          </form>
        )}

        <div className="flex items-center gap-2 mb-3">
          <label className="text-xs text-faint">状態</label>
          <select
            value={lifecycleFilter}
            onChange={(e) => setLifecycleFilter(e.target.value)}
            className="text-xs border border-line rounded-lg px-2 py-1.5"
          >
            <option value="">すべて</option>
            {PROJECT_CONTEXT_LIFECYCLE_STATES.map((s) => (
              <option key={s} value={s}>
                {LIFECYCLE_LABELS[s]}
              </option>
            ))}
          </select>
        </div>

        {listError && <div className="text-xs text-red-600 mb-2">{listError}</div>}

        <div className="flex-1 min-h-0 overflow-y-auto">
          {loadingList ? (
            <p className="text-sm text-faint">読み込み中...</p>
          ) : items.length === 0 ? (
            <p className="text-sm text-faint px-1">まだProject Contextがありません。上のボタンから作成してください。</p>
          ) : (
            <div className="bg-surface border border-line rounded-2xl shadow-card divide-y divide-line">
              {items.map((item) => (
                <button
                  key={item.id}
                  onClick={() => setSelectedId(item.id)}
                  className={`w-full text-left px-4 py-3 hover:bg-canvas transition ${
                    selectedId === item.id ? "bg-canvas" : ""
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm text-ink font-medium truncate">{item.name}</span>
                    <span className="text-[10.5px] shrink-0 bg-canvas border border-line rounded-full px-2 py-0.5 text-muted">
                      {LIFECYCLE_LABELS[item.lifecycleState as ProjectContextLifecycleState] ?? item.lifecycleState}
                    </span>
                  </div>
                  <p className="text-[11px] text-faint mt-0.5">{formatRelativeTime(item.updatedAt)}に更新</p>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {!selectedId ? (
          <div className="h-full flex items-center justify-center text-sm text-faint">
            左の一覧からContextを選ぶと詳細が表示されます
          </div>
        ) : loadingDetail && !detail ? (
          <p className="text-sm text-faint">読み込み中...</p>
        ) : !detail ? (
          <div className="text-sm text-red-600">{detailError || "詳細を取得できませんでした"}</div>
        ) : (
          <div className="max-w-2xl space-y-6">
            {detailError && <div className="text-xs text-red-600">{detailError}</div>}

            <div className="bg-surface border border-line rounded-2xl shadow-card p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="font-serif text-2xl text-ink truncate">{detail.name}</h2>
                  {detail.description && <p className="text-sm text-muted mt-1 whitespace-pre-wrap">{detail.description}</p>}
                </div>
                <button onClick={openEdit} className="text-xs text-brand hover:underline shrink-0">
                  編集
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-2 mt-3">
                <span className="text-[10.5px] bg-canvas border border-line rounded-full px-2.5 py-1 text-muted">
                  {LIFECYCLE_LABELS[detail.lifecycleState as ProjectContextLifecycleState] ?? detail.lifecycleState}
                </span>
                <span className="text-[10.5px] bg-canvas border border-line rounded-full px-2.5 py-1 text-muted">
                  {VISIBILITY_LABELS[detail.visibility as Visibility] ?? detail.visibility}
                </span>
                {availableTransitions.map((t) => (
                  <button
                    key={t.to}
                    onClick={() => transitionTo(t.to)}
                    disabled={transitioning}
                    className="text-[10.5px] bg-ink text-white rounded-full px-2.5 py-1 disabled:opacity-40"
                  >
                    {LIFECYCLE_LABELS[t.to]}へ
                  </button>
                ))}
              </div>

              {editOpen && (
                <form onSubmit={saveEdit} className="mt-4 pt-4 border-t border-line space-y-3">
                  {editError && <div className="text-xs text-red-600">{editError}</div>}
                  <input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="w-full text-sm border border-line rounded-lg px-3 py-2 focus:outline-none focus:border-brand"
                  />
                  <textarea
                    value={editDescription}
                    onChange={(e) => setEditDescription(e.target.value)}
                    rows={2}
                    className="w-full text-sm border border-line rounded-lg px-3 py-2 focus:outline-none focus:border-brand"
                  />
                  <div className="flex items-center gap-2">
                    <select
                      value={editVisibility}
                      onChange={(e) => setEditVisibility(e.target.value as Visibility)}
                      className="text-xs border border-line rounded-lg px-2 py-1.5"
                    >
                      {VISIBILITIES.map((v) => (
                        <option key={v} value={v}>
                          {VISIBILITY_LABELS[v]}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => setEditOpen(false)}
                      className="ml-auto text-xs text-muted hover:underline"
                    >
                      キャンセル
                    </button>
                    <button
                      type="submit"
                      disabled={saving || !editName.trim()}
                      className="text-xs bg-ink text-white rounded-lg px-4 py-2 disabled:opacity-40"
                    >
                      保存
                    </button>
                  </div>
                </form>
              )}
            </div>

            <div className="bg-surface border border-line rounded-2xl shadow-card p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-ink">紐づく責任(Link)</h3>
                <button onClick={openLinkForm} className="text-xs text-brand hover:underline">
                  ＋ Link追加
                </button>
              </div>

              {linkFormOpen && (
                <form onSubmit={submitLink} className="mb-4 space-y-2 bg-canvas rounded-xl p-3">
                  {linkError && <div className="text-xs text-red-600">{linkError}</div>}
                  <input
                    value={linkQuery}
                    onChange={(e) => setLinkQuery(e.target.value)}
                    placeholder="責任名で絞り込み"
                    className="w-full text-xs border border-line rounded-lg px-2.5 py-1.5"
                  />
                  <select
                    value={linkTargetId}
                    onChange={(e) => setLinkTargetId(e.target.value)}
                    size={Math.min(6, Math.max(3, filteredCandidates.length))}
                    className="w-full text-xs border border-line rounded-lg px-2 py-1"
                  >
                    {filteredCandidates.length === 0 && <option value="">候補がありません</option>}
                    {filteredCandidates.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.title}({c.type}/{c.status})
                      </option>
                    ))}
                  </select>
                  <div className="flex items-center gap-2">
                    <select
                      value={linkRole}
                      onChange={(e) => setLinkRole(e.target.value as ProjectContextLinkRole)}
                      className="text-xs border border-line rounded-lg px-2 py-1.5"
                    >
                      {PROJECT_CONTEXT_LINK_ROLES.map((r) => (
                        <option key={r} value={r}>
                          {LINK_ROLE_LABELS[r]}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => setLinkFormOpen(false)}
                      className="ml-auto text-xs text-muted hover:underline"
                    >
                      キャンセル
                    </button>
                    <button
                      type="submit"
                      disabled={linking || !linkTargetId}
                      className="text-xs bg-ink text-white rounded-lg px-4 py-2 disabled:opacity-40"
                    >
                      Link
                    </button>
                  </div>
                </form>
              )}

              {detail.links.length === 0 ? (
                <p className="text-xs text-faint">まだLinkされた責任がありません。</p>
              ) : (
                <div className="divide-y divide-line">
                  {detail.links.map((link) => (
                    <div key={link.id} className="flex items-center justify-between gap-2 py-2">
                      <div className="min-w-0">
                        <p className="text-sm text-ink truncate">{link.responsibility.title}</p>
                        <p className="text-[11px] text-faint">
                          {LINK_ROLE_LABELS[link.role as ProjectContextLinkRole] ?? link.role} ・{" "}
                          {link.responsibility.type}/{link.responsibility.status}
                        </p>
                      </div>
                      <button
                        onClick={() => unlink(link.responsibilityId)}
                        disabled={unlinkingId === link.responsibilityId}
                        className="text-xs text-red-600 hover:underline shrink-0 disabled:opacity-40"
                      >
                        Unlink
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="bg-surface border border-line rounded-2xl shadow-card p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-ink">外部案件参照</h3>
                <button onClick={() => setRefFormOpen((v) => !v)} className="text-xs text-brand hover:underline">
                  {refFormOpen ? "閉じる" : "＋ 参照を登録"}
                </button>
              </div>
              <p className="text-xs text-faint mb-3">
                Meridian等の外部正本のID・URLをここへ保持します(read-only参照。自動refreshや外部write-backはこのGateでは行いません)。
              </p>

              {refFormOpen && (
                <form onSubmit={submitExternalReference} className="mb-4 space-y-2 bg-canvas rounded-xl p-3">
                  {refError && <div className="text-xs text-red-600">{refError}</div>}
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      value={refProvider}
                      onChange={(e) => setRefProvider(e.target.value)}
                      placeholder="provider(例: meridian)"
                      className="text-xs border border-line rounded-lg px-2.5 py-1.5"
                    />
                    <input
                      value={refWorkspaceKey}
                      onChange={(e) => setRefWorkspaceKey(e.target.value)}
                      placeholder="外部Workspace Key"
                      className="text-xs border border-line rounded-lg px-2.5 py-1.5"
                    />
                    <input
                      value={refProjectKey}
                      onChange={(e) => setRefProjectKey(e.target.value)}
                      placeholder="外部Project Key"
                      className="text-xs border border-line rounded-lg px-2.5 py-1.5"
                    />
                    <input
                      value={refUrl}
                      onChange={(e) => setRefUrl(e.target.value)}
                      placeholder="URL(任意)"
                      className="text-xs border border-line rounded-lg px-2.5 py-1.5"
                    />
                    <input
                      value={refDirection}
                      onChange={(e) => setRefDirection(e.target.value)}
                      placeholder="direction(例: READ_ONLY)"
                      className="text-xs border border-line rounded-lg px-2.5 py-1.5"
                    />
                    <input
                      value={refSyncPolicy}
                      onChange={(e) => setRefSyncPolicy(e.target.value)}
                      placeholder="syncPolicy(例: MANUAL)"
                      className="text-xs border border-line rounded-lg px-2.5 py-1.5"
                    />
                    <input
                      value={refStatus}
                      onChange={(e) => setRefStatus(e.target.value)}
                      placeholder="status(例: ACTIVE)"
                      className="text-xs border border-line rounded-lg px-2.5 py-1.5 col-span-2"
                    />
                  </div>
                  <div className="flex items-center justify-end gap-2">
                    <button
                      type="submit"
                      disabled={addingRef || !refProvider.trim() || !refWorkspaceKey.trim() || !refProjectKey.trim()}
                      className="text-xs bg-ink text-white rounded-lg px-4 py-2 disabled:opacity-40"
                    >
                      登録
                    </button>
                  </div>
                </form>
              )}

              {detail.externalReferences.length === 0 ? (
                <p className="text-xs text-faint">まだ外部参照がありません。</p>
              ) : (
                <div className="divide-y divide-line">
                  {detail.externalReferences.map((ref) => (
                    <div key={ref.id} className="py-2">
                      <p className="text-sm text-ink">
                        {ref.provider}: {ref.externalProjectKey}
                      </p>
                      <p className="text-[11px] text-faint">
                        {ref.direction} / {ref.syncPolicy} / {ref.status}
                        {ref.canonicalUrl && (
                          <>
                            {" ・ "}
                            <a href={ref.canonicalUrl} target="_blank" rel="noreferrer" className="text-brand hover:underline">
                              リンクを開く
                            </a>
                          </>
                        )}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
