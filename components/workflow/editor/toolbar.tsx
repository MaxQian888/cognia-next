"use client"

import { memo, useRef, useState } from "react"
import {
  Save as SaveIcon,
  Play as PlayIcon,
  ArrowLeft as BackIcon,
  Download as ExportIcon,
  Upload as ImportIcon,
  Command as CommandIcon,
  Keyboard as KeyboardIcon,
  Image as ImageIcon,
  Link2 as ShareIcon,
  MoreHorizontal as MoreIcon,
  RotateCcw as RevertIcon,
  PanelLeft as PanelLeftIcon,
  PanelRight as PanelRightIcon,
} from "lucide-react"
import Link from "next/link"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { cn } from "@/lib/utils"

export interface EditorToolbarProps {
  workflowName: string
  onRename: (next: string) => void
  dirty: boolean
  saving?: boolean
  onSave: () => void
  onRun?: () => void
  /** Discard unsaved changes and reload the last persisted version. */
  onRevert?: () => void
  onExportJson?: () => void
  onExportImage?: () => void
  onShareImage?: () => void
  onImportJson?: (json: string) => void
  onOpenCommandPalette?: () => void
  onOpenShortcuts?: () => void
  /** Collapse/expand the node palette (left panel). Ctrl/Cmd+B. */
  onToggleLeftPanel?: () => void
  leftPanelCollapsed?: boolean
  /** Collapse/expand the right sidebar. Ctrl/Cmd+J. */
  onToggleRightPanel?: () => void
  rightPanelCollapsed?: boolean
}

export const EditorToolbar = memo(function EditorToolbar({
  workflowName,
  onRename,
  dirty,
  saving,
  onSave,
  onRun,
  onRevert,
  onExportJson,
  onExportImage,
  onShareImage,
  onImportJson,
  onOpenCommandPalette,
  onOpenShortcuts,
  onToggleLeftPanel,
  leftPanelCollapsed,
  onToggleRightPanel,
  rightPanelCollapsed,
}: EditorToolbarProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [revertOpen, setRevertOpen] = useState(false)
  const t = useTranslations("workflows.toolbar")
  const tShare = useTranslations("share")
  const canRevert = Boolean(onRevert) && dirty

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

  const hasOverflow = Boolean(
    onOpenCommandPalette ||
    onOpenShortcuts ||
    onExportJson ||
    onExportImage ||
    onShareImage ||
    onImportJson ||
    canRevert
  )

  return (
    <div
      // Same named height as every other chrome bar (ADR-0148). This one holds
      // a full-size name Input, so it reads the tall token, not the 40px one.
      className="flex h-[var(--chrome-h-tall)] shrink-0 items-center gap-2 border-b bg-background/95 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/80"
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
      {onToggleLeftPanel ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              onClick={onToggleLeftPanel}
              aria-label={t("tooltip.togglePalette")}
              aria-pressed={!leftPanelCollapsed}
              data-testid="workflow-toggle-left-panel"
              className={cn(leftPanelCollapsed && "text-muted-foreground")}
            >
              <PanelLeftIcon className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t("tooltip.togglePalette")}</TooltipContent>
        </Tooltip>
      ) : null}
      <Input
        value={workflowName}
        onChange={(e) => onRename(e.target.value)}
        className="max-w-xs h-8"
        aria-label={t("namePlaceholder")}
      />
      <span
        className={cn(
          "text-xs px-2 py-0.5 rounded-pill",
          dirty
            ? "bg-wf-status-running/15 text-wf-status-running"
            : "bg-wf-status-succeeded/15 text-wf-status-succeeded"
        )}
        aria-live="polite"
      >
        {dirty ? t("unsavedChanges") : t("saved")}
      </span>
      <div className="ml-auto flex items-center gap-1">
        {onImportJson ? (
          <input
            type="file"
            ref={fileInputRef}
            accept="application/json,.json"
            className="hidden"
            onChange={handleImportFile}
            data-testid="workflow-import-input"
          />
        ) : null}
        {hasOverflow ? (
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={t("tooltip.more")}
                    data-testid="workflow-overflow"
                  >
                    <MoreIcon className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t("tooltip.more")}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" className="w-56">
              {onOpenCommandPalette ? (
                <DropdownMenuItem
                  onSelect={onOpenCommandPalette}
                  data-testid="workflow-command-palette"
                >
                  <CommandIcon className="size-4" aria-hidden />
                  {t("tooltip.commands")}
                </DropdownMenuItem>
              ) : null}
              {onOpenShortcuts ? (
                <DropdownMenuItem onSelect={onOpenShortcuts} data-testid="workflow-shortcuts">
                  <KeyboardIcon className="size-4" aria-hidden />
                  {t("tooltip.shortcuts")}
                </DropdownMenuItem>
              ) : null}
              {(onExportJson || onExportImage || onShareImage || onImportJson) &&
              (onOpenCommandPalette || onOpenShortcuts) ? (
                <DropdownMenuSeparator />
              ) : null}
              {onExportJson ? (
                <DropdownMenuItem onSelect={onExportJson} data-testid="workflow-export-json">
                  <ExportIcon className="size-4" aria-hidden />
                  {t("tooltip.exportJson")}
                </DropdownMenuItem>
              ) : null}
              {onExportImage ? (
                <DropdownMenuItem onSelect={onExportImage} data-testid="workflow-export-image">
                  <ImageIcon className="size-4" aria-hidden />
                  {t("tooltip.exportImage")}
                </DropdownMenuItem>
              ) : null}
              {onShareImage ? (
                <DropdownMenuItem onSelect={onShareImage} data-testid="workflow-share-image">
                  <ShareIcon className="size-4" aria-hidden />
                  {tShare("shareAction")}
                </DropdownMenuItem>
              ) : null}
              {onImportJson ? (
                <DropdownMenuItem onSelect={handleImportClick} data-testid="workflow-import-json">
                  <ImportIcon className="size-4" aria-hidden />
                  {t("tooltip.importJson")}
                </DropdownMenuItem>
              ) : null}
              {canRevert ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => setRevertOpen(true)}
                    data-testid="workflow-revert"
                  >
                    <RevertIcon className="size-4" aria-hidden />
                    {t("revert")}
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
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
        {onToggleRightPanel ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                onClick={onToggleRightPanel}
                aria-label={t("tooltip.toggleSidebar")}
                aria-pressed={!rightPanelCollapsed}
                data-testid="workflow-toggle-right-panel"
                className={cn(rightPanelCollapsed && "text-muted-foreground")}
              >
                <PanelRightIcon className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t("tooltip.toggleSidebar")}</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      <AlertDialog open={revertOpen} onOpenChange={setRevertOpen}>
        <AlertDialogContent data-testid="workflow-revert-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("revertConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("revertConfirmDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("revertCancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                onRevert?.()
                setRevertOpen(false)
              }}
              data-testid="workflow-revert-confirm"
            >
              {t("revertConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
})
