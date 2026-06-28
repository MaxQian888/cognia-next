"use client"

/**
 * A2UI Workspace Toolbar
 * Grouped action bar: [Undo/Redo] | [Mode] | [AI] | [Save/Export/Share]
 */

import React, { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import { Undo2, Redo2, Sparkles, Save, Download, Share2, Pencil, Eye, Database } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useA2UIStore } from "@/stores/a2ui"
import { useA2UIAppBuilder } from "@/hooks/a2ui/use-app-builder"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import { ShareLinkDialog } from "@/components/share/share-link-dialog"
import { a2uiPayload } from "@/lib/share/payload"
import { useWorkspaceContext } from "./a2ui-workspace-context"

export function A2UIToolbar() {
  const t = useTranslations("a2ui")
  const { surfaceId, workspaceMode, setWorkspaceMode } = useWorkspaceContext()

  const canUndo = useA2UIStore((state) => (state.undoStacks[surfaceId]?.length || 0) > 0)
  const canRedo = useA2UIStore((state) => (state.redoStacks[surfaceId]?.length || 0) > 0)
  const undo = useA2UIStore((state) => state.undo)
  const redo = useA2UIStore((state) => state.redo)
  const appBuilder = useA2UIAppBuilder({})
  const [shareOpen, setShareOpen] = useState(false)

  const handleUndo = useCallback(() => undo(surfaceId), [undo, surfaceId])
  const handleRedo = useCallback(() => redo(surfaceId), [redo, surfaceId])

  const handleSave = useCallback(() => {
    toast.success(t("appSaved"))
  }, [t])

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
      appBuilder.exportApp(surfaceId)
      toast.success(t("appExported"))
    } catch {
      toast.error(t("generationFailed"))
    }
  }, [appBuilder, surfaceId, t])

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
      </div>

      {/* AI Generate */}
      <ToolbarButton
        icon={<Sparkles className="h-4 w-4" />}
        label={t("aiGenerate")}
        onClick={() => {
          /* TODO: AI regeneration dialog */
        }}
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
