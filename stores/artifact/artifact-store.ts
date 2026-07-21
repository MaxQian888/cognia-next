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
import { nanoid } from "nanoid"
import { getPluginEventHooks } from "@/lib/plugin"
import { getPluginRateLimiter, RateLimitError } from "@/lib/plugin/security/rate-limiter"
import { loggers } from "@cognia/logging"
import { useProjectStore } from "@/stores/project/project-store"
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
  ArtifactMetadata,
  ArtifactAuthoringOrigin,
  ArtifactWorkspaceScope,
  ArtifactWorkspaceState,
  ArtifactWorkspaceReturnContext,
  ArtifactVersion,
  CanvasEditorContext,
  CanvasDocument,
  CanvasDocumentVersion,
  CanvasSuggestion,
  CanvasPendingReview,
  CanvasReviewItemStatus,
  CanvasWorkbenchActionType,
  AnalysisResult,
  ArtifactDetectionConfig,
  DetectedArtifact,
} from "@/types"

/** Maximum content size to persist per artifact (100KB) */
const MAX_PERSISTED_CONTENT_SIZE = 100 * 1024
/** Maximum total artifacts to persist (LRU eviction beyond this) */
const MAX_PERSISTED_ARTIFACTS = 200
/** Maximum number of auto-save canvas versions retained per document */
const MAX_CANVAS_AUTOSAVE_VERSIONS = 30
const ARTIFACT_STORAGE_KEY = "cognia-artifacts"

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
 * Rehydrate canvas document dates from storage
 */
