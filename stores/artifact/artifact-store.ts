/**
 * Artifact Store - manages artifacts, canvas documents, and analysis results.
 *
 * Ported from Cognia. Drops realtime-collaboration plumbing (no remote
 * Participants in this build) and the AI-workbench review/history retention
 * helpers (no AI workbench UI in cognia-next yet). The persisted shape stays
 * compatible with Cognia's `cognia-artifacts` localStorage namespace at
 * schema version 3 — fields the upstream app writes are silently kept on the
 * canvas document, just not exposed through the cognia-next surface.
 */

"use client"

import { create } from "zustand"
import { persist } from "zustand/middleware"
import { persistLocalStorage } from "@/stores/persist-storage"
import { nanoid } from "nanoid"
import { getPluginEventHooks } from "@/lib/plugin/messaging/hooks-system"
import { getPluginRateLimiter, RateLimitError } from "@/lib/plugin/security/rate-limiter"
import { loggers } from "@cognia/logging"
import { useCanvasSettingsStore } from "@/stores/canvas/canvas-settings-store"
import { useCanvasLayoutStore } from "@/stores/canvas/canvas-layout-store"
import { disposeCanvasDocument } from "@/lib/canvas/document-disposal"
import { useProjectStore } from "@/stores/project/project-store"
import { useChatStore } from "@/stores/chat"
import { registerProjectBucketPurger } from "@/lib/project/project-bucket-purge"
// Pure diff → hunk → apply engine (no `ai`/provider imports — safe for this
// persisted, widely-imported store). See lib/ai/generation/canvas-review.ts.
import {
  buildCanvasReview,
  applyAcceptedCanvasReviewItems,
} from "@/lib/ai/generation/canvas-review"

/**
 * Active workspace id for stamping new work products (Workspace isolation,
 * Dexie v86). Read lazily from the project store so this localStorage-backed
 * store never has to subscribe; `null` before the project store hydrates.
 */
function activeProjectId(): string | null {
  return useProjectStore.getState().activeProjectId
}

/**
 * The conversation the user is currently looking at. Read lazily for the same
 * reason as {@link activeProjectId} — this store is persisted and imported
 * nearly everywhere, so it must not subscribe to the chat store.
 *
 * `chatStore` does not import this module, so the dependency is one-way.
 */
function focusedSessionId(): string | null {
  return useChatStore.getState().activeSessionId
}
import type { PluginCanvasDocument } from "@/types/plugin/plugin"
import {
  buildArtifactSourceMetadata,
  buildDerivedArtifactMetadata,
  isDuplicateArtifactSource,
} from "@/lib/artifacts/source-metadata"
import type {
  Artifact,
  ArtifactType,
  ArtifactLanguage,
  ArtifactRuntimeHealth,
  SettledArtifactRuntimeHealth,
  ArtifactMetadata,
  ArtifactAuthoringOrigin,
  ArtifactWorkspaceScope,
  ArtifactWorkspaceState,
  ArtifactWorkspaceReturnContext,
  ArtifactVersion,
  CanvasActionHistoryEntry,
  CanvasAIWorkbenchState,
  CanvasEditorContext,
  CanvasDocument,
  CanvasDocumentVersion,
  CanvasSuggestion,
  CanvasPendingReview,
  CanvasReviewItemStatus,
  CanvasWorkbenchActionType,
  ArtifactDetectionConfig,
  ArtifactReviewReceipt,
  DetectedArtifact,
} from "@/types"

/**
 * Cap on staged review receipts. A session spent churning through proposals
 * must not grow the next prompt without bound; the oldest go first.
 */
const MAX_REVIEW_RECEIPTS = 10

/**
 * Stage a review outcome, keeping at most one receipt per artifact.
 *
 * Re-diffing and rejecting twice before sending is one thing to tell the
 * assistant, not two — and the latest verdict is the true one, so the newer
 * receipt replaces the older rather than queueing behind it.
 */
function appendReviewReceipt(
  receipts: ArtifactReviewReceipt[],
  next: ArtifactReviewReceipt
): ArtifactReviewReceipt[] {
  return [...receipts.filter((r) => r.artifactId !== next.artifactId), next].slice(
    -MAX_REVIEW_RECEIPTS
  )
}

/**
 * Value identity for a receipt. There is no id — `appendReviewReceipt` keys on
 * `artifactId` — so consuming one after a committed send compares the verdict
 * itself, letting a newer verdict for the same artifact survive.
 */
function reviewReceiptIdentity(r: ArtifactReviewReceipt): string {
  return `${r.sessionId}\0${r.artifactId}\0${r.outcome}\0${r.accepted}\0${r.total}`
}

/** Maximum number of auto-save canvas versions retained per document */
const MAX_CANVAS_AUTOSAVE_VERSIONS = 30

/**
 * How many past AI actions a document remembers. The history rides on the
 * document row, which is mirrored to Dexie on every change, so an unbounded
 * list would grow the write with the session.
 */
export const MAX_CANVAS_ACTION_HISTORY = 25

/** The empty workbench, so a document written before the field existed reads. */
export const DEFAULT_CANVAS_WORKBENCH: CanvasAIWorkbenchState = {
  promptDraft: "",
  selectedPresetAction: null,
  attachments: [],
  actionHistory: [],
  isInlineCommandOpen: false,
}
/**
 * The default persist bucket. Exported because the Dexie migration
 * (`lib/artifacts/localstorage-migration.ts`) has to read the same bucket the
 * store writes, and guessing the string there would silently miss the legacy
 * artifacts it exists to rescue.
 */
export const ARTIFACT_STORAGE_KEY = "cognia-artifacts"

function artifactAccountStorageKey(accountId: string): string {
  return `${ARTIFACT_STORAGE_KEY}:${accountId}`
}

/**
 * Synthetic plugin id used by host-side rate limiting for high-frequency
 * canvas dispatches. The token bucket per (pluginId, operation) lets us
 * debounce dispatches without dropping legitimate traffic.
 */
const HOST_RATE_LIMIT_OWNER = "__host:canvas__"
const CANVAS_CONTENT_CHANGE_OP = "canvas:contentChange"
const CANVAS_SELECTION_OP = "canvas:selection"

function ensureCanvasRateLimits(limiter: ReturnType<typeof getPluginRateLimiter>): void {
  // Register lazily on every call: the flag-on-module pattern desyncs if the
  // limiter singleton is reset (tests do this) while the flag stays true.
  // High-frequency editor events: cap at 30/sec each (≈one frame at 30fps).
  if (!limiter.getLimit(CANVAS_CONTENT_CHANGE_OP)) {
    limiter.setLimit(CANVAS_CONTENT_CHANGE_OP, { capacity: 30, refillPerSecond: 30 })
  }
  if (!limiter.getLimit(CANVAS_SELECTION_OP)) {
    limiter.setLimit(CANVAS_SELECTION_OP, { capacity: 30, refillPerSecond: 30 })
  }
}

function shouldDispatchHighFrequency(operation: string): boolean {
  const limiter = getPluginRateLimiter()
  ensureCanvasRateLimits(limiter)
  try {
    limiter.check(HOST_RATE_LIMIT_OWNER, operation)
    return true
  } catch (error) {
    if (error instanceof RateLimitError) return false
    // Unexpected limiter error — surface in debug logs but don't break the host.
    loggers.store.debug("canvas.rate-limit.unexpected-error", { operation })
    return false
  }
}

function lineColumnToOffset(
  content: string,
  position: { lineNumber: number; column: number }
): number {
  const lines = content.split("\n")
  let offset = 0
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1
    if (lineNumber === position.lineNumber) {
      return offset + Math.max(0, position.column - 1)
    }
    offset += lines[index].length + 1
  }
  return content.length
}

function selectionToOffsets(
  content: string,
  selection: CanvasEditorContext["selection"]
): { start: number; end: number; text: string } | null {
  if (!selection) return null
  const startLineNumber = (selection as { startLineNumber?: number }).startLineNumber
  const startColumn = (selection as { startColumn?: number }).startColumn
  const endLineNumber = (selection as { endLineNumber?: number }).endLineNumber
  const endColumn = (selection as { endColumn?: number }).endColumn
  if (
    typeof startLineNumber !== "number" ||
    typeof startColumn !== "number" ||
    typeof endLineNumber !== "number" ||
    typeof endColumn !== "number"
  ) {
    return null
  }
  const start = lineColumnToOffset(content, {
    lineNumber: startLineNumber,
    column: startColumn,
  })
  const end = lineColumnToOffset(content, {
    lineNumber: endLineNumber,
    column: endColumn,
  })
  const lo = Math.min(start, end)
  const hi = Math.max(start, end)
  return { start: lo, end: hi, text: content.slice(lo, hi) }
}

function toPluginCanvasDocument(doc: CanvasDocument): PluginCanvasDocument {
  return {
    id: doc.id,
    sessionId: doc.sessionId,
    title: doc.title,
    content: doc.content,
    language: (doc.language ?? "markdown") as PluginCanvasDocument["language"],
    type: doc.type,
    createdAt: ensureDate(doc.createdAt),
    updatedAt: ensureDate(doc.updatedAt),
    suggestions: doc.aiSuggestions,
    versions: doc.versions,
  }
}

/**
 * Helper to ensure Date objects are properly parsed from storage
 */
function ensureDate(date: Date | string): Date {
  return date instanceof Date ? date : new Date(date)
}

/**
 * Rehydrate artifact dates from storage
 */
function rehydrateArtifact(artifact: Artifact): Artifact {
  return {
    ...artifact,
    createdAt: ensureDate(artifact.createdAt),
    updatedAt: ensureDate(artifact.updatedAt),
    metadata: rehydrateArtifactMetadata(artifact.metadata),
  }
}

function rehydrateArtifactMetadata(metadata?: ArtifactMetadata): ArtifactMetadata | undefined {
  if (!metadata) return undefined

  return {
    ...metadata,
    lastAccessedAt: metadata.lastAccessedAt ? ensureDate(metadata.lastAccessedAt) : undefined,
  }
}

/**
 * Rehydrate canvas document dates from storage.
 *
 * Exported because the Dexie bridge reads the same shape back out of
 * IndexedDB, and coercing there too would be a second definition of which
 * fields are dates.
 */
export function rehydrateCanvasDocument(doc: CanvasDocument): CanvasDocument {
  return {
    ...doc,
    createdAt: ensureDate(doc.createdAt),
    updatedAt: ensureDate(doc.updatedAt),
    editorContext: rehydrateCanvasEditorContext(doc.editorContext),
    versions: doc.versions?.map((v) => ({
      ...v,
      createdAt: ensureDate(v.createdAt),
    })),
  }
}

function rehydrateCanvasEditorContext(
  context?: CanvasEditorContext
): CanvasEditorContext | undefined {
  if (!context) return undefined

  return {
    ...context,
    lastSavedAt: context.lastSavedAt ? ensureDate(context.lastSavedAt) : undefined,
    lastRestoredAt: context.lastRestoredAt ? ensureDate(context.lastRestoredAt) : undefined,
  }
}

function mergeCanvasEditorContext(
  current?: CanvasEditorContext,
  updates?: Partial<CanvasEditorContext>
): CanvasEditorContext | undefined {
  if (!current && !updates) return undefined

  const merged: CanvasEditorContext = {
    ...(current || {}),
    ...(updates || {}),
    selection:
      updates && "selection" in updates
        ? updates.selection
          ? { ...(current?.selection || {}), ...updates.selection }
          : updates.selection
        : current?.selection,
    visibleRange:
      updates && "visibleRange" in updates
        ? updates.visibleRange
          ? { ...(current?.visibleRange || {}), ...updates.visibleRange }
          : updates.visibleRange
        : current?.visibleRange,
    location:
      updates && "location" in updates
        ? updates.location
          ? {
              ...(current?.location || {}),
              ...updates.location,
              path: updates.location.path ?? current?.location?.path ?? [],
            }
          : updates.location
        : current?.location,
  }

  return rehydrateCanvasEditorContext(merged)
}

