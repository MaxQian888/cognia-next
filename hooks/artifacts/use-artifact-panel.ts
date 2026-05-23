/**
 * useArtifactPanelState - Extracted state and logic for ArtifactPanel.
 *
 * cognia-next adapts the upstream hook by:
 *  - swapping `useNativeStore.isDesktop` for `isTauri()`
 *  - using `lib/tauri/opener` (revealInExplorer / openPath)
 *  - dropping the "Open in Full Designer" code path (no Designer subsystem)
 *  - using cognia-next's `downloadFile(filename, content, mimeType)` signature
 */

"use client"

import { useState, useCallback, useEffect } from "react"
import { useShallow } from "zustand/react/shallow"
import { useTranslations } from "next-intl"
import { useMediaQuery } from "@/hooks/ui"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useSettingsStore } from "@/stores/settings"
import { isTauri } from "@/lib/tauri"
import { revealInExplorer, openPath } from "@/lib/tauri/opener"
import { downloadFile } from "@/lib/files/download"
import { getArtifactExtension, canPreview } from "@/lib/artifacts"
import { loggers } from "@/lib/logging"
import {
  getArtifactRuntimeAdapter,
  getPreferredArtifactExportFormat,
} from "@/components/artifacts/runtime-adapters"
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
  | "revealInExplorer"
  | "versionHistory"

export function useArtifactPanelState() {
  const t = useTranslations("artifacts")
  const tCommon = useTranslations("common")

  // Store state - using useShallow for optimized subscriptions
  const { panelOpen, panelView, activeArtifactId, artifacts, artifactWorkspace } = useArtifactStore(
    useShallow((state) => ({
      panelOpen: state.panelOpen,
      panelView: state.panelView,
      activeArtifactId: state.activeArtifactId,
      artifacts: state.artifacts,
      artifactWorkspace: state.artifactWorkspace,
    }))
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

  const activeArtifact = activeArtifactId ? artifacts[activeArtifactId] : null
  const theme = useSettingsStore((state) => state.settings?.theme)
  const isDesktop = isTauri()
  const isMobileViewport = useMediaQuery("(max-width: 639px)")
  const isTabletViewport = useMediaQuery("(min-width: 640px) and (max-width: 1023px)")
  const runtimeAdapter = activeArtifact ? getArtifactRuntimeAdapter(activeArtifact.type) : null
  const canOpenEmbeddedDesigner = runtimeAdapter?.authoring.embeddedDesigner ?? false

  // Local state
  const [viewMode, setViewMode] = useState<"code" | "preview" | "edit">("code")
  const [copied, setCopied] = useState(false)
  const [designerOpen, setDesignerOpen] = useState(false)
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
      await navigator.clipboard.writeText(activeArtifact.content)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  const handleDownload = () => {
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
        downloadFile(filename, activeArtifact.content, mimeType)
        if (isDesktop) {
          setLastDownloadPath(filename)
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
  const isDesignable = canOpenEmbeddedDesigner
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

  const overflowActions: ArtifactPanelAction[] = [
    "copy",
    "download",
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
    theme,
    isDesktop,
    // Local state
    viewMode,
    setViewMode,
    copied,
    designerOpen,
    setDesignerOpen,
    editContent,
    hasChanges,
    isFullscreen,
    showVersionHistory,
    setShowVersionHistory,
    lastDownloadPath,
    // Derived
    isPreviewable,
    isDesignable,
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
    handleRevealInExplorer,
  }
}
