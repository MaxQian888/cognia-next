"use client"

/**
 * A2UI Workspace Toolbar
 * Grouped action bar: [Undo/Redo] | [Mode] | [AI] | [Save/Export/Share]
 */

import React, { useCallback, useState } from "react"
import { useLocale, useTranslations } from "next-intl"
import {
  BookmarkPlus,
  Download,
  Loader2,
  PanelRight,
  Redo2,
  RotateCcw,
  Save,
  Share2,
  Sparkles,
  TreePine,
  Undo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useA2UIStore } from "@/stores/a2ui"
import { useA2UIAppBuilder } from "@/hooks/a2ui/use-app-builder"
import { useA2UISave } from "@/hooks/a2ui/use-a2ui-save"
import {
  generateA2UIApp,
  streamDispatchToStore,
  A2UIAiUnavailableError,
} from "@/lib/a2ui/ai-generate"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import { ShareLinkDialog } from "@/components/share/share-link-dialog"
import { a2uiPayload } from "@/lib/share/payload"
import {
  MAX_WORKSPACE_ZOOM,
  MIN_WORKSPACE_ZOOM,
  WORKSPACE_ZOOM_STEP,
  useWorkspaceContext,
} from "./a2ui-workspace-context"

export function A2UIToolbar() {
  const t = useTranslations("a2ui")
  const locale = useLocale()
  const {
    surfaceId,
    workspaceMode,
    zoom,
    setZoom,
    showTree,
    setShowTree,
    showProperties,
    setShowProperties,
  } = useWorkspaceContext()

  const canUndo = useA2UIStore((state) => (state.undoStacks[surfaceId]?.length || 0) > 0)
  const canRedo = useA2UIStore((state) => (state.redoStacks[surfaceId]?.length || 0) > 0)
  const undo = useA2UIStore((state) => state.undo)
  const redo = useA2UIStore((state) => state.redo)
  const replaceSurfaceContent = useA2UIStore((state) => state.replaceSurfaceContent)
  const updateComponents = useA2UIStore((state) => state.updateComponents)
  const updateDataModel = useA2UIStore((state) => state.updateDataModel)
  const appBuilder = useA2UIAppBuilder({})
  const saveApp = useA2UISave(surfaceId)
  const [shareOpen, setShareOpen] = useState(false)
  const [regenerateOpen, setRegenerateOpen] = useState(false)
  const [regeneratePrompt, setRegeneratePrompt] = useState("")
  const [aiMode, setAiMode] = useState<"edit" | "create">("edit")
  const [isGenerating, setIsGenerating] = useState(false)

  const handleUndo = useCallback(() => undo(surfaceId), [undo, surfaceId])
  const handleRedo = useCallback(() => redo(surfaceId), [redo, surfaceId])

  const handleSave = useCallback(async () => {
    try {
      const ok = await saveApp()
      if (ok) toast.success(t("appSaved"))
      else toast.error(t("generationFailed"))
    } catch {
      toast.error(t("generationFailed"))
    }
  }, [saveApp, t])

  const buildSharePayload = useCallback(() => {
    const json = appBuilder.exportApp(surfaceId)
    if (!json) throw new Error("a2ui export failed")
    let title = t("shareApp")
    try {
      const parsed = JSON.parse(json) as { app?: { title?: string; name?: string } }
      title = parsed.app?.title || parsed.app?.name || title
    } catch {
      /* keep fallback title */
    }
    return a2uiPayload(json, title)
  }, [appBuilder, surfaceId, t])

  const handleExport = useCallback(() => {
    try {
      if (!appBuilder.downloadApp(surfaceId)) {
        toast.error(t("generationFailed"))
        return
      }
      toast.success(t("appExported"))
    } catch {
      toast.error(t("generationFailed"))
    }
  }, [appBuilder, surfaceId, t])

  const handleSaveTemplate = useCallback(async () => {
    try {
      const ok = await appBuilder.saveAsTemplate(surfaceId)
      if (ok) toast.success(t("savedAsTemplate"))
      else toast.error(t("generationFailed"))
    } catch {
      toast.error(t("generationFailed"))
    }
  }, [appBuilder, surfaceId, t])

  const handleAiRun = useCallback(async () => {
    const instruction = regeneratePrompt.trim()
    if (!instruction || isGenerating) return
    setIsGenerating(true)

    try {
      const appLocale = appBuilder.getAppInstance(surfaceId)?.locale ?? locale
      const language = appLocale === "zh-CN" ? "zh" : "en"

      if (aiMode === "edit") {
        // Incremental edit: stream patches onto the live canvas, then reconcile
        // with the authoritative merged tree the model returned.
        const surface = useA2UIStore.getState().surfaces[surfaceId]
        const result = await generateA2UIApp({
          instruction,
          mode: "edit",
          surfaceId,
          language,
          currentComponents: surface ? Object.values(surface.components) : [],
          onDispatch: streamDispatchToStore,
        })
        updateComponents(surfaceId, result.components)
        updateDataModel(surfaceId, result.dataModel, false)
        toast.success(t("appEdited"))
      } else {
        // Whole-app regenerate: stream in, then a clean full replace so no
        // orphan components from the previous tree survive.
        const result = await generateA2UIApp({
          instruction,
          mode: "create",
          surfaceId,
          language,
          onDispatch: streamDispatchToStore,
        })
        const replaced = replaceSurfaceContent(
          surfaceId,
          result.components,
          result.dataModel,
          result.rootId
        )
        if (!replaced) {
          toast.error(t("generationFailed"))
          return
        }
        if (result.usedFallback) toast.info(t("usedTemplateFallback"))
        else toast.success(t("appRegenerated"))
      }

      setRegenerateOpen(false)
      setRegeneratePrompt("")
    } catch (err) {
      if (err instanceof A2UIAiUnavailableError) toast.error(t("aiEditUnavailable"))
      else toast.error(t("generationFailed"))
    } finally {
      setIsGenerating(false)
    }
  }, [
    aiMode,
    appBuilder,
    isGenerating,
    locale,
    regeneratePrompt,
    replaceSurfaceContent,
    surfaceId,
    t,
    updateComponents,
    updateDataModel,
  ])

  return (
    <div className="flex w-full items-center gap-0.5">
      {/* Undo/Redo */}
      <ToolbarButton
        icon={<Undo2 className="h-4 w-4" />}
        label={t("undo")}
        onClick={handleUndo}
        disabled={!canUndo}
        shortcut="Ctrl+Z"
      />
      <ToolbarButton
        icon={<Redo2 className="h-4 w-4" />}
        label={t("redo")}
        onClick={handleRedo}
        disabled={!canRedo}
        shortcut="Ctrl+Y"
      />

      {/* Panel + zoom controls are desktop-only: on mobile the bottom tab-bar
          owns panel navigation and the preview is already fit-to-width, so the
          touch toolbar stays at undo/redo + AI + save/export/share. The
          edit/preview/data switch is NOT repeated here — the header's mode tabs
          are the single control for it. */}
      <div className="hidden items-center gap-0.5 sm:flex">
        <ToolbarDivider />
        {workspaceMode === "edit" && (
          <>
            <ToolbarButton
              icon={<TreePine className="size-4" />}
              label={t(showTree ? "hideComponentTree" : "showComponentTree")}
              onClick={() => setShowTree(!showTree)}
              active={showTree}
            />
            <ToolbarButton
              icon={<PanelRight className="size-4" />}
              label={t(showProperties ? "hidePropertiesPanel" : "showPropertiesPanel")}
              onClick={() => setShowProperties(!showProperties)}
              active={showProperties}
            />
            <ToolbarDivider />
          </>
        )}
        <ToolbarButton
          icon={<ZoomOut className="size-4" />}
          label={t("zoomOut")}
          onClick={() => setZoom(zoom - WORKSPACE_ZOOM_STEP)}
          disabled={zoom <= MIN_WORKSPACE_ZOOM}
        />
        {/* The zoom level used to live only inside the reset button's tooltip,
            which meant the current scale was invisible until you hovered. */}
        <span className="w-10 text-center text-xs tabular-nums text-muted-foreground">{zoom}%</span>
        <ToolbarButton
          icon={<ZoomIn className="size-4" />}
          label={t("zoomIn")}
          onClick={() => setZoom(zoom + WORKSPACE_ZOOM_STEP)}
          disabled={zoom >= MAX_WORKSPACE_ZOOM}
        />
        <ToolbarButton
          icon={<RotateCcw className="size-4" />}
          label={t("resetZoomWithLevel", { zoom })}
          onClick={() => setZoom(100)}
          disabled={zoom === 100}
        />
      </div>

      <div className="flex-1" />

      {/* Secondary: export / share / save-as-template stay icon-only ghosts so
          the single filled button below reads as the primary action. */}
      <ToolbarButton
        icon={<Download className="h-4 w-4" />}
        label={t("export")}
        onClick={handleExport}
      />
      <ToolbarButton
        icon={<Share2 className="h-4 w-4" />}
        label={t("shareApp")}
        onClick={() => setShareOpen(true)}
      />
      <ToolbarButton
        icon={<BookmarkPlus className="h-4 w-4" />}
        label={t("saveAsTemplate")}
        onClick={handleSaveTemplate}
      />

      <ToolbarDivider />

      <ToolbarButton
        icon={<Sparkles className="h-4 w-4" />}
        label={t("aiGenerate")}
        onClick={() => setRegenerateOpen(true)}
        showLabel
        variant="outline"
      />
      <ToolbarButton
        icon={<Save className="h-4 w-4" />}
        label={t("saveApp")}
        onClick={handleSave}
        shortcut="Ctrl+S"
        showLabel
        variant="default"
      />

      <ShareLinkDialog
        open={shareOpen}
        onOpenChange={setShareOpen}
        buildPayload={buildSharePayload}
      />

      <Dialog
        open={regenerateOpen}
        onOpenChange={(open) => !isGenerating && setRegenerateOpen(open)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("aiGenerate")}</DialogTitle>
            <DialogDescription>
              {aiMode === "edit" ? t("aiEditDescription") : t("regenerateAppDescription")}
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-1 rounded-md bg-muted p-1">
            <Button
              type="button"
              variant={aiMode === "edit" ? "secondary" : "ghost"}
              size="sm"
              className="flex-1"
              onClick={() => setAiMode("edit")}
              disabled={isGenerating}
            >
              {t("aiEditMode")}
            </Button>
            <Button
              type="button"
              variant={aiMode === "create" ? "secondary" : "ghost"}
              size="sm"
              className="flex-1"
              onClick={() => setAiMode("create")}
              disabled={isGenerating}
            >
              {t("aiCreateMode")}
            </Button>
          </div>
          <Textarea
            value={regeneratePrompt}
            onChange={(event) => setRegeneratePrompt(event.target.value)}
            placeholder={aiMode === "edit" ? t("aiRegeneratePrompt") : t("aiCreatePrompt")}
            rows={4}
            disabled={isGenerating}
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRegenerateOpen(false)}
              disabled={isGenerating}
            >
              {t("cancel")}
            </Button>
            <Button onClick={handleAiRun} disabled={!regeneratePrompt.trim() || isGenerating}>
              {isGenerating ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
              {isGenerating
                ? t("generating")
                : aiMode === "edit"
                  ? t("applyEdit")
                  : t("regenerate")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function ToolbarDivider() {
  return <span className="mx-1 h-4 w-px shrink-0 bg-border" aria-hidden="true" />
}

interface ToolbarButtonProps {
  icon: React.ReactNode
  label: string
  onClick: () => void
  disabled?: boolean
  active?: boolean
  shortcut?: string
  showLabel?: boolean
  /** Overrides the ghost/secondary default — `default` marks the one primary. */
  variant?: "default" | "outline"
}

function ToolbarButton({
  icon,
  label,
  onClick,
  disabled,
  active,
  shortcut,
  showLabel,
  variant,
}: ToolbarButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={label}
          variant={variant ?? (active ? "secondary" : "ghost")}
          size="sm"
          className={cn("h-7 px-2 gap-1", disabled && "opacity-40")}
          onClick={onClick}
          disabled={disabled}
        >
          {icon}
          {showLabel && <span className="hidden sm:inline text-xs">{label}</span>}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        <span>{label}</span>
        {shortcut && <span className="ml-2 text-muted-foreground text-[10px]">{shortcut}</span>}
      </TooltipContent>
    </Tooltip>
  )
}