/**
 * Rehydrate the date-bearing maps of a persisted snapshot back into `Date`
 * objects. Zustand `persist` serializes `Date` to ISO strings, so without
 * this every direct consumer of the raw `canvasDocuments` / `artifacts` maps
 * (e.g. CanvasDocumentRail calling `updatedAt.getTime()`) would crash after a
 * reload. The per-action getters rehydrate on read, but the raw state maps must
 * be restored too.
 */
function rehydratePersistedArtifactState<T extends Partial<ArtifactState>>(state: T): T {
  const next = { ...state }
  if (next.artifacts) {
    next.artifacts = Object.fromEntries(
      Object.entries(next.artifacts).map(([id, artifact]) => [id, rehydrateArtifact(artifact)])
    )
  }
  if (next.canvasDocuments) {
    next.canvasDocuments = Object.fromEntries(
      Object.entries(next.canvasDocuments).map(([id, doc]) => [id, rehydrateCanvasDocument(doc)])
    )
  }
  return next
}

/** Retention policy — Settings → Canvas → Versions. */
export interface CanvasVersionRetention {
  /** Ceiling on the total number of versions kept for one document. */
  maxVersions: number
  /** Never prune a version the user named (gave a description). */
  keepNamedVersions: boolean
}

/**
 * The retention policy in force. `Settings → Canvas → Versions` writes
 * `maxVersions` + `keepNamedVersions`, and until this read existed neither
 * reached the store — the cap was the hard-coded
 * `MAX_CANVAS_AUTOSAVE_VERSIONS`, so raising or lowering the setting changed
 * nothing. Falls back to the constant when the settings store has not
 * hydrated (SSR, a fresh install, or a caller outside React).
 */
function currentVersionRetention(): CanvasVersionRetention {
  const version = useCanvasSettingsStore.getState?.().settings?.version
  const max = version?.maxVersions
  return {
    maxVersions:
      typeof max === "number" && Number.isFinite(max) && max > 0
        ? Math.floor(max)
        : MAX_CANVAS_AUTOSAVE_VERSIONS,
    keepNamedVersions: version?.keepNamedVersions !== false,
  }
}

/**
 * Prune a document's version list down to the retention ceiling, oldest first.
 *
 * `keepNamedVersions` (default on) makes a named version un-prunable, which is
 * the generalisation of the previous behaviour — that pruned only `isAutoSave`
 * entries and kept every manual one unconditionally. Turning it off lets the
 * ceiling apply to every version, which is the whole point of the switch.
 *
 * A list made ENTIRELY of protected versions is returned untouched: the ceiling
 * is a retention policy, not a mandate to delete work the user explicitly named.
 */
export function applyCanvasVersionRetention(
  versions: CanvasDocumentVersion[],
  retention: CanvasVersionRetention = currentVersionRetention()
): CanvasDocumentVersion[] {
  const { maxVersions, keepNamedVersions } = retention
  if (versions.length <= maxVersions) return versions

  const isProtected = (v: CanvasDocumentVersion) =>
    keepNamedVersions && !v.isAutoSave && Boolean(v.description?.trim())

  const prunable = versions
    .filter((v) => !isProtected(v))
    .sort((a, b) => ensureDate(a.createdAt).getTime() - ensureDate(b.createdAt).getTime())

  const overBy = versions.length - maxVersions
  if (overBy <= 0 || prunable.length === 0) return versions

  const removeIds = new Set(prunable.slice(0, Math.min(overBy, prunable.length)).map((v) => v.id))
  return versions.filter((v) => !removeIds.has(v.id))
}

const INITIAL_ARTIFACT_WORKSPACE: ArtifactWorkspaceState = {
  scope: "session",
  sessionId: null,
  searchQuery: "",
  typeFilter: "all",
  runtimeFilter: "all",
  recentArtifactIds: [],
  returnContext: null,
}

/**
 * Workspace isolation for Canvas documents — the same rule
 * {@link applyArtifactWorkspaceFilters} applies to artifacts, lifted into its
 * own helper because a Canvas document has no `artifactWorkspace` blob to carry
 * a search term or a type filter: workspace ownership is the only axis.
 *
 * Legacy documents (no `projectId`) are grandfathered — visible everywhere —
 * for parity with artifacts, and because `lib/db/project-scope-backfill.ts`
 * stamps them on the next boot anyway.
 */
export function filterCanvasDocumentsByWorkspace(
  documents: CanvasDocument[],
  projectId: string | null
): CanvasDocument[] {
  if (!projectId) return documents
  return documents.filter((doc) => !doc.projectId || doc.projectId === projectId)
}

function applyArtifactWorkspaceFilters(
  artifacts: Artifact[],
  workspace: ArtifactWorkspaceState,
  sessionId?: string | null
): Artifact[] {
  const activeSessionId =
    workspace.scope === "session" ? (sessionId ?? workspace.sessionId ?? null) : null
  const lowerQuery = workspace.searchQuery.trim().toLowerCase()
  // Workspace isolation (Dexie v86): hide artifacts owned by *another* project.
  // Legacy artifacts (no projectId) are grandfathered — visible everywhere.
  const projectId = activeProjectId()

  return artifacts.filter((artifact) => {
    if (projectId && artifact.projectId && artifact.projectId !== projectId) {
      return false
    }

    if (activeSessionId && artifact.sessionId !== activeSessionId) {
      return false
    }

    if (workspace.typeFilter !== "all" && artifact.type !== workspace.typeFilter) {
      return false
    }

    if (
      workspace.runtimeFilter !== "all" &&
      (artifact.metadata?.runtimeHealth ?? "ready") !== workspace.runtimeFilter
    ) {
      return false
    }

    if (!lowerQuery) {
      return true
    }

    return (
      artifact.title.toLowerCase().includes(lowerQuery) ||
      artifact.type.toLowerCase().includes(lowerQuery) ||
      (artifact.language && artifact.language.toLowerCase().includes(lowerQuery))
    )
  })
}

/** Tabs the dock will show at once *per session* before the oldest is dropped. */
export const MAX_OPEN_ARTIFACTS = 12

/**
 * Bucket key for artifacts that belong to no conversation — the plugin API
 * creates them with `sessionId: ""`, and the artifact workspace route browses
 * with no chat mounted at all. Matches the `?? "none"` the workbench already
 * uses to build a scope key so the two never disagree about which bucket a
 * session-less surface is looking at.
 */
export const NO_SESSION_KEY = "none"

export function artifactSessionKey(sessionId: string | null | undefined): string {
  return sessionId ? sessionId : NO_SESSION_KEY
}

/**
 * Append to the open-tab list, preserving open order (unlike the MRU recents
 * list, tabs must not reshuffle under the pointer when you switch between them).
 */
function withOpenArtifact(openArtifactIds: string[], artifactId: string): string[] {
  if (openArtifactIds.includes(artifactId)) return openArtifactIds
  return [...openArtifactIds, artifactId].slice(-MAX_OPEN_ARTIFACTS)
}

/** Replace one session's tab list, dropping the bucket once it empties. */
function withSessionTabs(
  bySession: Record<string, string[]>,
  sessionKey: string,
  tabs: string[]
): Record<string, string[]> {
  if (tabs.length === 0) {
    if (!(sessionKey in bySession)) return bySession
    const { [sessionKey]: _dropped, ...rest } = bySession
    return rest
  }
  return { ...bySession, [sessionKey]: tabs }
}

/**
 * Drop artifacts that no longer exist from every session's bucket at once.
 * Used by the delete/purge paths, which cannot know which sessions were hit.
 */
function pruneSessionTabs(
  bySession: Record<string, string[]>,
  survives: (artifactId: string) => boolean
): Record<string, string[]> {
  const next: Record<string, string[]> = {}
  for (const [sessionKey, tabs] of Object.entries(bySession)) {
    const kept = tabs.filter(survives)
    if (kept.length > 0) next[sessionKey] = kept
  }
  return next
}

function pruneSessionActive(
  bySession: Record<string, string | null>,
  resolve: (sessionKey: string, current: string | null) => string | null
): Record<string, string | null> {
  const next: Record<string, string | null> = {}
  for (const [sessionKey, current] of Object.entries(bySession)) {
    const resolved = resolve(sessionKey, current)
    if (resolved) next[sessionKey] = resolved
  }
  return next
}

/** The tabs one session has open. Stable empty array so selectors stay shallow-safe. */
export function selectOpenArtifactIds(
  state: Pick<ArtifactState, "openArtifactIdsBySession">,
  sessionId: string | null | undefined
): string[] {
  return state.openArtifactIdsBySession[artifactSessionKey(sessionId)] ?? EMPTY_ARTIFACT_IDS
}

/** The artifact one session is parked on. */
export function selectActiveArtifactId(
  state: Pick<ArtifactState, "activeArtifactIdBySession">,
  sessionId: string | null | undefined
): string | null {
  return state.activeArtifactIdBySession[artifactSessionKey(sessionId)] ?? null
}

const EMPTY_ARTIFACT_IDS: string[] = []

function updateRecentArtifactIds(
  recentArtifactIds: string[],
  artifactId: string,
  limit = 20
): string[] {
  return [artifactId, ...recentArtifactIds.filter((id) => id !== artifactId)].slice(0, limit)
}

/**
 * Pick the tab a session should fall back to after its active one disappeared.
 *
 * Constrained to `sessionKey`: every candidate — the return context, the MRU
 * recents, the newest artifact — is filtered to that session, because the dock
 * shows one conversation's tabs at a time and handing it an artifact from
 * another conversation is exactly the cross-session bleed this shape exists to
 * prevent.
 */
function resolveNextActiveArtifactId(
  artifacts: Record<string, Artifact>,
  workspace: ArtifactWorkspaceState,
  sessionKey: string
): string | null {
  const inSession = (artifactId: string): boolean => {
    const artifact = artifacts[artifactId]
    return Boolean(artifact) && artifactSessionKey(artifact.sessionId) === sessionKey
  }

  const returnContextArtifactId = workspace.returnContext?.activeArtifactId
  if (returnContextArtifactId && inSession(returnContextArtifactId)) {
    return returnContextArtifactId
  }

  const recentArtifactId = workspace.recentArtifactIds.find(inSession)
  if (recentArtifactId) {
    return recentArtifactId
  }

  const scopedArtifacts = Object.values(artifacts)
    .filter((artifact) => artifactSessionKey(artifact.sessionId) === sessionKey)
    .sort((a, b) => ensureDate(b.updatedAt).getTime() - ensureDate(a.updatedAt).getTime())

  return scopedArtifacts[0]?.id || null
}

interface ArtifactState {
  // Artifacts
  artifacts: Record<string, Artifact>
  /**
   * Keeps the legacy localStorage maps intact until the first authoritative
   * Dexie transaction commits. Persisted so a reload after a failed write
   * resumes the migration instead of silently cleaning the only copy.
   */
  artifactDexieMigrationPending: boolean
  /**
   * The artifact each chat session is parked on, keyed by session id (see
   * `artifactSessionKey`). Read it through `selectActiveArtifactId` /
   * `useActiveArtifactId` rather than indexing directly.
   *
   * Was a single global id. Switching conversations left it pointing at the
   * previous conversation's artifact, so the dock showed one session's tab
   * strip and preview next to another session's artifact list and browser.
   */
  activeArtifactIdBySession: Record<string, string | null>
  artifactVersions: Record<string, ArtifactVersion[]>
  artifactWorkspace: ArtifactWorkspaceState
  /**
   * Open AI-revision proposals awaiting per-hunk review, keyed by artifactId
   * (at most one per artifact). Transient — deliberately excluded from
   * `partialize` so a stale-baseline proposal can never survive a reload.
   */
  pendingReviews: Record<string, CanvasPendingReview>
  /**
   * What the user did with proposals the assistant made, waiting to be told to
   * the assistant on the next send.
   *
   * The revision round trip used to run one way only: a selection chip aimed a
   * turn at an artifact, the reply became a per-hunk proposal — and then
   * rejecting it (or accepting 2 of 5 hunks) just deleted the proposal. The
   * model was never told, so the next turn could confidently re-propose exactly
   * what the user had turned down.
   *
   * Same lifetime as a staged selection: in-memory, drained on send, never
   * persisted. Drained by session because a receipt only makes sense in the
   * conversation that produced the proposal.
   */
  reviewReceipts: ArtifactReviewReceipt[]