function rehydrateCanvasDocument(doc: CanvasDocument): CanvasDocument {
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
 * Rehydrate analysis result dates from storage
 */
function rehydrateAnalysisResult(result: AnalysisResult): AnalysisResult {
  return {
    ...result,
    createdAt: ensureDate(result.createdAt),
  }
}

/**
 * Rehydrate the date-bearing maps of a persisted snapshot back into `Date`
 * objects. Zustand `persist` serializes `Date` to ISO strings, so without
 * this every direct consumer of the raw `canvasDocuments` / `artifacts` /
 * `analysisResults` maps (e.g. CanvasDocumentRail calling `updatedAt.getTime()`)
 * would crash after a reload. The per-action getters rehydrate on read, but the
 * raw state maps must be restored too.
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
  if (next.analysisResults) {
    next.analysisResults = Object.fromEntries(
      Object.entries(next.analysisResults).map(([id, result]) => [
        id,
        rehydrateAnalysisResult(result),
      ])
    )
  }
  return next
}

/**
 * Keep manual versions intact while pruning oldest auto-save checkpoints.
 */
function applyCanvasVersionRetention(
  versions: CanvasDocumentVersion[],
  maxAutoSaveVersions = MAX_CANVAS_AUTOSAVE_VERSIONS
): CanvasDocumentVersion[] {
  const autoSaveVersions = versions
    .filter((v) => v.isAutoSave)
    .sort((a, b) => ensureDate(a.createdAt).getTime() - ensureDate(b.createdAt).getTime())

  if (autoSaveVersions.length <= maxAutoSaveVersions) {
    return versions
  }

  const removeIds = new Set(
    autoSaveVersions.slice(0, autoSaveVersions.length - maxAutoSaveVersions).map((v) => v.id)
  )

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

/** Tabs the dock will show at once before the oldest is dropped. */
export const MAX_OPEN_ARTIFACTS = 12

/**
 * Append to the open-tab list, preserving open order (unlike the MRU recents
 * list, tabs must not reshuffle under the pointer when you switch between them).
 */
function withOpenArtifact(openArtifactIds: string[], artifactId: string): string[] {
  if (openArtifactIds.includes(artifactId)) return openArtifactIds
  return [...openArtifactIds, artifactId].slice(-MAX_OPEN_ARTIFACTS)
}

function updateRecentArtifactIds(
  recentArtifactIds: string[],
  artifactId: string,
  limit = 20
): string[] {
  return [artifactId, ...recentArtifactIds.filter((id) => id !== artifactId)].slice(0, limit)
}

function resolveNextActiveArtifactId(
  artifacts: Record<string, Artifact>,
  workspace: ArtifactWorkspaceState
): string | null {
  const returnContextArtifactId = workspace.returnContext?.activeArtifactId
  if (returnContextArtifactId && artifacts[returnContextArtifactId]) {
    return returnContextArtifactId
  }

  const recentArtifactId = workspace.recentArtifactIds.find((artifactId) => artifacts[artifactId])
  if (recentArtifactId) {
    return recentArtifactId
  }

  const scopedArtifacts = Object.values(artifacts)
    .filter((artifact) =>
      workspace.scope === "session" && workspace.sessionId
        ? artifact.sessionId === workspace.sessionId
        : true
    )
    .sort((a, b) => ensureDate(b.updatedAt).getTime() - ensureDate(a.updatedAt).getTime())

  return scopedArtifacts[0]?.id || null
}

interface ArtifactState {
  // Artifacts
  artifacts: Record<string, Artifact>
  activeArtifactId: string | null
  artifactVersions: Record<string, ArtifactVersion[]>
  artifactWorkspace: ArtifactWorkspaceState
  /**
   * Open AI-revision proposals awaiting per-hunk review, keyed by artifactId
   * (at most one per artifact). Transient — deliberately excluded from
   * `partialize` so a stale-baseline proposal can never survive a reload.
   */
  pendingReviews: Record<string, CanvasPendingReview>

  // Canvas
  canvasDocuments: Record<string, CanvasDocument>
  activeCanvasId: string | null
  canvasOpen: boolean

  // Analysis
  analysisResults: Record<string, AnalysisResult>

  /**
   * Artifacts the user currently has open, in the order they were opened —
   * the dock's tab strip. Deliberately NOT `artifactWorkspace.recentArtifactIds`:
   * that is an MRU history the workspace page's "recent" scope browses, so
   * closing a tab would silently erase browsing history.
   */
  openArtifactIds: string[]

  // Panel state
  panelOpen: boolean
  panelView: "artifact" | "canvas" | "analysis"
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
  deleteArtifact: (id: string) => void
  /**
   * Drop an artifact's tab. When it was the active one, activate its neighbour
   * so the dock never lands on an empty surface with tabs still showing.
   */
  closeArtifact: (id: string) => void
  /**
   * Drop every artifact + canvas document owned by a workspace. Called by
   * `deleteProjectCascade` when a project is deleted (Workspace isolation).
   */
  purgeProject: (projectId: string) => void
  getArtifact: (id: string) => Artifact | undefined
  getSessionArtifacts: (sessionId: string) => Artifact[]
  setActiveArtifact: (id: string | null) => void
  setArtifactWorkspaceFilters: (filters: {
    searchQuery?: string
    typeFilter?: ArtifactType | "all"
    runtimeFilter?: ArtifactRuntimeHealth | "all"
  }) => void
  setArtifactWorkspaceScope: (scope: ArtifactWorkspaceScope, sessionId?: string | null) => void
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
  openCanvas: () => void
  closeCanvas: () => void

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
  compareVersions: (
    documentId: string,
    versionId1: string,
    versionId2: string
  ) => { v1: string; v2: string } | null

  // Analysis actions
  addAnalysisResult: (result: Omit<AnalysisResult, "id" | "createdAt">) => AnalysisResult
  getMessageAnalysis: (messageId: string) => AnalysisResult[]

  // Panel actions
  openPanel: (view?: "artifact" | "canvas" | "analysis") => void
  closePanel: () => void
  setPanelView: (view: "artifact" | "canvas" | "analysis") => void

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
  activeArtifactId: null,
  artifactVersions: {},
  artifactWorkspace: INITIAL_ARTIFACT_WORKSPACE,
  openArtifactIds: [],
  pendingReviews: {},
  canvasDocuments: {},
  activeCanvasId: null,
  canvasOpen: false,
  analysisResults: {},
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

        set((state) => ({
          artifacts: { ...state.artifacts, [artifact.id]: artifact },
          activeArtifactId: artifact.id,
          openArtifactIds: withOpenArtifact(state.openArtifactIds, artifact.id),
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
          const canvasDocuments = Object.fromEntries(
            Object.entries(state.canvasDocuments).filter(([, d]) => d.projectId !== projectId)
          )
          // Keep reviews whose target (artifact OR canvas document) survives the
          // purge — canvas reviews share this map, keyed by document id.
          const pendingReviews = Object.fromEntries(
            Object.entries(state.pendingReviews).filter(
              ([reviewId]) => artifacts[reviewId] || canvasDocuments[reviewId]
            )
          )
          const removedActiveArtifact =
            state.activeArtifactId != null && !artifacts[state.activeArtifactId]
          const removedActiveCanvas =
            state.activeCanvasId != null && !canvasDocuments[state.activeCanvasId]
          return {
            artifacts,
            canvasDocuments,
            pendingReviews,
            activeArtifactId: removedActiveArtifact ? null : state.activeArtifactId,
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
          const nextActiveArtifactId =
            state.activeArtifactId === id
              ? resolveNextActiveArtifactId(rest, nextWorkspace)
              : state.activeArtifactId
          getPluginEventHooks().dispatchArtifactDelete(id)
          loggers.store.info("artifacts.delete", {
            id,
            sessionId: state.artifacts[id]?.sessionId,
          })
          return {
            artifacts: rest,
            pendingReviews,
            artifactWorkspace: nextWorkspace,
            activeArtifactId: nextActiveArtifactId,
            openArtifactIds: state.openArtifactIds.filter((openId) => openId !== id),
          }
        })
      },

      closeArtifact: (id) => {
        set((state) => {
          const openArtifactIds = state.openArtifactIds.filter((openId) => openId !== id)
          if (openArtifactIds.length === state.openArtifactIds.length) return state
          if (state.activeArtifactId !== id) return { openArtifactIds }

          // Prefer the tab that took this one's slot, else the one before it —
          // the same neighbour a closed editor tab hands focus to.
          const closedIndex = state.openArtifactIds.indexOf(id)
          const neighbour = openArtifactIds[closedIndex] ?? openArtifactIds[closedIndex - 1] ?? null
          return { openArtifactIds, activeArtifactId: neighbour }
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

      setActiveArtifact: (id) => {
        const previousId = get().activeArtifactId
        set((state) => {
          if (!id) {
            return { activeArtifactId: null }
          }

          const artifact = state.artifacts[id]
          if (!artifact) {
            return { activeArtifactId: id }
          }

          return {
            activeArtifactId: id,
            openArtifactIds: withOpenArtifact(state.openArtifactIds, id),
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
              sessionId: artifact.sessionId,
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
          const metadata = buildArtifactSourceMetadata({
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
          })

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
          set({
            activeArtifactId: createdArtifacts[0].id,
            artifactWorkspace: {
              ...get().artifactWorkspace,
              sessionId,
              recentArtifactIds: updateRecentArtifactIds(
                get().artifactWorkspace.recentArtifactIds,
                createdArtifacts[0].id
              ),
            },
            panelOpen: true,
            panelView: "artifact",
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
          activeArtifactId: id,
          panelOpen: true,
          panelView: "artifact",
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

        set((s) => {
          const { [id]: _applied, ...pendingReviews } = s.pendingReviews
          return { pendingReviews }
        })

        loggers.store.info("artifacts.review.apply", {
          artifactId: id,
          accepted: review.items.filter((item) => item.status === "accepted").length,
          total: review.items.length,
        })
      },

      rejectArtifactReview: (id) => {
        set((state) => {
          if (!state.pendingReviews[id]) return state
          const { [id]: _rejected, ...pendingReviews } = state.pendingReviews
          return { pendingReviews }
        })
      },

      getPendingReview: (id) => get().pendingReviews[id] ?? null,

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
          content: artifact.content,
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
          content: artifact.content,
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
                content: version.content,
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

        set((state) => ({
          canvasDocuments: { ...state.canvasDocuments, [doc.id]: doc },
          activeCanvasId: doc.id,
          canvasOpen: true,
          panelView: "canvas",
        }))

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

      deleteCanvasDocument: (id) => {
        let didDelete = false
        let activeCleared = false
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
          getPluginEventHooks().dispatchCanvasDelete(id)
          if (activeCleared) {
            getPluginEventHooks().dispatchCanvasSwitch(null)
          }
        }
      },

      setActiveCanvas: (id) => {
        const previousId = get().activeCanvasId
        set({ activeCanvasId: id })
        if (id) {
          set({ canvasOpen: true, panelView: "canvas" })
        }
        if (previousId !== id) {
          getPluginEventHooks().dispatchCanvasSwitch(id)
        }
      },

      openCanvas: () => set({ canvasOpen: true, panelView: "canvas" }),
      closeCanvas: () => set({ canvasOpen: false }),

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

      // Analysis actions
      addAnalysisResult: (result) => {
        const newResult: AnalysisResult = {
          ...result,
          id: nanoid(),
          createdAt: new Date(),
        }

        set((state) => ({
          analysisResults: { ...state.analysisResults, [newResult.id]: newResult },
        }))

        return newResult
      },

      getMessageAnalysis: (messageId) =>
        Object.values(get().analysisResults)
          .filter((r) => r.messageId === messageId)
          .map(rehydrateAnalysisResult)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),

      // Panel actions
      openPanel: (view = "artifact") => {
        set((state) => ({
          panelOpen: true,
          panelView: view,
          activeArtifactId:
            view === "artifact" &&
            !state.activeArtifactId &&
            state.artifactWorkspace.returnContext?.activeArtifactId &&
            state.artifacts[state.artifactWorkspace.returnContext.activeArtifactId]
              ? state.artifactWorkspace.returnContext.activeArtifactId
              : state.activeArtifactId,
        }))
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
          const nextActiveArtifactId = ids.includes(state.activeArtifactId || "")
            ? resolveNextActiveArtifactId(artifacts, nextWorkspace)
            : state.activeArtifactId

          for (const id of ids) {
            getPluginEventHooks().dispatchArtifactDelete(id)
          }

          loggers.store.info("artifacts.delete-bulk", { count: ids.length })

          return {
            artifacts,
            artifactVersions,
            pendingReviews,
            artifactWorkspace: nextWorkspace,
            activeArtifactId: nextActiveArtifactId,
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

        set((s) => ({
          artifacts: { ...s.artifacts, [duplicated.id]: duplicated },
          activeArtifactId: duplicated.id,
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
          const canvasDocuments = Object.fromEntries(
            Object.entries(state.canvasDocuments).filter(([, d]) => d.sessionId !== sessionId)
          )
          const analysisResults = Object.fromEntries(
            Object.entries(state.analysisResults).filter(([, r]) => r.sessionId !== sessionId)
          )

          return {
            artifacts,
            artifactVersions,
            pendingReviews,
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
            analysisResults,
            openArtifactIds: state.openArtifactIds.filter((id) => artifacts[id]),
            activeArtifactId:
              state.activeArtifactId && artifacts[state.activeArtifactId]
                ? state.activeArtifactId
                : null,
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
      version: 3,
      migrate: (persistedState: unknown) => {
        const state = persistedState as Record<string, unknown>
        if (!state.canvasDocuments || typeof state.canvasDocuments !== "object") {
          state.canvasDocuments = {}
        }
        if (!state.artifactVersions || typeof state.artifactVersions !== "object") {
          state.artifactVersions = {}
        }
        if (!state.analysisResults || typeof state.analysisResults !== "object") {
          state.analysisResults = {}
        }
        if (!state.artifactWorkspace || typeof state.artifactWorkspace !== "object") {
          state.artifactWorkspace = INITIAL_ARTIFACT_WORKSPACE
        } else {
          state.artifactWorkspace = {
            ...INITIAL_ARTIFACT_WORKSPACE,
            ...(state.artifactWorkspace as Record<string, unknown>),
          }
        }
        return state
      },
      // Restore `Date` objects stripped to ISO strings during serialization,
      // so components reading the raw state maps don't crash on `.getTime()`.
      merge: (persistedState, currentState) => ({
        ...currentState,
        ...rehydratePersistedArtifactState((persistedState ?? {}) as Partial<ArtifactState>),
      }),
      partialize: (state) => {
        // LRU eviction: keep only the most recently updated artifacts
        const sortedArtifacts = Object.values(state.artifacts)
          .sort((a, b) => {
            const dateA =
              a.updatedAt instanceof Date ? a.updatedAt.getTime() : new Date(a.updatedAt).getTime()
            const dateB =
              b.updatedAt instanceof Date ? b.updatedAt.getTime() : new Date(b.updatedAt).getTime()
            return dateB - dateA
          })
          .slice(0, MAX_PERSISTED_ARTIFACTS)

        // Truncate oversized content to prevent localStorage overflow
        const artifacts: Record<string, Artifact> = {}
        for (const artifact of sortedArtifacts) {
          artifacts[artifact.id] =
            artifact.content.length > MAX_PERSISTED_CONTENT_SIZE
              ? { ...artifact, content: artifact.content.slice(0, MAX_PERSISTED_CONTENT_SIZE) }
              : artifact
        }

        // Only keep versions for artifacts that are being persisted
        const artifactVersions: Record<string, ArtifactVersion[]> = {}
        for (const [id, versions] of Object.entries(state.artifactVersions)) {
          if (artifacts[id]) {
            artifactVersions[id] = versions
          }
        }

        return {
          artifacts,
          artifactVersions,
          artifactWorkspace: state.artifactWorkspace,
          // Only tabs whose artifact survived the LRU eviction above.
          openArtifactIds: state.openArtifactIds.filter((id) => artifacts[id]),
          canvasDocuments: state.canvasDocuments,
          analysisResults: state.analysisResults,
        }
      },
    }
  )
)

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
