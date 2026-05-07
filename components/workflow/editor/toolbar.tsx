"use client"

import {
  Save as SaveIcon,
  Play as PlayIcon,
  Undo2 as UndoIcon,
  Redo2 as RedoIcon,
  LayoutGrid as LayoutIcon,
  ArrowLeft as BackIcon,
} from "lucide-react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

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
}: EditorToolbarProps) {
  return (
    <div
      className="flex items-center gap-2 border-b bg-background/95 px-3 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/80"
      data-testid="workflow-toolbar"
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Button asChild size="icon" variant="ghost">
            <Link href="/workflows" aria-label="Back to library">
              <BackIcon className="size-4" />
            </Link>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Back to library</TooltipContent>
      </Tooltip>
      <Input
        value={workflowName}
        onChange={(e) => onRename(e.target.value)}
        className="max-w-xs h-8"
        aria-label="Workflow name"
      />
      <span
        className={cn(
          "text-xs px-2 py-0.5 rounded-full",
          dirty
            ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
            : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
        )}
        aria-live="polite"
      >
        {dirty ? "Unsaved changes" : "Saved"}
      </span>
      <div className="ml-auto flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              onClick={onUndo}
              disabled={!canUndo}
              aria-label="Undo"
              data-testid="workflow-undo"
            >
              <UndoIcon className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Undo (Ctrl+Z)</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              onClick={onRedo}
              disabled={!canRedo}
              aria-label="Redo"
              data-testid="workflow-redo"
            >
              <RedoIcon className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Redo (Ctrl+Shift+Z)</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              onClick={onAutoLayout}
              aria-label="Auto-layout"
              data-testid="workflow-auto-layout"
            >
              <LayoutIcon className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Auto-layout</TooltipContent>
        </Tooltip>
        <Button
          size="sm"
          variant="outline"
          onClick={onSave}
          disabled={!dirty || saving}
          data-testid="workflow-save"
        >
          <SaveIcon className="size-4 mr-1.5" />
          {saving ? "Saving…" : "Save"}
        </Button>
        <Button size="sm" onClick={onRun} disabled={!onRun} data-testid="workflow-run">
          <PlayIcon className="size-4 mr-1.5" />
          Run
        </Button>
      </div>
    </div>
  )
}