  // Canvas
  canvasDocuments: Record<string, CanvasDocument>
  activeCanvasId: string | null

  /**
   * Artifacts the user currently has open, in the order they were opened —
   * the dock's tab strip — bucketed by chat session. Deliberately NOT
   * `artifactWorkspace.recentArtifactIds`: that is an MRU history the workspace
   * page's "recent" scope browses, so closing a tab would silently erase
   * browsing history. Read it through `selectOpenArtifactIds` /
   * `useOpenArtifactIds`.
   *
   * `MAX_OPEN_ARTIFACTS` applies **per session**, so a busy conversation can
   * never evict another one's tabs.
   */
  openArtifactIdsBySession: Record<string, string[]>

  // Panel state
  /**
   * The artifact surface is engaged — it drives the panel's keyboard shortcuts
   * (Escape / ⌘S / ⌘E in `useArtifactPanelState`).
   *
   * **Not a visibility flag.** The narrow-screen Sheet's visibility belongs to
   * `artifactDockLayoutStore.mobileSheetOpen` alone, which is also the only
   * field that can see `userDismissed`. This used to double as that flag, and
   * because `createArtifact` / `setActiveArtifact` raise it unconditionally,
   * every new artifact threw a 92dvh Sheet over the conversation — including
   * immediately after the user swiped it away.
   */
  panelOpen: boolean
  /** Which resource surface the artifact panel is bound to. */
  panelView: "artifact" | "canvas"
}

interface ArtifactActions {
  // Artifact actions
  createArtifact: (params: {
    sessionId: string
    messageId: string
    type: ArtifactType
    title: string
    content: string
    language?: ArtifactLanguage
    metadata?: ArtifactMetadata
  }) => Artifact
  updateArtifact: (id: string, updates: Partial<Artifact>) => void
  /**
   * Record how the artifact's preview last settled.
   *
   * Deliberately not `updateArtifact`: that bumps `version` and `updatedAt`,
   * and a preview finishing its render is not an edit — routing this through it
   * would spin the version counter every time the user opens the panel. Follows
   * the same shape as the `lastAccessedAt` write in `setActiveArtifact`.
   *
   * A no-op for an unknown id, which is what synthetic previews (the Canvas
   * document projection) hand in.
   */
  setArtifactRuntimeHealth: (
    id: string,
    health: SettledArtifactRuntimeHealth,
    error?: string
  ) => void
  deleteArtifact: (id: string) => void
  /**
   * Drop an artifact's tab. When it was the active one, activate its neighbour
   * so the dock never lands on an empty surface with tabs still showing.
   */
  closeArtifact: (id: string) => void
  /**
   * Move an open tab to a new position (drag-reorder in the tab strip).
   * Only touches `openArtifactIds` — NOT `artifactWorkspace.recentArtifactIds`,
   * which is MRU history, not tab order.
   */
  reorderOpenArtifact: (id: string, toIndex: number) => void
  /**
   * Drop every artifact + canvas document owned by a workspace. Called by
   * `deleteProjectCascade` when a project is deleted (Workspace isolation).
   */
  purgeProject: (projectId: string) => void
  getArtifact: (id: string) => Artifact | undefined
  getSessionArtifacts: (sessionId: string) => Artifact[]
  /**
   * Park a session on an artifact. The session is derived from the artifact
   * itself, so callers never have to thread one through.
   *
   * Clearing (`id === null`) needs a session to clear, since there is one
   * active id per conversation — pass the session whose tab should be dropped.
   */
  setActiveArtifact: (id: string | null, sessionId?: string | null) => void
  setArtifactWorkspaceFilters: (filters: {
    searchQuery?: string
    typeFilter?: ArtifactType | "all"
    runtimeFilter?: ArtifactRuntimeHealth | "all"
  }) => void
  setArtifactWorkspaceScope: (scope: ArtifactWorkspaceScope, sessionId?: string | null) => void
  /**
   * Re-point the artifact list at a newly focused conversation.
   *
   * `artifactWorkspace` is one global blob, so a search term or type filter
   * typed in one conversation kept narrowing every conversation the user
   * switched to afterwards — usually down to nothing, with no visible cause.
   * The *preferences* (`scope`, `recentArtifactIds`) deliberately survive; only
   * the ad-hoc narrowing resets.
   *
   * Called from the single session-focus seam
   * (`components/providers/initializers/session-focus-initializer.tsx`).
   */
  resetSessionScopedWorkspaceFilters: (sessionId: string | null) => void
  setArtifactWorkspaceReturnContext: (context: ArtifactWorkspaceReturnContext | null) => void
  getArtifactsForWorkspace: (options?: { sessionId?: string | null; limit?: number }) => Artifact[]

  // Auto-detection and creation
  autoCreateFromContent: (params: {
    sessionId: string
    messageId: string
    content: string
    config?: Partial<ArtifactDetectionConfig>
  }) => Promise<Artifact[]>

  // AI-revision review (Codex-style per-hunk diff review)
  /**
   * Stage an AI revision of an existing artifact as a pending proposal instead
   * of overwriting it. Builds per-hunk review items via `buildCanvasReview`.
   * Returns `null` (no-op) when the artifact is missing or the proposed content
   * is identical to current (no hunks to review).
   */
  proposeArtifactUpdate: (
    id: string,
    proposedContent: string,
    meta?: { requestId?: string; actionType?: CanvasWorkbenchActionType }
  ) => CanvasPendingReview | null
  setReviewItemStatus: (id: string, itemId: string, status: CanvasReviewItemStatus) => void
  /**
   * Apply only the accepted hunks: snapshots the current content as a version,
   * merges accepted items via `applyAcceptedCanvasReviewItems`, writes the
   * result through `updateArtifact`, then clears the proposal. Items left
   * `pending` are treated as rejected.
   */
  applyArtifactReview: (id: string, changeDescription?: string) => void
  rejectArtifactReview: (id: string) => void
  getPendingReview: (id: string) => CanvasPendingReview | null
  /**
   * This session's pending review outcomes, without consuming them. The
   * composer reads them while building the prompt, then calls
   * `consumeReviewReceipts` once the send has actually committed.
   */
  peekReviewReceipts: (sessionId: string) => ArtifactReviewReceipt[]
  /**
   * Forget exactly the receipts that rode out on a committed message.
   *
   * Split from the read on purpose. Draining at build time lost the receipt for
   * good whenever the send then bailed — an empty payload, a declined oversize
   * confirm, or a throw inside `onSend` — and the assistant would go on
   * re-proposing what the user had already turned down. Matching on value
   * rather than clearing the whole session also protects a *newer* verdict for
   * the same artifact that landed while the message was in flight: it has not
   * been told to the assistant yet, so it must survive.
   */
  consumeReviewReceipts: (receipts: readonly ArtifactReviewReceipt[]) => void

  /**
   * Stage an AI revision of a Canvas document as a pending per-hunk proposal.
   * Reuses the same `pendingReviews` map + `buildCanvasReview` engine as
   * artifacts, keyed by the document id (canvas + artifact ids never collide).
   * Returns `null` when the document is missing or the content is unchanged.
   */
  proposeCanvasReview: (
    documentId: string,
    proposedContent: string,
    meta?: { requestId?: string; actionType?: CanvasWorkbenchActionType }
  ) => CanvasPendingReview | null
  /**
   * Apply only the accepted hunks of a Canvas proposal: snapshots a version,
   * merges via `applyAcceptedCanvasReviewItems`, writes the result through
   * `updateCanvasDocument`, then clears the proposal. No-op when stale.
   * Reuses the shared `setReviewItemStatus` / `getPendingReview` for per-hunk
   * status and lookup.
   */
  applyCanvasReview: (documentId: string, changeDescription?: string) => void
  rejectCanvasReview: (documentId: string) => void

  // Artifact version history
  saveArtifactVersion: (id: string, description?: string) => ArtifactVersion | null
  /**
   * Restore an artifact to an earlier version. The current state is auto-saved
   * to a new version first; pass `autoSaveDescription` to localize that entry's
   * `changeDescription` (defaults to the English fallback).
   */
  restoreArtifactVersion: (id: string, versionId: string, autoSaveDescription?: string) => void
  getArtifactVersions: (id: string) => ArtifactVersion[]

  // Canvas actions
  createCanvasDocument: (params: {
    sessionId?: string
    title: string
    content: string
    language: ArtifactLanguage
    type: "code" | "text"
    sourceArtifactId?: string
    returnContext?: ArtifactWorkspaceReturnContext | null
    authoringOrigin?: ArtifactAuthoringOrigin
  }) => string
  updateCanvasDocument: (id: string, updates: Partial<CanvasDocument>) => void
  deleteCanvasDocument: (id: string) => void
  setActiveCanvas: (id: string | null) => void

  // Canvas suggestions
  addSuggestion: (documentId: string, suggestion: Omit<CanvasSuggestion, "id">) => void
  updateSuggestionStatus: (
    documentId: string,
    suggestionId: string,
    status: CanvasSuggestion["status"]
  ) => void
  applySuggestion: (documentId: string, suggestionId: string) => void
  clearSuggestions: (documentId: string) => void

  // Canvas version history
  saveCanvasVersion: (
    documentId: string,
    description?: string,
    isAutoSave?: boolean
  ) => CanvasDocumentVersion | null
  /**
   * Restore a canvas document to an earlier version. The current state is
   * auto-saved first; pass `autoSaveDescription` to localize that entry.
   */
  restoreCanvasVersion: (
    documentId: string,
    versionId: string,
    autoSaveDescription?: string
  ) => void
  deleteCanvasVersion: (documentId: string, versionId: string) => void
  getCanvasVersions: (documentId: string) => CanvasDocumentVersion[]
  /**
   * Every Canvas document owned by the ACTIVE workspace, newest first.
   *
   * The rail, the summaries hook, the plugin API and the `canvas_read` tool all
   * used to read the raw `canvasDocuments` map, so switching workspace left the
   * previous workspace's documents on screen — and let a model in workspace A
   * read a document belonging to workspace B. This is the single scoped read
   * they now share; `canvasDocuments` stays the unscoped source of truth for
   * by-id lookups the caller has already authorised.
   */
  getCanvasDocumentsForWorkspace: (options?: {
    sessionId?: string | null
    limit?: number
  }) => CanvasDocument[]
  /**
   * One Canvas document by id, but only when the ACTIVE workspace owns it.
   * `null` is the same answer a caller gets for an id that does not exist —
   * deliberately, so a plugin or a model tool cannot distinguish "not yours"
   * from "not there" and use the difference to enumerate another workspace.
   */
  getCanvasDocumentForWorkspace: (id: string) => CanvasDocument | null
  /**
   * Patch a document's AI workbench state (draft prompt, chosen preset, staged
   * attachments, action history, inline-command visibility).
   *
   * `CanvasAIWorkbenchState` has been on the document type since it was
   * written, and the Dexie mirror has carried it since v206, but nothing ever
   * wrote to it: the workbench held its draft in component state and lost it
   * on every document switch. This is that state's only writer.
   */
  updateCanvasWorkbench: (documentId: string, patch: Partial<CanvasAIWorkbenchState>) => void
  /**
   * Record what the user asked for, so the panel can show the run again and
   * offer a re-run. Newest first, capped so a long session does not grow the
   * document row without bound.
   */
  appendCanvasActionHistory: (documentId: string, entry: CanvasActionHistoryEntry) => void
  /** Update one history entry in place, e.g. when its review is resolved. */
  updateCanvasActionHistoryEntry: (
    documentId: string,
    entryId: string,
    patch: Partial<CanvasActionHistoryEntry>
  ) => void
  compareVersions: (
    documentId: string,
    versionId1: string,
    versionId2: string
  ) => { v1: string; v2: string } | null

