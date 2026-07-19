"use client"

/**
 * A2UI Workspace Toolbar
 * Grouped action bar: [Undo/Redo] | [Mode] | [AI] | [Save/Export/Share]
 */

import React, { useCallback, useState } from "react"
import { useLocale, useTranslations } from "next-intl"
import {
  Database,
  Download,
  Eye,
  PanelRight,
  Pencil,
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
import { Separator } from "@/components/ui/separator"
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
import { generateAppFromDescription } from "@/lib/a2ui/app-generator"
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
    setWorkspaceMode,
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
  const appBuilder = useA2UIAppBuilder({})
  const saveApp = useA2UISave(surfaceId)
  const [shareOpen, setShareOpen] = useState(false)
  const [regenerateOpen, setRegenerateOpen] = useState(false)
  const [regeneratePrompt, setRegeneratePrompt] = useState("")

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

  const handleRegenerate = useCallback(() => {
    const description = regeneratePrompt.trim()
    if (!description) return

    try {
      const appLocale = appBuilder.getAppInstance(surfaceId)?.locale ?? locale
      const generated = generateAppFromDescription({
        description,
        language: appLocale === "zh-CN" ? "zh" : "en",
      })
      const replaced = replaceSurfaceContent(
        surfaceId,
        generated.components,
        generated.dataModel,
        "root"
      )
      if (!replaced) {
        toast.error(t("generationFailed"))
        return
      }
      setRegenerateOpen(false)
      setRegeneratePrompt("")
      toast.success(t("appRegenerated"))
    } catch {
      toast.error(t("generationFailed"))
    }
  }, [appBuilder, locale, regeneratePrompt, replaceSurfaceContent, surfaceId, t])

  return (
    <div className="flex items-center gap-1 border-b px-2 py-1 bg-background/95 backdrop-blur shrink-0">
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

      {/* Mode buttons drive the desktop three-panel layout only — on mobile
          the bottom tab-bar owns panel navigation, so this group is hidden to
          keep the touch toolbar to undo/redo + save/export/share. */}
      <div className="hidden items-center gap-1 sm:flex">
        <Separator orientation="vertical" className="h-6 mx-1" />
        <ToolbarButton
          icon={<Pencil className="h-4 w-4" />}
          label={t("editMode")}
          onClick={() => setWorkspaceMode("edit")}
          active={workspaceMode === "edit"}
        />
        <ToolbarButton
          icon={<Eye className="h-4 w-4" />}
          label={t("previewMode")}
          onClick={() => setWorkspaceMode("preview")}
          active={workspaceMode === "preview"}
        />
        <ToolbarButton
          icon={<Database className="h-4 w-4" />}
          label={t("dataMode")}
          onClick={() => setWorkspaceMode("data")}
          active={workspaceMode === "data"}
        />
        <Separator orientation="vertical" className="h-6 mx-1" />
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
            <Separator orientation="vertical" className="h-6 mx-1" />
          </>
        )}
        <ToolbarButton
          icon={<ZoomOut className="size-4" />}
          label={t("zoomOut")}
          onClick={() => setZoom(zoom - WORKSPACE_ZOOM_STEP)}
          disabled={zoom <= MIN_WORKSPACE_ZOOM}
        />
        <ToolbarButton
          icon={<RotateCcw className="size-4" />}
          label={t("resetZoomWithLevel", { zoom })}
          onClick={() => setZoom(100)}
          disabled={zoom === 100}
        />
        <ToolbarButton
          icon={<ZoomIn className="size-4" />}
          label={t("zoomIn")}
          onClick={() => setZoom(zoom + WORKSPACE_ZOOM_STEP)}
          disabled={zoom >= MAX_WORKSPACE_ZOOM}
        />
        <Separator orientation="vertical" className="h-6 mx-1" />
      </div>

      {/* AI Generate */}
      <ToolbarButton
        icon={<Sparkles className="h-4 w-4" />}
        label={t("aiGenerate")}
        onClick={() => setRegenerateOpen(true)}
        showLabel
      />

      <div className="flex-1" />

      {/* Save / Export / Share */}
      <ToolbarButton
        icon={<Save className="h-4 w-4" />}
        label={t("saveApp")}
        onClick={handleSave}
        shortcut="Ctrl+S"
      />
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

      <ShareLinkDialog
        open={shareOpen}
        onOpenChange={setShareOpen}
        buildPayload={buildSharePayload}
      />

      <Dialog open={regenerateOpen} onOpenChange={setRegenerateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("aiGenerate")}</DialogTitle>
            <DialogDescription>{t("regenerateAppDescription")}</DialogDescription>
          </DialogHeader>
          <Textarea
            value={regeneratePrompt}
            onChange={(event) => setRegeneratePrompt(event.target.value)}
            placeholder={t("aiRegeneratePrompt")}
            rows={4}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRegenerateOpen(false)}>
              {t("cancel")}
            </Button>
            <Button onClick={handleRegenerate} disabled={!regeneratePrompt.trim()}>
              <Sparkles className="h-4 w-4" />
              {t("regenerate")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

interface ToolbarButtonProps {
  icon: React.ReactNode
  label: string
  onClick: () => void
  disabled?: boolean
  active?: boolean
  shortcut?: string
  showLabel?: boolean
}

function ToolbarButton({
  icon,
  label,
  onClick,
  disabled,
  active,
  shortcut,
  showLabel,
}: ToolbarButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={label}
          variant={active ? "secondary" : "ghost"}
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
