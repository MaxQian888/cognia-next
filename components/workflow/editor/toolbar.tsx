"use client"

import { useRef } from "react"
import {
  Save as SaveIcon,
  Play as PlayIcon,
  Undo2 as UndoIcon,
  Redo2 as RedoIcon,
  LayoutGrid as LayoutIcon,
  ArrowLeft as BackIcon,
  Download as ExportIcon,
  Upload as ImportIcon,
  Command as CommandIcon,
  Keyboard as KeyboardIcon,
} from "lucide-react"
import Link from "next/link"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type {
  PerformanceTier,
  ResolvedPerformanceTier,
} from "@/lib/workflow/editor/performance-tier"
import { PerformanceTierPopover } from "./performance-tier-popover"
import { ViewportBookmarks } from "./viewport-bookmarks"
import type { Viewport } from "@xyflow/react"

export interface EditorToolbarProps {
  workflowName: string
  onRename: (next: string) => void
  dirty: boolean
  saving?: boolean
  onSave: () => void
  onRun?: () => void
  onUndo?: () => void
  onRedo?: () => void
  canUndo?: boolean
  canRedo?: boolean
  onAutoLayout?: () => void
  onExportJson?: () => void
  onImportJson?: (json: string) => void
  onOpenCommandPalette?: () => void
  onOpenShortcuts?: () => void
  /** User-selected performance tier (defaults to "auto"). */
  performanceTier?: PerformanceTier
  /** Effective tier after auto resolution (display-only when `performanceTier` is "auto"). */
  effectivePerformanceTier?: ResolvedPerformanceTier
  onPerformanceTierChange?: (tier: PerformanceTier) => void
  /** Workflow id for the bookmarks dropdown. Omit to hide the control. */
  workflowId?: string
  /** Current canvas viewport, used as the "save current view" payload. */
  currentViewport?: Viewport
  /** Restore handler — typically wraps `reactFlowInstance.setViewport`. */
  onRestoreViewport?: (viewport: Viewport) => void
}

export function EditorToolbar({
  workflowName,
  onRename,
  dirty,
  saving,
  onSave,
  onRun,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  onAutoLayout,
  onExportJson,
  onImportJson,
  onOpenCommandPalette,
  onOpenShortcuts,
  performanceTier,
  effectivePerformanceTier,
  onPerformanceTierChange,
  workflowId,
  currentViewport,
  onRestoreViewport,
}: EditorToolbarProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const t = useTranslations("workflows.toolbar")

  function handleImportClick() {
    fileInputRef.current?.click()
  }
  function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !onImportJson) return
    const reader = new FileReader()
    reader.onload = () => {
      const text = typeof reader.result === "string" ? reader.result : ""
      if (text) onImportJson(text)
    }
    reader.readAsText(file)
    // Reset input so the same file can be re-picked.
    e.target.value = ""
  }

  return (
    <div
      className="flex items-center gap-2 border-b bg-background/95 px-3 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/80"
      data-testid="workflow-toolbar"
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Button asChild size="icon" variant="ghost">
            <Link href="/workflows" aria-label={t("tooltip.back")}>
              <BackIcon className="size-4" />
            </Link>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t("tooltip.back")}</TooltipContent>
      </Tooltip>
      <Input
        value={workflowName}
        onChange={(e) => onRename(e.target.value)}
        className="max-w-xs h-8"
        aria-label={t("namePlaceholder")}
      />
      <span
        className={cn(
          "text-xs px-2 py-0.5 rounded-full",
          dirty
            ? "bg-wf-status-running/15 text-wf-status-running"
            : "bg-wf-status-succeeded/15 text-wf-status-succeeded"
        )}
        aria-live="polite"
      >
        {dirty ? t("unsavedChanges") : t("saved")}
      </span>
      <div className="ml-auto flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              onClick={onUndo}
              disabled={!canUndo}
              aria-label={t("tooltip.undo")}
              data-testid="workflow-undo"
            >
              <UndoIcon className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t("tooltip.undo")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              onClick={onRedo}
              disabled={!canRedo}
              aria-label={t("tooltip.redo")}
              data-testid="workflow-redo"
            >
              <RedoIcon className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t("tooltip.redo")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              onClick={onAutoLayout}
              aria-label={t("tooltip.autoLayout")}
              data-testid="workflow-auto-layout"
            >
              <LayoutIcon className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t("tooltip.autoLayout")}</TooltipContent>
        </Tooltip>
        {onOpenCommandPalette ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                onClick={onOpenCommandPalette}
                aria-label={t("tooltip.commands")}
                data-testid="workflow-command-palette"
              >
                <CommandIcon className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t("tooltip.commands")}</TooltipContent>
          </Tooltip>
        ) : null}
        {onOpenShortcuts ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                onClick={onOpenShortcuts}
                aria-label={t("tooltip.shortcuts")}
                data-testid="workflow-shortcuts"
              >
                <KeyboardIcon className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t("tooltip.shortcuts")}</TooltipContent>
          </Tooltip>
        ) : null}
        {performanceTier !== undefined &&
        effectivePerformanceTier !== undefined &&
        onPerformanceTierChange ? (
          <PerformanceTierPopover
            value={performanceTier}
            effective={effectivePerformanceTier}
            onChange={onPerformanceTierChange}
          />
        ) : null}
        {workflowId && currentViewport && onRestoreViewport ? (
          <ViewportBookmarks
            workflowId={workflowId}
            currentViewport={currentViewport}
            onRestore={onRestoreViewport}
          />
        ) : null}
        {onExportJson ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                onClick={onExportJson}
                aria-label={t("tooltip.exportJson")}
                data-testid="workflow-export-json"
              >
                <ExportIcon className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t("tooltip.exportJson")}</TooltipContent>
          </Tooltip>
        ) : null}
        {onImportJson ? (
          <>
            <input
              type="file"
              ref={fileInputRef}
              accept="application/json,.json"
              className="hidden"
              onChange={handleImportFile}
              data-testid="workflow-import-input"
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={handleImportClick}
                  aria-label={t("tooltip.importJson")}
                  data-testid="workflow-import-json"
                >
                  <ImportIcon className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t("tooltip.importJson")}</TooltipContent>
            </Tooltip>
          </>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          onClick={onSave}
          disabled={!dirty || saving}
          data-testid="workflow-save"
        >
          <SaveIcon className="size-4 mr-1.5" />
          {saving ? t("saving") : t("save")}
        </Button>
        <Button size="sm" onClick={onRun} disabled={!onRun} data-testid="workflow-run">
          <PlayIcon className="size-4 mr-1.5" />
          {t("run")}
        </Button>
      </div>
    </div>
  )
}