  // Panel actions
  openPanel: (view?: "artifact" | "canvas") => void
  closePanel: () => void
  setPanelView: (view: "artifact" | "canvas") => void

  // Utility
  clearSessionData: (sessionId: string) => void

  // Batch operations
  deleteArtifacts: (ids: string[]) => void
  duplicateArtifact: (id: string) => Artifact | null

  // Search and filter
  searchArtifacts: (query: string, sessionId?: string) => Artifact[]
  filterArtifactsByType: (type: ArtifactType, sessionId?: string) => Artifact[]
  getRecentArtifacts: (limit?: number) => Artifact[]
}

const initialState: ArtifactState = {
  artifacts: {},
  artifactDexieMigrationPending: false,
  activeArtifactIdBySession: {},
  artifactVersions: {},
  artifactWorkspace: INITIAL_ARTIFACT_WORKSPACE,
  openArtifactIdsBySession: {},
  pendingReviews: {},
  reviewReceipts: [],
  canvasDocuments: {},
  activeCanvasId: null,
  panelOpen: false,
  panelView: "artifact",
}

export const useArtifactStore = create<ArtifactState & ArtifactActions>()(
  persist(
    (set, get) => ({
      ...initialState,

      // Artifact actions
      createArtifact: ({ sessionId, messageId, type, title, content, language, metadata }) => {
        const artifact: Artifact = {
          id: nanoid(),
          sessionId,
          projectId: activeProjectId() ?? undefined,
          messageId,
          type,
          title,
          content,
          language,
          metadata,
          version: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        }

        const sessionKey = artifactSessionKey(sessionId)
        set((state) => ({
          artifacts: { ...state.artifacts, [artifact.id]: artifact },
          activeArtifactIdBySession: {
            ...state.activeArtifactIdBySession,
            [sessionKey]: artifact.id,
          },
          openArtifactIdsBySession: withSessionTabs(
            state.openArtifactIdsBySession,
            sessionKey,
            withOpenArtifact(state.openArtifactIdsBySession[sessionKey] ?? [], artifact.id)
          ),
          artifactWorkspace: {
            ...state.artifactWorkspace,
            sessionId,
            recentArtifactIds: updateRecentArtifactIds(
              state.artifactWorkspace.recentArtifactIds,
              artifact.id
            ),
          },
          panelOpen: true,
          panelView: "artifact",
        }))

        getPluginEventHooks().dispatchArtifactCreate(artifact)

        loggers.store.debug("artifacts.create", {
          id: artifact.id,
          type,
          sessionId,
          contentLength: content.length,
        })

        return artifact
      },

      purgeProject: (projectId) => {
        set((state) => {
          const artifacts = Object.fromEntries(
            Object.entries(state.artifacts).filter(([, a]) => a.projectId !== projectId)
          )
          const purgedCanvasIds = Object.entries(state.canvasDocuments)
            .filter(([, d]) => d.projectId === projectId)
            .map(([id]) => id)
          const canvasDocuments = Object.fromEntries(
            Object.entries(state.canvasDocuments).filter(([, d]) => d.projectId !== projectId)
          )
          // Tabs pointing at a purged workspace's documents would come back the
          // next time that id was reused, and render as ghost rows until then.
          useCanvasLayoutStore.getState().closeDocuments(purgedCanvasIds)
          for (const id of purgedCanvasIds) disposeCanvasDocument(id)
          // Keep reviews whose target (artifact OR canvas document) survives the
          // purge — canvas reviews share this map, keyed by document id.
          const pendingReviews = Object.fromEntries(
            Object.entries(state.pendingReviews).filter(
              ([reviewId]) => artifacts[reviewId] || canvasDocuments[reviewId]
            )
          )
          const removedActiveCanvas =
            state.activeCanvasId != null && !canvasDocuments[state.activeCanvasId]
          return {
            artifacts,
            canvasDocuments,
            pendingReviews,
            openArtifactIdsBySession: pruneSessionTabs(state.openArtifactIdsBySession, (id) =>
              Boolean(artifacts[id])
            ),
            activeArtifactIdBySession: pruneSessionActive(
              state.activeArtifactIdBySession,
              (_sessionKey, current) => (current && artifacts[current] ? current : null)
            ),
            activeCanvasId: removedActiveCanvas ? null : state.activeCanvasId,
          }
        })
      },

      updateArtifact: (id, updates) => {
        set((state) => {
          const artifact = state.artifacts[id]
          if (!artifact) return state

          const updated = {
            ...artifact,
            ...updates,
            version: artifact.version + 1,
            updatedAt: new Date(),
          }

          getPluginEventHooks().dispatchArtifactUpdate(updated, updates)

          loggers.store.debug("artifacts.update", {
            id,
            fieldsChanged: Object.keys(updates),
          })

          // If a proposal is open against this artifact and the content moved
          // out from under it, mark the proposal stale so the review surface
          // can prompt the user to re-diff or discard. Content-only check: a
          // metadata-only update (e.g. lastAccessedAt) shouldn't invalidate.
          const contentMoved = "content" in updates && updates.content !== artifact.content
          const openReview = state.pendingReviews[id]
          const pendingReviews =
            contentMoved && openReview && !openReview.isStale
              ? { ...state.pendingReviews, [id]: { ...openReview, isStale: true } }
              : state.pendingReviews

          return {
            artifacts: { ...state.artifacts, [id]: updated },
            pendingReviews,
          }
        })
      },

      setArtifactRuntimeHealth: (id, health, error) => {
        set((state) => {
          const artifact = state.artifacts[id]
          if (!artifact) return state

          const runtimeError = health === "error" ? error : undefined
          // Bail on an unchanged value: the preview re-reports on every remount,
          // and a fresh object here would re-render every subscriber for nothing.
          if (
            artifact.metadata?.runtimeHealth === health &&
            artifact.metadata?.runtimeError === runtimeError
          ) {
            return state
          }

          return {
            artifacts: {
              ...state.artifacts,
              [id]: {
                ...artifact,
                metadata: { ...artifact.metadata, runtimeHealth: health, runtimeError },
              },
            },
          }
        })
      },

      deleteArtifact: (id) => {
        set((state) => {
          const { [id]: _removed, ...rest } = state.artifacts
          const { [id]: _removedReview, ...pendingReviews } = state.pendingReviews
          const recentArtifactIds = state.artifactWorkspace.recentArtifactIds.filter(
            (artifactId) => artifactId !== id
          )
          const nextWorkspace = {
            ...state.artifactWorkspace,
            recentArtifactIds,
            returnContext:
              state.artifactWorkspace.returnContext?.activeArtifactId === id
                ? null
                : state.artifactWorkspace.returnContext,
          }
          getPluginEventHooks().dispatchArtifactDelete(id)
          loggers.store.info("artifacts.delete", {
            id,
            sessionId: state.artifacts[id]?.sessionId,
          })
          return {
            artifacts: rest,
            pendingReviews,
            artifactWorkspace: nextWorkspace,
            activeArtifactIdBySession: pruneSessionActive(
              state.activeArtifactIdBySession,
              (sessionKey, current) =>
                current === id
                  ? resolveNextActiveArtifactId(rest, nextWorkspace, sessionKey)
                  : current
            ),
            openArtifactIdsBySession: pruneSessionTabs(
              state.openArtifactIdsBySession,
              (openId) => openId !== id
            ),
          }
        })
      },

      closeArtifact: (id) => {
        set((state) => {
          const sessionKey = artifactSessionKey(state.artifacts[id]?.sessionId)
          const current = state.openArtifactIdsBySession[sessionKey] ?? []
          const openArtifactIds = current.filter((openId) => openId !== id)
          if (openArtifactIds.length === current.length) return state

          const openArtifactIdsBySession = withSessionTabs(
            state.openArtifactIdsBySession,
            sessionKey,
            openArtifactIds
          )
          if (state.activeArtifactIdBySession[sessionKey] !== id) {
            return { openArtifactIdsBySession }
          }

          // Prefer the tab that took this one's slot, else the one before it —
          // the same neighbour a closed editor tab hands focus to.
          const closedIndex = current.indexOf(id)
          const neighbour = openArtifactIds[closedIndex] ?? openArtifactIds[closedIndex - 1] ?? null
          return {
            openArtifactIdsBySession,
            activeArtifactIdBySession: {
              ...state.activeArtifactIdBySession,
              [sessionKey]: neighbour,
            },
          }
        })
      },

      reorderOpenArtifact: (id, toIndex) => {
        set((state) => {
          const sessionKey = artifactSessionKey(state.artifacts[id]?.sessionId)
          const current = state.openArtifactIdsBySession[sessionKey] ?? []
          const fromIndex = current.indexOf(id)
          if (fromIndex === -1) return state
          const clamped = Math.max(0, Math.min(current.length - 1, toIndex))
          if (clamped === fromIndex) return state
          const openArtifactIds = [...current]
          openArtifactIds.splice(fromIndex, 1)
          openArtifactIds.splice(clamped, 0, id)
          return {
            openArtifactIdsBySession: withSessionTabs(
              state.openArtifactIdsBySession,
              sessionKey,
              openArtifactIds
            ),
          }
        })
      },

      getArtifact: (id) => {
        const artifact = get().artifacts[id]
        return artifact ? rehydrateArtifact(artifact) : undefined
      },

      getSessionArtifacts: (sessionId) =>
        Object.values(get().artifacts)
          .filter((a) => a.sessionId === sessionId)
          .map(rehydrateArtifact)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),

      setActiveArtifact: (id, sessionId) => {
        // Which conversation's dock this activation lands in, most specific
        // first: the caller's explicit argument, then the conversation the user
        // is actually looking at, then the artifact's own session.
        //
        // The artifact's own session used to win outright, which broke every
        // cross-session open: revealing an artifact from the "recent" scope (or
        // the artifacts workspace route) while focused on another conversation
        // wrote the active id into a bucket nothing was reading — the dock
        // expanded and showed the old content — *and* silently overwrote the
        // owning conversation's parked artifact.
        const targetSessionId = sessionId ?? focusedSessionId()
        const clearKey = artifactSessionKey(targetSessionId)
        const previousId = id ? null : (get().activeArtifactIdBySession[clearKey] ?? null)
        set((state) => {
          if (!id) {
            return {
              activeArtifactIdBySession: {
                ...state.activeArtifactIdBySession,
                [clearKey]: null,
              },
            }
          }

          const artifact = state.artifacts[id]
          const sessionKey = artifactSessionKey(targetSessionId ?? artifact?.sessionId)
          if (!artifact) {
            return {
              activeArtifactIdBySession: {
                ...state.activeArtifactIdBySession,
                [sessionKey]: id,
              },
            }
          }

          return {
            activeArtifactIdBySession: {
              ...state.activeArtifactIdBySession,
              [sessionKey]: id,
            },
            openArtifactIdsBySession: withSessionTabs(
              state.openArtifactIdsBySession,
              sessionKey,
              withOpenArtifact(state.openArtifactIdsBySession[sessionKey] ?? [], id)
            ),
            artifacts: {
              ...state.artifacts,
              [id]: {
                ...artifact,
                metadata: {
                  ...artifact.metadata,
                  lastAccessedAt: new Date(),
                },
              },
            },
            artifactWorkspace: {
              ...state.artifactWorkspace,
              // The bucket this activation landed in, not the artifact's origin
              // session — otherwise the list's "session" scope would filter the
              // focused conversation's dock by another conversation's id.
              sessionId: targetSessionId ?? artifact.sessionId,
              recentArtifactIds: updateRecentArtifactIds(
                state.artifactWorkspace.recentArtifactIds,
                id
              ),
            },
          }
        })
        if (id) {
          set({ panelOpen: true, panelView: "artifact" })
          getPluginEventHooks().dispatchArtifactOpen(id)
        } else if (previousId) {
          getPluginEventHooks().dispatchArtifactClose()
        }
      },

      setArtifactWorkspaceFilters: (filters) => {
        set((state) => ({
          artifactWorkspace: {
            ...state.artifactWorkspace,
            ...filters,
          },
        }))
      },

      setArtifactWorkspaceScope: (scope, sessionId = null) => {
        set((state) => ({
          artifactWorkspace: {
            ...state.artifactWorkspace,
            scope,
            sessionId,
          },
        }))
      },

      resetSessionScopedWorkspaceFilters: (sessionId) => {
        set((state) => ({
          artifactWorkspace: {
            ...state.artifactWorkspace,
            sessionId,
            searchQuery: "",
            typeFilter: "all",
            runtimeFilter: "all",
          },
        }))
      },

      setArtifactWorkspaceReturnContext: (context) => {
        set((state) => ({
          artifactWorkspace: {
            ...state.artifactWorkspace,
            returnContext: context,
          },
        }))
      },

      getArtifactsForWorkspace: ({ sessionId = null, limit } = {}) => {
        const state = get()
        const sorted = Object.values(state.artifacts)
          .map(rehydrateArtifact)
          .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())

        let scoped =
          state.artifactWorkspace.scope === "recent"
            ? sorted.filter((artifact) =>
                state.artifactWorkspace.recentArtifactIds.includes(artifact.id)
              )
            : sorted

        scoped = applyArtifactWorkspaceFilters(scoped, state.artifactWorkspace, sessionId)

        return typeof limit === "number" ? scoped.slice(0, limit) : scoped
      },

      // Auto-detection and creation
      autoCreateFromContent: async ({ sessionId, messageId, content, config }) => {
        // Import detection logic dynamically to avoid circular deps
        const { detectArtifacts, DEFAULT_DETECTION_CONFIG } =
          await import("@/lib/ai/generation/artifact-detector")
        const finalConfig = { ...DEFAULT_DETECTION_CONFIG, ...config }
        const detected: DetectedArtifact[] = detectArtifacts(content, finalConfig)

        loggers.store.debug("artifacts.auto-create.start", {
          sessionId,
          messageId,
          detected: detected.length,
        })

        const createdArtifacts: Artifact[] = []

        for (const item of detected) {
          const metadata = {
            ...buildArtifactSourceMetadata({
              sessionId,
              messageId,
              type: item.type,
              content: item.content,
              language: item.language,
              sourceOrigin: "auto",
              userInitiated: false,
              sourceRange: {
                startIndex: item.startIndex,
                endIndex: item.endIndex,
              },
            }),
            ...(item.rendererProfile ? { rendererProfile: item.rendererProfile } : {}),
            // Only set when the payload actually said (or clearly implied) its
            // shape. Without this the fenced route could not express a pie or a
            // scatter at all, because the renderer falls back to a line chart.
            ...(item.chartType ? { chartType: item.chartType } : {}),
          }

          if (
            isDuplicateArtifactSource({
              artifacts: get().artifacts,
              sessionId,
              messageId,
              type: item.type,
              sourceFingerprint: metadata.sourceFingerprint || "",
            })
          ) {
            continue
          }

          const artifact: Artifact = {
            id: nanoid(),
            sessionId,
            messageId,
            type: item.type,
            title: item.title,
            content: item.content,
            language: item.language,
            metadata,
            version: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
          }

          set((state) => ({
            artifacts: { ...state.artifacts, [artifact.id]: artifact },
          }))

          getPluginEventHooks().dispatchArtifactCreate(artifact)

          createdArtifacts.push(artifact)
        }

        // Set the first artifact as active and open panel
        if (createdArtifacts.length > 0) {
          const sessionKey = artifactSessionKey(sessionId)
          set({
            activeArtifactIdBySession: {
              ...get().activeArtifactIdBySession,
              [sessionKey]: createdArtifacts[0].id,
            },
            openArtifactIdsBySession: withSessionTabs(
              get().openArtifactIdsBySession,
              sessionKey,
              withOpenArtifact(
                get().openArtifactIdsBySession[sessionKey] ?? [],
                createdArtifacts[0].id
              )
            ),
            artifactWorkspace: {
              ...get().artifactWorkspace,
              sessionId,
              recentArtifactIds: updateRecentArtifactIds(
                get().artifactWorkspace.recentArtifactIds,
                createdArtifacts[0].id
              ),
            },
            // Deliberately does NOT open the panel. Whether a fresh artifact is
            // allowed to take over the screen is a layout decision that depends
            // on `userDismissed`, which this store cannot see; forcing it open
            // from here re-threw the mobile Sheet over the conversation every
            // time, including right after the user closed it. The dock's
            // `useDockAttentionSignal` watches `activeArtifactId` and routes it
            // through `notifyNewArtifact` instead.
          })
        }

        loggers.store.debug("artifacts.auto-create.done", {
          sessionId,
          messageId,
          detected: detected.length,
          created: createdArtifacts.length,
        })

        return createdArtifacts
      },

      // AI-revision review (Codex-style per-hunk diff review)
      proposeArtifactUpdate: (id, proposedContent, meta) => {
        const artifact = get().artifacts[id]
        if (!artifact) return null
        if (proposedContent === artifact.content) return null

        const review = buildCanvasReview({
          requestId: meta?.requestId ?? nanoid(),
          actionType: meta?.actionType ?? "custom",
          originalContent: artifact.content,
          proposedContent,
        })
        if (review.items.length === 0) return null

        set((state) => ({
          pendingReviews: { ...state.pendingReviews, [id]: review },
          activeArtifactIdBySession: {
            ...state.activeArtifactIdBySession,
            [artifactSessionKey(artifact.sessionId)]: id,
          },
          // See `autoCreateFromContent`: raising the surface is the dock's call,
          // not this store's. `useDockAttentionSignal` watches the pending-review
          // count and raises it through `notifyNewArtifact`, which is also why a
          // proposal now reaches a collapsed *desktop* dock — it never did.
          artifactWorkspace: {
            ...state.artifactWorkspace,
            sessionId: artifact.sessionId,
            recentArtifactIds: updateRecentArtifactIds(
              state.artifactWorkspace.recentArtifactIds,
              id
            ),
          },
        }))

        getPluginEventHooks().dispatchArtifactOpen(id)
        loggers.store.info("artifacts.review.propose", {
          artifactId: id,
          hunks: review.items.length,
        })

        return review
      },

      setReviewItemStatus: (id, itemId, status) => {
        set((state) => {
          const review = state.pendingReviews[id]
          if (!review) return state
          return {
            pendingReviews: {
              ...state.pendingReviews,
              [id]: {
                ...review,
                items: review.items.map((item) =>
                  item.id === itemId ? { ...item, status } : item
                ),
              },
            },
          }
        })
      },

      applyArtifactReview: (id, changeDescription) => {
        const state = get()
        const review = state.pendingReviews[id]
        const artifact = state.artifacts[id]
        if (!review || !artifact) return

        // Refuse to apply a stale proposal: its diff baseline no longer matches
        // the live content, so merging would clobber the intervening change.
        // The review surface forces re-diff / discard before reaching here.
        if (review.isStale) {
          loggers.store.warn("artifacts.review.apply-skipped-stale", { artifactId: id })
          return
        }

        // Snapshot current content as a version, then merge accepted hunks
        // (against the diff's own baseline) and write through updateArtifact.
        get().saveArtifactVersion(id, changeDescription)
        const merged = applyAcceptedCanvasReviewItems(review.originalContent, review.items)
        get().updateArtifact(id, { content: merged })

        const accepted = review.items.filter((item) => item.status === "accepted").length

        set((s) => {
          const { [id]: _applied, ...pendingReviews } = s.pendingReviews
          return {
            pendingReviews,
            reviewReceipts: appendReviewReceipt(s.reviewReceipts, {
              sessionId: artifact.sessionId,
              artifactId: id,
              title: artifact.title,
              outcome: "applied",
              accepted,
              total: review.items.length,
            }),
          }
        })

        loggers.store.info("artifacts.review.apply", {
          artifactId: id,
          accepted,
          total: review.items.length,
        })
      },

      rejectArtifactReview: (id) => {
        set((state) => {
          const review = state.pendingReviews[id]
          if (!review) return state
          const { [id]: _rejected, ...pendingReviews } = state.pendingReviews
          const artifact = state.artifacts[id]
          // No artifact means it was deleted out from under the proposal —
          // there is nothing coherent to tell the assistant about, so drop the
          // proposal quietly rather than staging a receipt naming a ghost.
          if (!artifact) return { pendingReviews }
          return {
            pendingReviews,
            reviewReceipts: appendReviewReceipt(state.reviewReceipts, {
              sessionId: artifact.sessionId,
              artifactId: id,
              title: artifact.title,
              outcome: "rejected",
              accepted: 0,
              total: review.items.length,
            }),
          }
        })
      },

      getPendingReview: (id) => get().pendingReviews[id] ?? null,

      peekReviewReceipts: (sessionId) =>
        get().reviewReceipts.filter((r) => r.sessionId === sessionId),

      consumeReviewReceipts: (receipts) => {
        if (receipts.length === 0) return
        const sent = new Set(receipts.map(reviewReceiptIdentity))
        set((s) => ({
          reviewReceipts: s.reviewReceipts.filter((r) => !sent.has(reviewReceiptIdentity(r))),
        }))
      },

      // Canvas AI-revision review (shares the pendingReviews map + engine)
      proposeCanvasReview: (documentId, proposedContent, meta) => {
        const doc = get().canvasDocuments[documentId]
        if (!doc) return null
        if (proposedContent === doc.content) return null

        const review = buildCanvasReview({
          requestId: meta?.requestId ?? nanoid(),
          actionType: meta?.actionType ?? "custom",
          originalContent: doc.content,
          proposedContent,
        })
        if (review.items.length === 0) return null

        set((state) => ({
          pendingReviews: { ...state.pendingReviews, [documentId]: review },
        }))

        loggers.store.info("canvas.review.propose", {
          documentId,
          hunks: review.items.length,
        })

        return review
      },

      applyCanvasReview: (documentId, changeDescription) => {
        const state = get()
        const review = state.pendingReviews[documentId]
        const doc = state.canvasDocuments[documentId]
        if (!review || !doc) return

        // A stale proposal's baseline no longer matches the live buffer; the
        // review surface forces re-diff / discard before reaching here.
        if (review.isStale) {
          loggers.store.warn("canvas.review.apply-skipped-stale", { documentId })
          return
        }

        // Snapshot current content, drop the proposal, then merge accepted hunks
        // against the diff's own baseline and write through updateCanvasDocument.
        // Clearing the review first keeps the content write from tripping the
        // staleness guard in updateCanvasDocument.
        get().saveCanvasVersion(documentId, changeDescription)
        const merged = applyAcceptedCanvasReviewItems(review.originalContent, review.items)
        set((s) => {
          const { [documentId]: _applied, ...pendingReviews } = s.pendingReviews
          return { pendingReviews }
        })
        get().updateCanvasDocument(documentId, { content: merged })

        loggers.store.info("canvas.review.apply", {
          documentId,
          accepted: review.items.filter((item) => item.status === "accepted").length,
          total: review.items.length,
        })
      },

      rejectCanvasReview: (documentId) => {
        set((state) => {
          if (!state.pendingReviews[documentId]) return state
          const { [documentId]: _rejected, ...pendingReviews } = state.pendingReviews
          return { pendingReviews }
        })
      },

      // Artifact version history
      saveArtifactVersion: (id, description) => {
        const state = get()
        const artifact = state.artifacts[id]
        if (!artifact) return null

        const version: ArtifactVersion = {
          id: nanoid(),
          artifactId: id,
          title: artifact.title,
          content: artifact.content,
          metadata: artifact.metadata,
          version: artifact.version,
          createdAt: new Date(),
          changeDescription: description,
        }

        set((s) => ({
          artifactVersions: {
            ...s.artifactVersions,
            [id]: [...(s.artifactVersions[id] || []), version],
          },
        }))

        loggers.store.debug("artifacts.version.save", {
          artifactId: id,
          versionId: version.id,
        })

        return version
      },

      restoreArtifactVersion: (id, versionId, autoSaveDescription) => {
        const state = get()
        const versions = state.artifactVersions[id]
        if (!versions) return

        const version = versions.find((v) => v.id === versionId)
        if (!version) return

        const artifact = state.artifacts[id]
        if (!artifact) return

        // Save current state as a new version before restoring
        const currentVersion: ArtifactVersion = {
          id: nanoid(),
          artifactId: id,
          title: artifact.title,
          content: artifact.content,
          metadata: artifact.metadata,
          version: artifact.version,
          createdAt: new Date(),
          changeDescription: autoSaveDescription ?? "Auto-saved before restore",
        }

        set((s) => {
          const openReview = s.pendingReviews[id]
          const pendingReviews =
            openReview && !openReview.isStale
              ? { ...s.pendingReviews, [id]: { ...openReview, isStale: true } }
              : s.pendingReviews
          return {
            artifacts: {
              ...s.artifacts,
              [id]: {
                ...artifact,
                title: version.title ?? artifact.title,
                content: version.content,
                metadata: version.metadata,
                version: artifact.version + 1,
                updatedAt: new Date(),
              },
            },
            artifactVersions: {
              ...s.artifactVersions,
              [id]: [...(s.artifactVersions[id] || []), currentVersion],
            },
            pendingReviews,
          }
        })

        loggers.store.info("artifacts.version.restore", {
          artifactId: id,
          versionId,
        })
      },

      getArtifactVersions: (id) => {
        const versions = get().artifactVersions[id]
        if (!versions) return []
        return [...versions]
          .map((v) => ({ ...v, createdAt: ensureDate(v.createdAt) }))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      },

      // Canvas actions
      createCanvasDocument: ({
        sessionId,
        title,
        content,
        language,
        type,
        sourceArtifactId,
        returnContext,
        authoringOrigin,
      }) => {
        const createdAt = new Date()
        const documentId = nanoid()
        const doc: CanvasDocument = {
          id: documentId,
          sessionId: sessionId || "standalone",
          projectId: activeProjectId() ?? undefined,
          title,
          content,
          language,
          type,
          createdAt,
          updatedAt: createdAt,
          sourceArtifactId,
          returnContext: returnContext || null,
          authoringOrigin,
          editorContext: {
            saveState: "saved",
          },
          aiSuggestions: [],
        }

        set((state) => {
          // Close the lineage loop. The canvas doc has always carried the
          // forward link; without the back-link every "Edit in Canvas" on the
          // same artifact minted another document, because nothing could tell
          // that one already existed. Written here rather than by the caller so
          // the two halves cannot drift, and directly rather than through
          // `updateArtifact` — opening an editor is not an edit, and bumping
          // `version` for it would pollute the artifact's history.
          const source = sourceArtifactId ? state.artifacts[sourceArtifactId] : undefined
          const artifacts = source
            ? {
                ...state.artifacts,
                [source.id]: {
                  ...source,
                  metadata: { ...source.metadata, derivedFromCanvasDocumentId: doc.id },
                },
              }
            : state.artifacts

          return {
            artifacts,
            canvasDocuments: { ...state.canvasDocuments, [doc.id]: doc },
            activeCanvasId: doc.id,
            panelView: "canvas",
          }
        })

        getPluginEventHooks().dispatchCanvasCreate(toPluginCanvasDocument(doc))
        getPluginEventHooks().dispatchCanvasSwitch(doc.id)

        return doc.id
      },

      updateCanvasDocument: (id, updates) => {
        let dispatchPayload: {
          updated: CanvasDocument
          previousContent: string
          contentChanged: boolean
        } | null = null

        set((state) => {
          const doc = state.canvasDocuments[id]
          if (!doc) return state

          const contentChanged =
            "content" in updates && updates.content !== undefined && updates.content !== doc.content
          const nonContextUpdateKeys = Object.keys(updates).filter((key) => key !== "editorContext")
          const mergedEditorContext =
            "editorContext" in updates
              ? mergeCanvasEditorContext(doc.editorContext, updates.editorContext)
              : doc.editorContext

          const updated: CanvasDocument = {
            ...doc,
            ...updates,
            editorContext: contentChanged
              ? mergeCanvasEditorContext(mergedEditorContext, { saveState: "dirty" })
              : mergedEditorContext,
            updatedAt: nonContextUpdateKeys.length === 0 ? doc.updatedAt : new Date(),
          }

          dispatchPayload = {
            updated,
            previousContent: doc.content,
            contentChanged,
          }

          // If a proposal is open against this document and the buffer moved off
          // the diff baseline, mark it stale so the review surface can prompt a
          // re-diff / discard (mirrors the artifact `updateArtifact` behavior).
          const openReview = state.pendingReviews[id]
          const pendingReviews =
            contentChanged &&
            openReview &&
            !openReview.isStale &&
            updated.content !== openReview.originalContent
              ? { ...state.pendingReviews, [id]: { ...openReview, isStale: true } }
              : state.pendingReviews

          return {
            canvasDocuments: {
              ...state.canvasDocuments,
              [id]: updated,
            },
            pendingReviews,
          }
        })

        if (dispatchPayload) {
          const { updated, previousContent, contentChanged } = dispatchPayload as {
            updated: CanvasDocument
            previousContent: string
            contentChanged: boolean
          }
          const pluginDoc = toPluginCanvasDocument(updated)
          // Convert host-shaped updates into the plugin-facing document partial.
          const pluginChanges: Partial<PluginCanvasDocument> = {}
          if ("title" in updates) pluginChanges.title = updates.title as string
          if ("content" in updates) pluginChanges.content = updates.content as string
          if ("language" in updates && updates.language !== undefined) {
            pluginChanges.language = updates.language as PluginCanvasDocument["language"]
          }
          if ("type" in updates && updates.type !== undefined) {
            pluginChanges.type = updates.type as PluginCanvasDocument["type"]
          }
          getPluginEventHooks().dispatchCanvasUpdate(pluginDoc, pluginChanges)

          if (contentChanged && shouldDispatchHighFrequency(CANVAS_CONTENT_CHANGE_OP)) {
            getPluginEventHooks().dispatchCanvasContentChange(id, updated.content, previousContent)
          }

          // Selection updates ride on editorContext.selection; translate
          // line/column coordinates to absolute offsets for plugin consumers.
          const selectionUpdate =
            updates.editorContext && "selection" in updates.editorContext
              ? updates.editorContext.selection
              : undefined
          if (selectionUpdate && shouldDispatchHighFrequency(CANVAS_SELECTION_OP)) {
            const offsets = selectionToOffsets(updated.content, selectionUpdate)
            if (offsets) {
              getPluginEventHooks().dispatchCanvasSelection(id, offsets)
            }
          }
        }
      },

      /**
       * Destroy a document and everything that points at it. This is the
       * irreversible half of the close/delete split: closing a tab only calls
       * `useCanvasLayoutStore.closeDocument`, and the confirm dialog in front of
       * this action is what tells the two apart for the user.
       *
       * The cascade is deliberately wider than the map entry. Versions ride on
       * the document row, so they go with it; the layout store holds a pin and
       * a tab that would otherwise outlive the document and render as a ghost
       * row; everything owned by another store (comments today, the
       * collaboration session next) lets go through
       * `lib/canvas/document-disposal.ts`. The Dexie side of the same cascade
       * (`canvasVersions` / `contextComments` / `canvasSessions`) is driven by
       * `lib/canvas/dexie-bridge.ts`, which derives deletes from "in the mirror,
       * absent from memory".
       */
      deleteCanvasDocument: (id) => {
        let didDelete = false
        let activeCleared = false
        let nextActiveId: string | null = null
        set((state) => {
          if (!state.canvasDocuments[id]) return state
          didDelete = true
          activeCleared = state.activeCanvasId === id
          const { [id]: _removed, ...rest } = state.canvasDocuments
          const { [id]: _removedReview, ...pendingReviews } = state.pendingReviews
          return {
            canvasDocuments: rest,
            pendingReviews,
            activeCanvasId: activeCleared ? null : state.activeCanvasId,
          }
        })
        if (didDelete) {
          const layout = useCanvasLayoutStore.getState()
          nextActiveId = layout.closeDocument(id)
          layout.unpinDocument(id)
          disposeCanvasDocument(id)
          if (activeCleared && nextActiveId && get().canvasDocuments[nextActiveId]) {
            // Deleting the focused document lands on its neighbour rather than
            // on the empty state, the same way closing it does.
            set({ activeCanvasId: nextActiveId })
          }
          getPluginEventHooks().dispatchCanvasDelete(id)
          // Only when focus actually moved: a delete of a background document
          // must not tell plugins the active document changed.
          if (activeCleared) {
            getPluginEventHooks().dispatchCanvasSwitch(get().activeCanvasId)
          }
        }
      },

      setActiveCanvas: (id) => {
        const previousId = get().activeCanvasId
        set({ activeCanvasId: id })
        if (id) {
          set({ panelView: "canvas" })
        }
        if (previousId !== id) {
          getPluginEventHooks().dispatchCanvasSwitch(id)
        }
      },

      // Canvas suggestions
      addSuggestion: (documentId, suggestion) => {
        set((state) => {
          const doc = state.canvasDocuments[documentId]
          if (!doc) return state

          const newSuggestion: CanvasSuggestion = {
            ...suggestion,
            id: nanoid(),
          }

          return {
            canvasDocuments: {
              ...state.canvasDocuments,
              [documentId]: {
                ...doc,
                aiSuggestions: [...(doc.aiSuggestions || []), newSuggestion],
              },
            },
          }
        })
      },

      updateSuggestionStatus: (documentId, suggestionId, status) => {
        set((state) => {
          const doc = state.canvasDocuments[documentId]
          if (!doc) return state

          return {
            canvasDocuments: {
              ...state.canvasDocuments,
              [documentId]: {
                ...doc,
                aiSuggestions: doc.aiSuggestions?.map((s) =>
                  s.id === suggestionId ? { ...s, status } : s
                ),
              },
            },
          }
        })
      },

      applySuggestion: (documentId, suggestionId) => {
        const state = get()
        const doc = state.canvasDocuments[documentId]
        if (!doc) return

        const suggestion = doc.aiSuggestions?.find((s) => s.id === suggestionId)
        if (!suggestion) return

        // Apply the suggestion by replacing the text
        const lines = doc.content.split("\n")
        const newLines = [
          ...lines.slice(0, suggestion.range.startLine),
          suggestion.suggestedText,
          ...lines.slice(suggestion.range.endLine + 1),
        ]

        set((s) => ({
          canvasDocuments: {
            ...s.canvasDocuments,
            [documentId]: {
              ...doc,
              content: newLines.join("\n"),
              aiSuggestions: doc.aiSuggestions?.map((sg) =>
                sg.id === suggestionId ? { ...sg, status: "accepted" as const } : sg
              ),
              updatedAt: new Date(),
            },
          },
        }))
      },

      clearSuggestions: (documentId) => {
        set((state) => {
          const doc = state.canvasDocuments[documentId]
          if (!doc) return state

          return {
            canvasDocuments: {
              ...state.canvasDocuments,
              [documentId]: { ...doc, aiSuggestions: [] },
            },
          }
        })
      },

      // Canvas version history
      saveCanvasVersion: (documentId, description, isAutoSave = false) => {
        const state = get()
        const doc = state.canvasDocuments[documentId]
        if (!doc) return null

        const version: CanvasDocumentVersion = {
          id: nanoid(),
          content: doc.content,
          title: doc.title,
          createdAt: new Date(),
          description,
          isAutoSave,
        }

        set((s) => ({
          canvasDocuments: {
            ...s.canvasDocuments,
            [documentId]: {
              ...doc,
              editorContext: mergeCanvasEditorContext(doc.editorContext, {
                lastSavedAt: version.createdAt,
                saveState: isAutoSave ? "autosaved" : "saved",
              }),
              versions: applyCanvasVersionRetention([...(doc.versions || []), version]),
              currentVersionId: version.id,
            },
          },
        }))

        getPluginEventHooks().dispatchCanvasVersionSave(documentId, version.id)

        return version
      },

      restoreCanvasVersion: (documentId, versionId, autoSaveDescription) => {
        let didRestore = false
        set((state) => {
          const doc = state.canvasDocuments[documentId]
          if (!doc || !doc.versions) return state

          const version = doc.versions.find((v) => v.id === versionId)
          if (!version) return state

          // Save current state as a new version before restoring
          const currentVersion: CanvasDocumentVersion = {
            id: nanoid(),
            content: doc.content,
            title: doc.title,
            createdAt: new Date(),
            description: autoSaveDescription ?? "Auto-saved before restore",
            isAutoSave: true,
          }

          loggers.store.info("artifacts.canvas.version.restore", {
            documentId,
            versionId,
          })

          didRestore = true

          // A restore moves the buffer off any open proposal's baseline.
          const openReview = state.pendingReviews[documentId]
          const pendingReviews =
            openReview && !openReview.isStale && version.content !== openReview.originalContent
              ? { ...state.pendingReviews, [documentId]: { ...openReview, isStale: true } }
              : state.pendingReviews

          return {
            canvasDocuments: {
              ...state.canvasDocuments,
              [documentId]: {
                ...doc,
                content: version.content,
                title: version.title,
                updatedAt: new Date(),
                editorContext: mergeCanvasEditorContext(doc.editorContext, {
                  lastRestoredAt: new Date(),
                  saveState: "saved",
                }),
                versions: applyCanvasVersionRetention([...doc.versions, currentVersion]),
                currentVersionId: versionId,
              },
            },
            pendingReviews,
          }
        })

        if (didRestore) {
          getPluginEventHooks().dispatchCanvasVersionRestore(documentId, versionId)
        }
      },

      deleteCanvasVersion: (documentId, versionId) => {
        set((state) => {
          const doc = state.canvasDocuments[documentId]
          if (!doc || !doc.versions) return state

          return {
            canvasDocuments: {
              ...state.canvasDocuments,
              [documentId]: {
                ...doc,
                versions: doc.versions.filter((v) => v.id !== versionId),
              },
            },
          }
        })
      },

      updateCanvasWorkbench: (documentId, patch) => {
        set((state) => {
          const doc = state.canvasDocuments[documentId]
          if (!doc) return state
          const workbench: CanvasAIWorkbenchState = {
            ...DEFAULT_CANVAS_WORKBENCH,
            ...doc.aiWorkbench,
            ...patch,
          }
          return {
            canvasDocuments: {
              ...state.canvasDocuments,
              // Deliberately not through `updateCanvasDocument`: typing in the
              // prompt box is not an edit to the document, and bumping
              // `updatedAt` for it would reorder the rail on every keystroke.
              [documentId]: { ...doc, aiWorkbench: workbench },
            },
          }
        })
      },

      appendCanvasActionHistory: (documentId, entry) => {
        set((state) => {
          const doc = state.canvasDocuments[documentId]
          if (!doc) return state
          const previous = doc.aiWorkbench ?? DEFAULT_CANVAS_WORKBENCH
          const actionHistory = [entry, ...previous.actionHistory].slice(
            0,
            MAX_CANVAS_ACTION_HISTORY
          )
          return {
            canvasDocuments: {
              ...state.canvasDocuments,
              [documentId]: {
                ...doc,
                aiWorkbench: { ...DEFAULT_CANVAS_WORKBENCH, ...previous, actionHistory },
              },
            },
          }
        })
      },

      updateCanvasActionHistoryEntry: (documentId, entryId, patch) => {
        set((state) => {
          const doc = state.canvasDocuments[documentId]
          if (!doc?.aiWorkbench) return state
          const actionHistory = doc.aiWorkbench.actionHistory.map((item) =>
            item.id === entryId ? { ...item, ...patch } : item
          )
          return {
            canvasDocuments: {
              ...state.canvasDocuments,
              [documentId]: {
                ...doc,
                aiWorkbench: { ...doc.aiWorkbench, actionHistory },
              },
            },
          }
        })
      },

      getCanvasDocumentForWorkspace: (id) => {
        const doc = get().canvasDocuments[id]
        if (!doc) return null
        return filterCanvasDocumentsByWorkspace([doc], activeProjectId())[0] ?? null
      },

      getCanvasDocumentsForWorkspace: ({ sessionId = null, limit } = {}) => {
        const state = get()
        const scoped = filterCanvasDocumentsByWorkspace(
          Object.values(state.canvasDocuments) as CanvasDocument[],
          activeProjectId()
        )
          .filter((doc) => !sessionId || !doc.sessionId || doc.sessionId === sessionId)
          .sort((a, b) => ensureDate(b.updatedAt).getTime() - ensureDate(a.updatedAt).getTime())
        return typeof limit === "number" ? scoped.slice(0, limit) : scoped
      },

      getCanvasVersions: (documentId) => {
        const doc = get().canvasDocuments[documentId]
        if (!doc || !doc.versions) return []
        const rehydrated = rehydrateCanvasDocument(doc)
        return [...(rehydrated.versions || [])].sort(
          (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
        )
      },

      compareVersions: (documentId, versionId1, versionId2) => {
        const doc = get().canvasDocuments[documentId]
        if (!doc || !doc.versions) return null

        const v1 = doc.versions.find((v) => v.id === versionId1)
        const v2 = doc.versions.find((v) => v.id === versionId2)

        if (!v1 || !v2) return null

        return {
          v1: v1.content,
          v2: v2.content,
        }
      },

      // Panel actions
      openPanel: (view = "artifact") => {
        set((state) => {
          // Restore the artifact the workspace route was launched from, into
          // *its own* session's slot — the return context records an id, and
          // the artifact it names is what says which conversation owns it.
          const restoredId = state.artifactWorkspace.returnContext?.activeArtifactId
          const restored = restoredId ? state.artifacts[restoredId] : undefined
          if (view !== "artifact" || !restored) return { panelOpen: true, panelView: view }
          const sessionKey = artifactSessionKey(restored.sessionId)
          if (state.activeArtifactIdBySession[sessionKey]) {
            return { panelOpen: true, panelView: view }
          }
          return {
            panelOpen: true,
            panelView: view,
            activeArtifactIdBySession: {
              ...state.activeArtifactIdBySession,
              [sessionKey]: restoredId ?? null,
            },
          }
        })
        getPluginEventHooks().dispatchArtifactOpen(view)
        // Generic UI panel hook — fires for every right-rail panel open so
        // plugins that don't need the artifact-vs-canvas distinction get a
        // single event keyed by the active view.
        getPluginEventHooks().dispatchPanelOpen(`artifact:${view}`)
      },
      closePanel: () => {
        const previousView = get().panelView
        set({ panelOpen: false })
        getPluginEventHooks().dispatchArtifactClose()
        getPluginEventHooks().dispatchPanelClose(`artifact:${previousView}`)
      },
      setPanelView: (view) => set({ panelView: view }),

      // Batch operations
      deleteArtifacts: (ids) => {
        set((state) => {
          const artifacts = { ...state.artifacts }
          const artifactVersions = { ...state.artifactVersions }
          const pendingReviews = { ...state.pendingReviews }

          for (const id of ids) {
            delete artifacts[id]
            delete artifactVersions[id]
            delete pendingReviews[id]
          }

          const recentArtifactIds = state.artifactWorkspace.recentArtifactIds.filter(
            (artifactId) => !ids.includes(artifactId)
          )
          const nextWorkspace = {
            ...state.artifactWorkspace,
            recentArtifactIds,
            returnContext:
              state.artifactWorkspace.returnContext?.activeArtifactId &&
              ids.includes(state.artifactWorkspace.returnContext.activeArtifactId)
                ? null
                : state.artifactWorkspace.returnContext,
          }
          const removed = new Set(ids)

          for (const id of ids) {
            getPluginEventHooks().dispatchArtifactDelete(id)
          }

          loggers.store.info("artifacts.delete-bulk", { count: ids.length })

          return {
            artifacts,
            artifactVersions,
            pendingReviews,
            artifactWorkspace: nextWorkspace,
            openArtifactIdsBySession: pruneSessionTabs(state.openArtifactIdsBySession, (openId) =>
              Boolean(artifacts[openId])
            ),
            activeArtifactIdBySession: pruneSessionActive(
              state.activeArtifactIdBySession,
              (sessionKey, current) =>
                current && removed.has(current)
                  ? resolveNextActiveArtifactId(artifacts, nextWorkspace, sessionKey)
                  : current
            ),
          }
        })
      },

      duplicateArtifact: (id) => {
        const state = get()
        const original = state.artifacts[id]
        if (!original) return null
        const sourceArtifact = rehydrateArtifact(original)
        const duplicatedId = nanoid()

        const duplicated: Artifact = {
          ...sourceArtifact,
          id: duplicatedId,
          title: `${original.title} (Copy)`,
          version: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
          metadata: buildDerivedArtifactMetadata({
            artifactId: duplicatedId,
            sourceArtifact,
          }),
        }

        const sessionKey = artifactSessionKey(duplicated.sessionId)
        set((s) => ({
          artifacts: { ...s.artifacts, [duplicated.id]: duplicated },
          activeArtifactIdBySession: {
            ...s.activeArtifactIdBySession,
            [sessionKey]: duplicated.id,
          },
          openArtifactIdsBySession: withSessionTabs(
            s.openArtifactIdsBySession,
            sessionKey,
            withOpenArtifact(s.openArtifactIdsBySession[sessionKey] ?? [], duplicated.id)
          ),
          artifactWorkspace: {
            ...s.artifactWorkspace,
            sessionId: duplicated.sessionId,
            recentArtifactIds: updateRecentArtifactIds(
              s.artifactWorkspace.recentArtifactIds,
              duplicated.id
            ),
          },
          panelOpen: true,
          panelView: "artifact",
        }))

        getPluginEventHooks().dispatchArtifactCreate(duplicated)

        return duplicated
      },

      // Search and filter
      searchArtifacts: (query, sessionId) => {
        const lowerQuery = query.toLowerCase()
        return Object.values(get().artifacts)
          .filter((a) => {
            if (sessionId && a.sessionId !== sessionId) return false
            return (
              a.title.toLowerCase().includes(lowerQuery) ||
              a.type.toLowerCase().includes(lowerQuery) ||
              (a.language && a.language.toLowerCase().includes(lowerQuery))
            )
          })
          .map(rehydrateArtifact)
          .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      },

      filterArtifactsByType: (type, sessionId) =>
        Object.values(get().artifacts)
          .filter((a) => {
            if (sessionId && a.sessionId !== sessionId) return false
            return a.type === type
          })
          .map(rehydrateArtifact)
          .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()),

      getRecentArtifacts: (limit = 10) =>
        Object.values(get().artifacts)
          .map(rehydrateArtifact)
          .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
          .slice(0, limit),

      // Utility
      clearSessionData: (sessionId) => {
        set((state) => {
          const artifacts = Object.fromEntries(
            Object.entries(state.artifacts).filter(([, a]) => a.sessionId !== sessionId)
          )
          const artifactVersions = Object.fromEntries(
            Object.entries(state.artifactVersions).filter(([id]) => artifacts[id])
          )
          const pendingReviews = Object.fromEntries(
            Object.entries(state.pendingReviews).filter(([id]) => artifacts[id])
          )
          const clearedCanvasIds = Object.entries(state.canvasDocuments)
            .filter(([, d]) => d.sessionId === sessionId)
            .map(([id]) => id)
          useCanvasLayoutStore.getState().closeDocuments(clearedCanvasIds)
          for (const id of clearedCanvasIds) disposeCanvasDocument(id)
          const canvasDocuments = Object.fromEntries(
            Object.entries(state.canvasDocuments).filter(([, d]) => d.sessionId !== sessionId)
          )
          return {
            artifacts,
            artifactVersions,
            pendingReviews,
            // A receipt is something to tell *this* conversation; with the
            // conversation gone there is nobody left to tell.
            reviewReceipts: state.reviewReceipts.filter((r) => r.sessionId !== sessionId),
            artifactWorkspace: {
              ...state.artifactWorkspace,
              recentArtifactIds: state.artifactWorkspace.recentArtifactIds.filter(
                (artifactId) => artifacts[artifactId]
              ),
              sessionId:
                state.artifactWorkspace.sessionId === sessionId
                  ? null
                  : state.artifactWorkspace.sessionId,
            },
            canvasDocuments,
            // The cleared session's whole bucket goes with it; other sessions
            // only lose tabs whose artifact was collateral.
            openArtifactIdsBySession: pruneSessionTabs(
              withSessionTabs(state.openArtifactIdsBySession, artifactSessionKey(sessionId), []),
              (id) => Boolean(artifacts[id])
            ),
            activeArtifactIdBySession: pruneSessionActive(
              state.activeArtifactIdBySession,
              (sessionKey, current) =>
                sessionKey === artifactSessionKey(sessionId) || !current || !artifacts[current]
                  ? null
                  : current
            ),
            activeCanvasId:
              state.activeCanvasId && canvasDocuments[state.activeCanvasId]
                ? state.activeCanvasId
                : null,
          }
        })
      },
    }),
    {
      name: ARTIFACT_STORAGE_KEY,
      storage: persistLocalStorage(),
      // v6 — artifacts + their versions left this blob for Dexie.
      // v7 — canvas documents followed them.
      //
      // The migrate hook deliberately does NOT strip either: on the first boot
      // after an upgrade they are the migration source. The artifact bridge
      // clears its marker only after its initial transaction commits, which
      // makes `partialize` remove the maps on the following persist write.
      version: 7,
      migrate: (persistedState: unknown, version) => {
        const state = persistedState as Record<string, unknown>
        if (!state.canvasDocuments || typeof state.canvasDocuments !== "object") {
          state.canvasDocuments = {}
        }
        if (!state.artifactVersions || typeof state.artifactVersions !== "object") {
          state.artifactVersions = {}
        }
        const hasLegacyArtifactRows =
          Object.keys((state.artifacts as Record<string, unknown> | undefined) ?? {}).length > 0 ||
          Object.keys(state.artifactVersions as Record<string, unknown>).length > 0
        if (typeof state.artifactDexieMigrationPending !== "boolean") {
          state.artifactDexieMigrationPending = hasLegacyArtifactRows
        }
        if (!state.artifactWorkspace || typeof state.artifactWorkspace !== "object") {
          state.artifactWorkspace = INITIAL_ARTIFACT_WORKSPACE
        } else {
          state.artifactWorkspace = {
            ...INITIAL_ARTIFACT_WORKSPACE,
            ...(state.artifactWorkspace as Record<string, unknown>),
          }
        }
        if (version < 4) {
          // v3 kept one global tab list and one global active id, so a reload
          // could hand the dock a conversation's tabs while another one was on
          // screen. Re-bucket by the owning artifact's session and drop the
          // analysis map, which nothing outside this store ever read.
          delete state.analysisResults
          const artifacts = (state.artifacts ?? {}) as Record<string, Artifact | undefined>
          const legacyOpen = Array.isArray(state.openArtifactIds)
            ? (state.openArtifactIds as string[])
            : []
          const openArtifactIdsBySession: Record<string, string[]> = {}
          for (const id of legacyOpen) {
            const artifact = artifacts[id]
            if (!artifact) continue
            const sessionKey = artifactSessionKey(artifact.sessionId)
            const bucket = openArtifactIdsBySession[sessionKey] ?? []
            if (bucket.length < MAX_OPEN_ARTIFACTS) {
              bucket.push(id)
              openArtifactIdsBySession[sessionKey] = bucket
            }
          }
          delete state.openArtifactIds
          delete state.activeArtifactId
          state.openArtifactIdsBySession = openArtifactIdsBySession
          // v3's active id was never written to disk, so there is nothing to
          // re-bucket here. v5 starts persisting it (see `partialize`).
          state.activeArtifactIdBySession = {}
        }
        if (
          version < 5 &&
          (!state.activeArtifactIdBySession || typeof state.activeArtifactIdBySession !== "object")
        ) {
          // Anything written before v5 has no active-id map on disk at all.
          state.activeArtifactIdBySession = {}
        }
        return state
      },
      // Restore `Date` objects stripped to ISO strings during serialization,
      // so components reading the raw state maps don't crash on `.getTime()`.
      merge: (persistedState, currentState) => {
        const persisted = rehydratePersistedArtifactState(
          (persistedState ?? {}) as Partial<ArtifactState>
        )
        const hasLegacyArtifactRows =
          Object.keys(persisted.artifacts ?? {}).length > 0 ||
          Object.keys(persisted.artifactVersions ?? {}).length > 0
        return {
          ...currentState,
          ...persisted,
          artifactDexieMigrationPending:
            persisted.artifactDexieMigrationPending === true || hasLegacyArtifactRows,
        }
      },
      partialize: (state) => {
        // Once the initial migration commits, `artifacts` and
        // `artifactVersions` are deliberately absent: Dexie owns them from v6
        // on (`lib/artifacts/dexie-bridge.ts`). Until then the conditional below
        // retains the full legacy maps so a failed transaction or crash cannot
        // destroy the only durable copy. They used to be
        // written here on every keystroke, and to fit the ~5 MB localStorage
        // ceiling each artifact's content was cut at 100 KB and everything past
        // the 200 most recent was evicted — silently, and permanently, because
        // the truncated copy was what the next reload read back.
        //
        // Reads still accept them: an install upgrading from v5 has them on
        // disk, and `merge` has to hand that copy to the store so the bridge
        // can carry it into Dexie on first boot. The first write after the
        // bridge confirms that transaction drops them.
        return {
          ...(state.artifactDexieMigrationPending
            ? {
                artifacts: state.artifacts,
                artifactVersions: state.artifactVersions,
                artifactDexieMigrationPending: true,
              }
            : {}),
          // Only the durable *preferences* survive a reload. `searchQuery` and
          // `sessionId` describe the conversation you happened to be in when
          // the app closed: restoring them boots the artifact list already
          // filtered by a stale query and a session that may not even be open
          // (`applyArtifactWorkspaceFilters` uses `sessionId` as the scope
          // fallback), which reads as "the list is empty".
          artifactWorkspace: {
            ...state.artifactWorkspace,
            searchQuery: "",
            sessionId: null,
          },
          // Only tabs whose artifact still exists. There is no LRU cap to
          // survive any more, so this now drops exactly the tabs whose artifact
          // was deleted rather than also the ones evicted to save bytes.
          openArtifactIdsBySession: pruneSessionTabs(state.openArtifactIdsBySession, (id) =>
            Boolean(state.artifacts[id])
          ),
          // Which artifact each conversation was parked on. Persisted alongside
          // the tabs so re-opening the app puts the dock back where it was;
          // keeping only the tabs restored the strip but dropped you onto the
          // session workbench every time. Same existence gate as the tabs.
          activeArtifactIdBySession: pruneSessionActive(
            state.activeArtifactIdBySession,
            (_sessionKey, current) => (current && state.artifacts[current] ? current : null)
          ),
          // `canvasDocuments` is deliberately absent from v7 on: Dexie owns
          // them (`lib/canvas/dexie-bridge.ts`), the same way it owns artifacts
          // from v6. They were serialised in full — no truncation, no cap — on
          // every state change, and `editorContext.selection` changes on every
          // cursor move, so moving the caret through one large document meant
          // re-stringifying every canvas document the user has.
          //
          // Reads still accept them, for the reason v6 kept accepting
          // artifacts: an install upgrading from v6 has them on disk, and the
          // bridge needs that copy in memory to mirror it.
        }
      },
    }
  )
)

