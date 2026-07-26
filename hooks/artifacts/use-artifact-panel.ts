/**
 * useArtifactPanelState - Extracted state and logic for ArtifactPanel.
 *
 * cognia-next adapts the upstream hook by:
 *  - swapping `useNativeStore.isDesktop` for `isTauri()`
 *  - using `lib/tauri/opener` (revealInExplorer / openPath)
 *  - dropping the Designer subsystem entirely: "Edit in Canvas" is the visual
 *    authoring surface here, and it reopens the document the artifact was
 *    already sent to rather than minting a new one
 *  - using cognia-next's `downloadFile(filename, content, mimeType)` signature
 */

"use client"

import { useState, useCallback, useEffect, useRef } from "react"
import { useShallow } from "zustand/react/shallow"
import { useTranslations } from "next-intl"
import { useMediaQuery } from "@/hooks/ui"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useActiveArtifactId } from "@/hooks/artifacts/use-session-artifacts"
import { useSettingsStore } from "@/stores/settings"
import { isTauri } from "@/lib/tauri"
import { revealInExplorer, openPath } from "@/lib/tauri/opener"
import { saveExport } from "@/lib/files/save-export"
import { hasWorkspaceFsBackend } from "@/lib/files/workspace-backend"
import { resolveSessionProjectRoot, allRootPaths } from "@/lib/workspace/roots"
import { useProjectStore } from "@/stores/project/project-store"
import { useChatStore } from "@/stores/chat"
import { getSession } from "@/lib/db/sessions"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import { saveGeneratedDocument, type DocFormat } from "@/lib/files/document-writer"
import { writeText as clipboardWriteText } from "@/lib/capacitor/clipboard"
import { getArtifactExtension, canPreview } from "@/lib/artifacts"
import { loggers } from "@cognia/logging"
import { getPreferredArtifactExportFormat } from "@/components/artifacts/runtime-adapters"
import type { Artifact, ArtifactAuthoringOrigin, ArtifactWorkspaceReturnContext } from "@/types"

function getExtension(artifact: Artifact): string {
  return getArtifactExtension(artifact.type, artifact.language)
}

type ArtifactPanelAction =
  | "modeTabs"
  | "edit"
  | "canvas"
  | "fullscreen"
  | "close"
  | "copy"
  | "download"
  | "openInNewTab"
  | "revealInExplorer"
  | "saveToProject"
  | "versionHistory"

/** Artifact view modes. `split` (code + live preview side-by-side) is the wide
 * docked-panel Codex experience; it is only offered for previewable types. */
export type ArtifactViewMode = "code" | "preview" | "edit" | "review" | "split"

