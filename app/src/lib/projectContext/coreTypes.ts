/**
 * V5-M1-A1 Project Context: 共通enum・語彙定義。
 * 出典: ISMAY-V5-DOC-04(Project Context・外部連携境界仕様書) 2章・3章・8.6節、
 *       ISMAY-V5-DOC-02(用語・状態・EventCode定義書) 4章(Visibility)・6章、
 *       ISMAY_統合正本仕様書_v5_0 8章。
 *
 * 既存 app/src/lib/pem/coreTypes.ts と同じ `as const + type + validator` 方式。
 * db.ts を import しないこと(tsxのdb非依存test runnerで検証できるようにするため。
 * app/src/lib/pem/__tests__ 系の既存パターンを踏襲)。
 *
 * 未確定事項(推測で埋めない。統合正本仕様書29章「未確定事項と実装停止条件」に対応):
 * - [DEC-1] ProjectContext.kind列は追加しない。統合正本仕様書8.4節は`kind`列を
 *   例示するが、29章2項「Context kind/lifecycleの最終Code Registry」は未確定と
 *   明記されており、対応分冊確定まで実装着手不可とされている。
 * - [DEC-5] ExternalContextReference.direction/syncPolicy/statusの具体的許容値は
 *   DOC-04のどの章にも列挙がなく、29章6項「External connector別scope、credential、
 *   replay防止」も未確定事項に指定されている。このため本ファイルではCode Registryを
 *   作らず、schema.prisma側はString列のみとする(値検証は connector詳細確定後の
 *   別Gateで追加)。
 */

/** ProjectContext lifecycle状態(DOC-04 3章、DOC-02 6章)。 */
export const PROJECT_CONTEXT_LIFECYCLE_STATES = [
  "ACTIVE",
  "PAUSED",
  "COMPLETED",
  "ARCHIVED",
] as const;
export type ProjectContextLifecycleState = (typeof PROJECT_CONTEXT_LIFECYCLE_STATES)[number];

/**
 * 許可されるlifecycle遷移(DOC-04 3章の表をそのまま正本化)。
 * ARCHIVEDは「任意」状態から到達可能だが、ARCHIVED自体からの遷移は
 * DOC-04に記載が無いため終端として扱う(推測で復帰経路を作らない)。
 */
export const PROJECT_CONTEXT_LIFECYCLE_TRANSITIONS: ReadonlyArray<{
  from: ProjectContextLifecycleState;
  to: ProjectContextLifecycleState;
}> = [
  { from: "ACTIVE", to: "PAUSED" },
  { from: "PAUSED", to: "ACTIVE" },
  { from: "ACTIVE", to: "COMPLETED" },
  { from: "PAUSED", to: "COMPLETED" },
  { from: "ACTIVE", to: "ARCHIVED" },
  { from: "PAUSED", to: "ARCHIVED" },
  { from: "COMPLETED", to: "ARCHIVED" },
] as const;

export function isValidProjectContextLifecycleState(value: string): value is ProjectContextLifecycleState {
  return (PROJECT_CONTEXT_LIFECYCLE_STATES as readonly string[]).includes(value);
}

/**
 * lifecycle遷移の妥当性を検証する純粋関数。DBやAPI層に依存しない
 * (M1-A1指示書2.4節「lifecycle transition validation」に対応)。
 */
export function isValidProjectContextLifecycleTransition(
  from: string,
  to: string,
): boolean {
  return PROJECT_CONTEXT_LIFECYCLE_TRANSITIONS.some((t) => t.from === from && t.to === to);
}

/** Context Link role(DOC-04 2章・8.6節)。 */
export const PROJECT_CONTEXT_LINK_ROLES = ["PRIMARY", "SUPPORTING", "REFERENCE"] as const;
export type ProjectContextLinkRole = (typeof PROJECT_CONTEXT_LINK_ROLES)[number];

export function isValidProjectContextLinkRole(value: string): value is ProjectContextLinkRole {
  return (PROJECT_CONTEXT_LINK_ROLES as readonly string[]).includes(value);
}

/** Context Link Event種別(統合正本仕様書8.4節 action(LINK/UNLINK))。 */
export const PROJECT_CONTEXT_LINK_EVENT_TYPES = ["LINK", "UNLINK"] as const;
export type ProjectContextLinkEventType = (typeof PROJECT_CONTEXT_LINK_EVENT_TYPES)[number];

/**
 * Visibility(DOC-02 4章。v5でProject Context含む複数Entityが横断利用する語彙)。
 * PEM固有ではないため pem/coreTypes.ts ではなくこのモジュールに定義する。
 */
export const VISIBILITIES = ["PRIVATE", "CONTEXT", "WORKSPACE", "EXPLICIT"] as const;
export type Visibility = (typeof VISIBILITIES)[number];

export function isValidVisibility(value: string): value is Visibility {
  return (VISIBILITIES as readonly string[]).includes(value);
}

/**
 * ProjectContextLink.sourceKind。既存 Responsibility.sourceKind
 * (schema.prisma コメント「USER/AI/IMPORT/SYSTEM」)と同じ語彙を再利用する
 * (新規語彙を発明しない)。
 */
export const PROJECT_CONTEXT_LINK_SOURCE_KINDS = ["USER", "AI", "IMPORT", "SYSTEM"] as const;
export type ProjectContextLinkSourceKind = (typeof PROJECT_CONTEXT_LINK_SOURCE_KINDS)[number];

export function isValidProjectContextLinkSourceKind(
  value: string,
): value is ProjectContextLinkSourceKind {
  return (PROJECT_CONTEXT_LINK_SOURCE_KINDS as readonly string[]).includes(value);
}

/** tenant scope入力の共通型(M1-A1指示書2.4節「tenant scope inputの型」)。 */
export interface TenantScopeInput {
  workspaceId: string;
}

/**
 * 同一Responsibilityに対し、既にactiveなPRIMARY linkが存在するかを判定する
 * 純粋関数。最終保証はDB側のpartial unique index
 * (project_context_links_one_active_primary)だが、Application層でも事前検出
 * できるようにする(M1-A1指示書2.4節「active PRIMARY競合をapplicationでも
 * 事前検出すること」)。
 */
export interface ActiveLinkLike {
  role: string;
  unlinkedAt: Date | null;
  responsibilityId: string;
}

export function hasConflictingActivePrimaryLink(
  existingActiveLinks: readonly ActiveLinkLike[],
  targetResponsibilityId: string,
): boolean {
  return existingActiveLinks.some(
    (link) =>
      link.unlinkedAt === null &&
      link.role === "PRIMARY" &&
      link.responsibilityId === targetResponsibilityId,
  );
}

/**
 * 同一(Context, Responsibility)組へのactive link重複を判定する純粋関数
 * (DOC-04 2章「active linkのみ一意」)。
 */
export function hasConflictingActiveLinkForSamePair(
  existingActiveLinks: readonly ActiveLinkLike[],
  targetResponsibilityId: string,
): boolean {
  return existingActiveLinks.some(
    (link) => link.unlinkedAt === null && link.responsibilityId === targetResponsibilityId,
  );
}
