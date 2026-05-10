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
import { loggers } from "@/lib/logger"
import type { PluginCanvasDocument } from "@/types/plugin/plugin-extended"
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

  return artifacts.filter((artifact) => {
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

  // Canvas
  canvasDocuments: Record<string, CanvasDocument>
  activeCanvasId: string | null
  canvasOpen: boolean

  // Analysis
  analysisResults: Record<string, AnalysisResult>

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

          return {
            artifacts: { ...state.artifacts, [id]: updated },
          }
        })
      },

      deleteArtifact: (id) => {
        set((state) => {
          const { [id]: _removed, ...rest } = state.artifacts
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
            artifactWorkspace: nextWorkspace,
            activeArtifactId: nextActiveArtifactId,
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

        set((s) => ({
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
        }))

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

          return {
            canvasDocuments: {
              ...state.canvasDocuments,
              [id]: updated,
            },
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
          return {
            canvasDocuments: rest,
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

          for (const id of ids) {
            delete artifacts[id]
            delete artifactVersions[id]
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
          const canvasDocuments = Object.fromEntries(
            Object.entries(state.canvasDocuments).filter(([, d]) => d.sessionId !== sessionId)
          )
          const analysisResults = Object.fromEntries(
            Object.entries(state.analysisResults).filter(([, r]) => r.sessionId !== sessionId)
          )

          return {
            artifacts,
            artifactVersions,
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
      name: "cognia-artifacts",
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
          canvasDocuments: state.canvasDocuments,
          analysisResults: state.analysisResults,
        }
      },
    }
  )
)

export default useArtifactStore
