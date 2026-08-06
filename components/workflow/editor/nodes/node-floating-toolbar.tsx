"use client"

/**
 * Flowith-style floating mini toolbar that appears above a node on hover
 * (or when selected). Five ghost-icon buttons: Run · Copy · Configure ·
 * Delete · More. "More" emits the request to open the canvas context menu
 * at the button's screen position.
 *
 * Motion budget: enter/exit fade is gated by `flags.nodeCardTransitions`
 * (driven by the `performanceTier` resolver). When false, the toolbar
 * shows/hides instantly through CSS opacity classes — no JS animation.
 */

import { useRef } from "react"
import { useTranslations } from "next-intl"
import {
  Copy as CopyIcon,
  MoreHorizontal,
  Play as PlayIcon,
  Settings as ConfigureIcon,
  Trash2 as DeleteIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { WorkflowNodeKind } from "@/types/workflow/visual"
import { workflowNodeCategory } from "@/types/workflow/visual"
import { Toolbar } from "@/components/ai-elements/toolbar"
import { Position } from "@xyflow/react"

export interface NodeFloatingToolbarProps {
  nodeId: string
  kind: WorkflowNodeKind
  /** Always visible (selected/hovered). When false, CSS-only hover reveal. */
  alwaysVisible: boolean
  /** When false, drop entrance / exit animations. */
  motionEnabled: boolean
  onRun: () => void
  onCopy: () => void
  onConfigure: () => void
  onDelete: () => void
  onMore: (anchorRect: DOMRect) => void
}

export function NodeFloatingToolbar({
  nodeId,
  kind,
  alwaysVisible,
  motionEnabled,
  onRun,
  onCopy,
  onConfigure,
  onDelete,
  onMore,
}: NodeFloatingToolbarProps) {
  const t = useTranslations("workflows.editor.miniToolbar")
  const category = workflowNodeCategory(kind)
  const runnable = category !== "trigger" && category !== "annotation"
  const moreBtnRef = useRef<HTMLButtonElement | null>(null)

  return (
    <Toolbar
      position={Position.Top}
      offset={8}
      isVisible
      data-testid={`wf-node-toolbar-${nodeId}`}
      data-always-visible={alwaysVisible ? "true" : "false"}
      data-motion={motionEnabled ? "on" : "off"}
      className={cn(
        "flex items-center gap-0.5 rounded-md border bg-popover/95 px-1 py-0.5 shadow-sm",
        // Motion: when on, opacity transitions for a soft fade. When off,
        // bare CSS visibility toggle via group-hover (no JS animation).
        motionEnabled
          ? "opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100"
          : "opacity-0 group-hover:opacity-100 focus-within:opacity-100",
        alwaysVisible && "!opacity-100"
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7"
            disabled={!runnable}
            aria-label={t("run")}
            aria-disabled={!runnable || undefined}
            onClick={(e) => {
              e.stopPropagation()
              if (runnable) onRun()
            }}
            data-testid="wf-node-toolbar-run"
          >
            <PlayIcon className="size-3.5" aria-hidden />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">{runnable ? t("run") : t("runDisabled")}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7"
            aria-label={t("copy")}
            onClick={(e) => {
              e.stopPropagation()
              onCopy()
            }}
            data-testid="wf-node-toolbar-copy"
          >
            <CopyIcon className="size-3.5" aria-hidden />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">{t("copy")}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7"
            aria-label={t("configure")}
            onClick={(e) => {
              e.stopPropagation()
              onConfigure()
            }}
            data-testid="wf-node-toolbar-configure"
          >
            <ConfigureIcon className="size-3.5" aria-hidden />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">{t("configure")}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7 text-destructive hover:text-destructive"
            aria-label={t("delete")}
            onClick={(e) => {
              e.stopPropagation()
              onDelete()
            }}
            data-testid="wf-node-toolbar-delete"
          >
            <DeleteIcon className="size-3.5" aria-hidden />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">{t("delete")}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            ref={moreBtnRef}
            type="button"
            size="icon"
            variant="ghost"
            className="size-7"
            aria-label={t("more")}
            onClick={(e) => {
              e.stopPropagation()
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
              onMore(rect)
            }}
            data-testid="wf-node-toolbar-more"
          >
            <MoreHorizontal className="size-3.5" aria-hidden />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">{t("more")}</TooltipContent>
      </Tooltip>
    </Toolbar>
  )
}