export function useArtifactPanelState() {
  const t = useTranslations("artifacts")
  const tCommon = useTranslations("common")

  // Store state - using useShallow for optimized subscriptions
  const { panelOpen, panelView, artifacts, artifactWorkspace } = useArtifactStore(
    useShallow((state) => ({
      panelOpen: state.panelOpen,
      panelView: state.panelView,
      artifacts: state.artifacts,
      artifactWorkspace: state.artifactWorkspace,
    }))
  )
  const activeArtifactId = useActiveArtifactId()
  // Subscribe to only the active artifact's pending review — selecting the
  // whole `pendingReviews` map would re-render the panel whenever a proposal
  // lands/resolves on any *other* artifact.
  const pendingReview = useArtifactStore((state) =>
    activeArtifactId ? (state.pendingReviews[activeArtifactId] ?? null) : null
  )

  // Store actions - using useShallow for stable references
  const {
    closePanel,
    updateArtifact,
    saveArtifactVersion,
    createCanvasDocument,
    setActiveCanvas,
    openPanel,
    setArtifactWorkspaceReturnContext,
  } = useArtifactStore(
    useShallow((state) => ({
      closePanel: state.closePanel,
      updateArtifact: state.updateArtifact,
      saveArtifactVersion: state.saveArtifactVersion,
      createCanvasDocument: state.createCanvasDocument,
      setActiveCanvas: state.setActiveCanvas,
      openPanel: state.openPanel,
      setArtifactWorkspaceReturnContext: state.setArtifactWorkspaceReturnContext,
    }))
  )

  const canvasDocuments = useArtifactStore((state) => state.canvasDocuments)
  const activeArtifact = activeArtifactId ? artifacts[activeArtifactId] : null
  const theme = useSettingsStore((state) => state.settings?.theme)
  const isDesktop = isTauri()
  const isMobileViewport = useMediaQuery("(max-width: 639px)")
  const isTabletViewport = useMediaQuery("(min-width: 640px) and (max-width: 1023px)")
  // Local state
  const [viewMode, setViewMode] = useState<ArtifactViewMode>("code")
  const [copied, setCopied] = useState(false)
  const [editContent, setEditContent] = useState("")
  const [hasChanges, setHasChanges] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [showVersionHistory, setShowVersionHistory] = useState(false)
  const [lastDownloadPath, setLastDownloadPath] = useState<string | null>(null)

  // Keyboard shortcuts
  useEffect(() => {
    if (!panelOpen || panelView !== "artifact") return

    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return

      if (e.key === "Escape") {
        e.preventDefault()
        closePanel()
        return
      }

      if (!activeArtifact) return

      if ((e.ctrlKey || e.metaKey) && e.key === "s" && viewMode === "edit") {
        e.preventDefault()
        if (hasChanges) {
          saveArtifactVersion(activeArtifact.id, t("beforeEdit"))
          updateArtifact(activeArtifact.id, { content: editContent })
          setHasChanges(false)
          setViewMode("code")
        }
        return
      }

      if ((e.ctrlKey || e.metaKey) && e.key === "e" && viewMode !== "edit") {
        e.preventDefault()
        setEditContent(activeArtifact.content)
        setHasChanges(false)
        setViewMode("edit")
        return
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [
    panelOpen,
    panelView,
    activeArtifact,
    viewMode,
    hasChanges,
    editContent,
    closePanel,
    updateArtifact,
    saveArtifactVersion,
    t,
  ])

  // Auto-enter the review surface when a fresh AI-revision proposal appears,
  // and leave it once the proposal is resolved (applied/rejected). Keyed on the
  // review id so the user can still click the code/preview tabs to peek without
  // being yanked back, and a re-diff (new id) re-enters review.
  const lastReviewIdRef = useRef<string | null>(null)
  useEffect(() => {
    const reviewId = pendingReview?.id ?? null
    if (reviewId && reviewId !== lastReviewIdRef.current && viewMode !== "edit") {
      setViewMode("review")
    } else if (!reviewId && lastReviewIdRef.current && viewMode === "review") {
      setViewMode("code")
    }
    lastReviewIdRef.current = reviewId
  }, [pendingReview, viewMode])

  const buildReturnContext = useCallback(
    (authoringOrigin: ArtifactAuthoringOrigin): ArtifactWorkspaceReturnContext | null => {
      if (!activeArtifact) {
        return null
      }

      return {
        scope: artifactWorkspace.scope,
        sessionId: artifactWorkspace.sessionId,
        searchQuery: artifactWorkspace.searchQuery,
        typeFilter: artifactWorkspace.typeFilter,
        runtimeFilter: artifactWorkspace.runtimeFilter,
        activeArtifactId: activeArtifact.id,
        authoringOrigin,
        workingRevisionUpdatedAt: activeArtifact.updatedAt,
      }
    },
    [activeArtifact, artifactWorkspace]
  )

  // Handlers
  const handleOpenInCanvas = useCallback(() => {
    if (activeArtifact) {
      const returnContext = buildReturnContext("artifact-panel")
      setArtifactWorkspaceReturnContext(returnContext)

      // Reopen the document this artifact was already sent to. Without this the
      // action minted a fresh copy every time, so a user who alternated between
      // the panel and the canvas accumulated duplicates and lost their edits to
      // whichever copy they had stopped looking at. A link pointing at a
      // deleted document falls through to creating a new one.
      const existingId = activeArtifact.metadata?.derivedFromCanvasDocumentId
      if (existingId && canvasDocuments[existingId]) {
        setActiveCanvas(existingId)
        openPanel("canvas")
        loggers.ui.info("artifacts.action.open-in-canvas", {
          artifactId: activeArtifact.id,
          canvasId: existingId,
          reused: true,
        })
        return
      }

      const docId = createCanvasDocument({
        title: activeArtifact.title,
        content: activeArtifact.content,
        language: activeArtifact.language || "javascript",
        type: "code",
        sourceArtifactId: activeArtifact.id,
        returnContext,
        authoringOrigin: "artifact-panel",
      })
      setActiveCanvas(docId)
      openPanel("canvas")
      loggers.ui.info("artifacts.action.open-in-canvas", {
        artifactId: activeArtifact.id,
        canvasId: docId,
      })
    }
  }, [
    activeArtifact,
    buildReturnContext,
    canvasDocuments,
    createCanvasDocument,
    openPanel,
    setActiveCanvas,
    setArtifactWorkspaceReturnContext,
  ])

  const handleEditMode = useCallback(() => {
    if (activeArtifact) {
      setEditContent(activeArtifact.content)
      setHasChanges(false)
      setViewMode("edit")
    }
  }, [activeArtifact])

  const handleSaveEdit = useCallback(() => {
    if (activeArtifact && hasChanges) {
      saveArtifactVersion(activeArtifact.id, t("beforeEdit"))
      updateArtifact(activeArtifact.id, { content: editContent })
      setHasChanges(false)
      setViewMode("code")
      loggers.ui.info("artifacts.action.save-edit", { artifactId: activeArtifact.id })
    }
  }, [activeArtifact, editContent, hasChanges, updateArtifact, saveArtifactVersion, t])

  const handleCancelEdit = useCallback(() => {
    setViewMode("code")
    setHasChanges(false)
  }, [])

  const handleEditorChange = useCallback(
    (value: string | undefined) => {
      setEditContent(value || "")
      setHasChanges(value !== activeArtifact?.content)
    },
    [activeArtifact?.content]
  )

  const toggleFullscreen = useCallback(() => {
    setIsFullscreen((prev) => !prev)
  }, [])

  const handleCopy = async () => {
    if (activeArtifact) {
      // Native clipboard first (mobile WebView often leaves navigator.clipboard
      // unavailable); fall back to the web API on Tauri/web where the native
      // plugin reports "unsupported".
      const native = await clipboardWriteText(activeArtifact.content)
      if (native.kind !== "ok") {
        await navigator.clipboard.writeText(activeArtifact.content)
      }
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  const handleDownload = async () => {
    if (activeArtifact) {
      const preferredFormat = getPreferredArtifactExportFormat(activeArtifact)
      const extension =
        preferredFormat === "html"
          ? "html"
          : preferredFormat === "svg"
            ? "svg"
            : getExtension(activeArtifact)
      const mimeType =
        preferredFormat === "html"
          ? "text/html"
          : preferredFormat === "svg"
            ? "image/svg+xml"
            : activeArtifact.type === "jupyter"
              ? "application/json"
              : "text/plain"
      const filename = `${activeArtifact.title}.${extension}`
      try {
        // Cross-platform saver — the prior `<a download>` path silently no-ops
        // inside a mobile WebView, so artifact exports vanished on Capacitor.
        const outcome = await saveExport({ filename, data: activeArtifact.content, mimeType })
        if (outcome.kind === "error") throw new Error(outcome.message)
        if (outcome.kind === "saved" && isDesktop) {
          setLastDownloadPath(outcome.location)
        }
        loggers.ui.info("artifacts.action.download", {
          artifactId: activeArtifact.id,
          format: preferredFormat ?? extension,
        })
      } catch (error) {
        loggers.ui.error("artifacts.action.download-failed", error, {
          artifactId: activeArtifact.id,
        })
        throw error
      }
    }
  }

  // Generate + save the artifact's content as a Word (.docx) or PDF document.
  // Treats the content as markdown; reuses the client-side document writer +
  // cross-platform saver, so it works on mobile WebView (unlike <a download>).
  const handleDownloadAs = async (format: DocFormat) => {
    if (!activeArtifact) return
    try {
      const outcome = await saveGeneratedDocument({
        title: activeArtifact.title,
        markdown: activeArtifact.content,
        format,
      })
      if (outcome.kind === "error") throw new Error(outcome.message)
      if (outcome.kind === "saved" && isDesktop) setLastDownloadPath(outcome.location)
      loggers.ui.info("artifacts.action.download-as", { artifactId: activeArtifact.id, format })
    } catch (error) {
      loggers.ui.error("artifacts.action.download-as-failed", error, {
        artifactId: activeArtifact.id,
      })
      throw error
    }
  }

  // Codex-style "open in new tab": pop a runnable html/svg artifact into a full
  // browser tab via a Blob URL. Static-export safe (no api route). Revoked after
  // a grace period so the opened tab has time to load.
  const handleOpenInNewTab = useCallback(() => {
    if (!activeArtifact) return
    const mimeType = activeArtifact.type === "svg" ? "image/svg+xml" : "text/html"
    try {
      const blob = new Blob([activeArtifact.content], { type: mimeType })
      const url = URL.createObjectURL(blob)
      window.open(url, "_blank", "noopener,noreferrer")
      setTimeout(() => URL.revokeObjectURL(url), 10000)
      loggers.ui.info("artifacts.action.open-in-new-tab", {
        artifactId: activeArtifact.id,
        type: activeArtifact.type,
      })
    } catch (error) {
      loggers.ui.error("artifacts.action.open-in-new-tab-failed", error, {
        artifactId: activeArtifact.id,
      })
      throw error
    }
  }, [activeArtifact])

  /**
   * Write the artifact into the user's project and open it right there in the
   * dock's workspace panel, so the next step (reading the diff) is one click
   * away instead of a trip through the OS file manager.
   *
   * Deliberately one-directional: the artifact records nothing about the file
   * afterwards. A stored link would owe us stale-detection and conflict
   * resolution the moment either side changed.
   */
  const handleSaveToProject = async () => {
    if (!activeArtifact) return
    const sessionId = useChatStore.getState().activeSessionId
    // Same source the workspace panel resolves its root from (see
    // `dock-workspace.tsx`), falling back to the project the artifact was
    // authored under when the chat itself is unbound.
    const session = sessionId ? await getSession(sessionId) : undefined
    const { project, root } = resolveSessionProjectRoot(
      { projectId: session?.projectId ?? activeArtifact.projectId },
      useProjectStore.getState().projects
    )
    const filename = `${activeArtifact.title}.${getExtension(activeArtifact)}`
    try {
      const outcome = await saveExport({
        filename,
        data: activeArtifact.content,
        mimeType: "text/plain",
        defaultDirectory: root?.path,
      })
      if (outcome.kind === "error") throw new Error(outcome.message)
      if (outcome.kind !== "saved") return
      if (isDesktop) setLastDownloadPath(outcome.location)

      // The dialog lets the user leave the project entirely; only a path that
      // landed under a mounted root can be revealed in the workspace panel.
      const roots = project ? allRootPaths(project) : []
      const containing = roots.find((candidate) => outcome.location.startsWith(`${candidate}/`))
      if (sessionId && containing) {
        useArtifactDockLayoutStore.getState().revealWorkspaceFile({
          sessionId,
          rootPath: containing,
          relPath: outcome.location.slice(containing.length + 1),
        })
      } else if (isDesktop) {
        await revealInExplorer(outcome.location)
      }
      loggers.ui.info("artifacts.action.save-to-project", {
        artifactId: activeArtifact.id,
        revealed: Boolean(containing),
      })
    } catch (error) {
      loggers.ui.error("artifacts.action.save-to-project-failed", error, {
        artifactId: activeArtifact.id,
      })
      throw error
    }
  }

  const handleRevealInExplorer = async () => {
    if (!isDesktop || !lastDownloadPath) return
    try {
      const { downloadDir } = await import("@tauri-apps/api/path")
      const downloadsPath = await downloadDir()
      const fullPath = `${downloadsPath}${lastDownloadPath}`
      await revealInExplorer(fullPath)
    } catch (revealError) {
      loggers.ui.warn("artifacts.reveal.failed", {
        error: revealError,
        artifactId: activeArtifact?.id,
      })
      try {
        const { downloadDir } = await import("@tauri-apps/api/path")
        const downloadsPath = await downloadDir()
        await openPath(downloadsPath)
      } catch (fallbackError) {
        // Best-effort: surfacing this is not a feature we have UI for yet.
        loggers.ui.warn("artifacts.reveal.fallback-failed", {
          error: fallbackError,
          artifactId: activeArtifact?.id,
        })
      }
    }
  }

  const isPreviewable = activeArtifact ? canPreview(activeArtifact.type) : false
  // Only html/svg render directly in a bare browser tab (react needs the
  // sandboxed bundler; other types aren't standalone documents).
  const isOpenableInNewTab = activeArtifact?.type === "html" || activeArtifact?.type === "svg"
  const panelMode: "desktop" | "tablet" | "mobile" | "fullscreen" = isFullscreen
    ? "fullscreen"
    : isMobileViewport
      ? "mobile"
      : isTabletViewport
        ? "tablet"
        : "desktop"
  const panelWidth =
    panelMode === "fullscreen"
      ? "w-full sm:w-full sm:max-w-full"
      : panelMode === "desktop"
        ? "w-full sm:w-[760px] sm:max-w-[760px]"
        : panelMode === "tablet"
          ? "w-full sm:w-[680px] sm:max-w-[680px]"
          : "w-full"

  const primaryActions: ArtifactPanelAction[] = [
    ...(isPreviewable ? ["modeTabs" as const] : []),
    "edit",
    "canvas",
    "fullscreen",
    "close",
  ]

  // Writing into the project needs a filesystem; the web shell has none.
  const canSaveToProject = isDesktop && hasWorkspaceFsBackend()

  const overflowActions: ArtifactPanelAction[] = [
    "copy",
    "download",
    ...(canSaveToProject ? ["saveToProject" as const] : []),
    ...(isOpenableInNewTab ? ["openInNewTab" as const] : []),
    ...(isDesktop && lastDownloadPath ? ["revealInExplorer" as const] : []),
    "versionHistory",
  ]

  return {
    // Translations
    t,
    tCommon,
    // Store state
    panelOpen,
    panelView,
    activeArtifact,
    pendingReview,
    theme,
    isDesktop,
    // Local state
    viewMode,
    setViewMode,
    copied,
    editContent,
    hasChanges,
    isFullscreen,
    showVersionHistory,
    setShowVersionHistory,
    lastDownloadPath,
    // Derived
    isPreviewable,
    isOpenableInNewTab,
    panelMode,
    panelWidth,
    primaryActions,
    overflowActions,
    // Actions
    closePanel,
    handleOpenInCanvas,
    handleEditMode,
    handleSaveEdit,
    handleCancelEdit,
    handleEditorChange,
    toggleFullscreen,
    handleCopy,
    handleDownload,
    handleDownloadAs,
    handleOpenInNewTab,
    handleRevealInExplorer,
    handleSaveToProject,
  }
}