/**
 * Called only after the bridge's initial artifacts + versions transaction has
 * committed. Updating the marker triggers Zustand persist, atomically replacing
 * the legacy blob with the preferences-only v6 shape.
 */
export function completeArtifactDexieMigration(): void {
  if (!useArtifactStore.getState().artifactDexieMigrationPending) return
  useArtifactStore.setState({ artifactDexieMigrationPending: false })
}

registerProjectBucketPurger("artifacts", (projectId) => {
  useArtifactStore.getState().purgeProject(projectId)
})

export function activateArtifactAccountStorage(accountId: string): void {
  const storageKey = artifactAccountStorageKey(accountId)
  adoptLegacyArtifactStorage(storageKey)
  useArtifactStore.persist.setOptions({ name: storageKey })
  useArtifactStore.setState({
    ...initialState,
    ...readArtifactPersistedState(storageKey),
  })
}

export function clearArtifactAccountStorage(): void {
  useArtifactStore.persist.setOptions({ name: ARTIFACT_STORAGE_KEY })
  useArtifactStore.setState(initialState)
}

export function purgeArtifactAccountStorage(accountId: string): void {
  if (typeof window === "undefined") return
  window.localStorage.removeItem(artifactAccountStorageKey(accountId))
}

function adoptLegacyArtifactStorage(storageKey: string): void {
  if (typeof window === "undefined") return
  if (window.localStorage.getItem(storageKey)) return
  const legacySnapshot = window.localStorage.getItem(ARTIFACT_STORAGE_KEY)
  if (!legacySnapshot) return
  window.localStorage.setItem(storageKey, legacySnapshot)
  window.localStorage.removeItem(ARTIFACT_STORAGE_KEY)
}

function readArtifactPersistedState(storageKey: string): Partial<ArtifactState> {
  if (typeof window === "undefined") return {}
  const snapshot = window.localStorage.getItem(storageKey)
  if (!snapshot) return {}
  try {
    const parsed = JSON.parse(snapshot) as { state?: unknown }
    return parsed.state && typeof parsed.state === "object"
      ? rehydratePersistedArtifactState(parsed.state as Partial<ArtifactState>)
      : {}
  } catch {
    return {}
  }
}

export default useArtifactStore
