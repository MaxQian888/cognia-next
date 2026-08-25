"use client"

/**
 * Flowith-style floating canvas toolbar — a bottom-center glass capsule that
 * replaces React Flow's native `<Controls>` and consolidates every canvas/view
 * operation: add-node, undo/redo, zoom (out / live % / in / fit / reset),
 * interactivity lock, auto-layout, and a "View" popover (snap grid, minimap,
 * background, performance tier, saved views).
 *
 * Mounted as an absolute sibling of `<ReactFlow>` inside the canvas wrapper, so
 * it is NOT an ancestor of the node tree — a re-render here never touches the
 * canvas. Wrapped in `React.memo` so the per-frame `setNodes` the editor fires
 * during a node drag doesn't re-render the capsule. The live zoom % lives in
 * its own `ZoomReadout` child so a per-frame viewport change repaints only that
 * span.
 */

import { memo, useState } from "react"
import { useReactFlow, useOnViewportChange, type Viewport } from "@xyflow/react"
import { useTranslations } from "next-intl"
import {
  LayoutGrid,
  Lock,
  LockOpen,
  Maximize2,
  Plus,
  Redo2,
  Search,
  SlidersHorizontal,
  StickyNote,
  Undo2,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { Controls } from "@/components/ai-elements/controls"
import type {
  PerformanceTier,
  ResolvedPerformanceTier,
} from "@/lib/workflow/editor/performance-tier"
import { PerformanceTierFields } from "./performance-tier-popover"
import { ViewportBookmarksContent } from "./viewport-bookmarks"

export type CanvasBackgroundVariant = "dots" | "lines" | "none"

export interface CanvasToolbarProps {
  onAddNode: () => void
  onOpenSearch: () => void
  onAddSticky: () => void
  onAddGroup: () => void
  onUndo: () => void
  onRedo: () => void
  canUndo: boolean
  canRedo: boolean
  onAutoLayout: () => void
  /** Interactivity lock — true = editable (nodes draggable/selectable). */
  interactive: boolean
  onToggleInteractive: () => void
  snapToGrid: boolean
  onToggleSnap: (next: boolean) => void
  minimapVisible: boolean
  /** False when the active performance tier hides the minimap (toggle disabled). */
  minimapAvailable: boolean
  onToggleMinimap: (next: boolean) => void
  backgroundVariant: CanvasBackgroundVariant
  onBackgroundChange: (variant: CanvasBackgroundVariant) => void
  /** Drop zoom/fit transition durations when the perf tier disables motion. */
  motionEnabled: boolean
  performanceTier: PerformanceTier
  effectivePerformanceTier: ResolvedPerformanceTier
  onPerformanceTierChange: (tier: PerformanceTier) => void
  workflowId: string
  currentViewport: Viewport
  onRestoreViewport: (viewport: Viewport) => void
}

export function ToolbarButton({
  icon: Icon,
  label,
  onClick,
  disabled,
  pressed,
  destructive,
  side = "top",
  testid,
}: {
  icon: LucideIcon
  label: string
  onClick: () => void
  disabled?: boolean
  pressed?: boolean
  destructive?: boolean
  side?: "top" | "bottom"
  testid: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(
            "size-8",
            pressed && "bg-accent text-accent-foreground",
            destructive && "text-destructive hover:text-destructive"
          )}
          onClick={onClick}
          disabled={disabled}
          aria-label={label}
          aria-pressed={pressed}
          data-testid={testid}
        >
          <Icon className="size-4" aria-hidden />
        </Button>
      </TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  )
}

/**
 * Live zoom percentage. Isolated so the per-frame `useOnViewportChange` update
 * re-renders only this span, never the surrounding button row. Click resets to
 * 100%.
 */
function ZoomReadout({ resetLabel, duration }: { resetLabel: string; duration: number }) {
  const { getViewport, zoomTo } = useReactFlow()
  const [pct, setPct] = useState(() => Math.round((getViewport().zoom ?? 1) * 100))
  useOnViewportChange({ onChange: (v) => setPct(Math.round(v.zoom * 100)) })

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => void zoomTo(1, { duration })}
          aria-label={resetLabel}
          className="min-w-[3.25rem] rounded-sm px-1 py-1 text-center text-xs font-medium tabular-nums text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          data-testid="wf-zoom-reset"
        >
          {pct}%
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{resetLabel}</TooltipContent>
    </Tooltip>
  )
}

function ViewOptionsPopover(
  props: Pick<
    CanvasToolbarProps,
    | "snapToGrid"
    | "onToggleSnap"
    | "minimapVisible"
    | "minimapAvailable"
    | "onToggleMinimap"
    | "backgroundVariant"
    | "onBackgroundChange"
    | "performanceTier"
    | "effectivePerformanceTier"
    | "onPerformanceTierChange"
    | "workflowId"
    | "currentViewport"
    | "onRestoreViewport"
  >
) {
  const t = useTranslations("workflows.editor.canvasToolbar")

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8"
              aria-label={t("view")}
              data-testid="wf-view-options"
            >
              <SlidersHorizontal className="size-4" aria-hidden />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">{t("view")}</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" side="top" className="w-64 space-y-3">
        <label className="flex items-center justify-between gap-2">
          <span className="text-sm">{t("snapToGrid")}</span>
          <Switch
            checked={props.snapToGrid}
            onCheckedChange={props.onToggleSnap}
            aria-label={t("snapToGrid")}
            data-testid="wf-snap-toggle"
          />
        </label>
        <div className="space-y-1">
          <label className="flex items-center justify-between gap-2">
            <span className={cn("text-sm", !props.minimapAvailable && "text-muted-foreground")}>
              {t("showMinimap")}
            </span>
            <Switch
              checked={props.minimapVisible && props.minimapAvailable}
              disabled={!props.minimapAvailable}
              onCheckedChange={props.onToggleMinimap}
              aria-label={t("showMinimap")}
              data-testid="wf-minimap-toggle"
            />
          </label>
          {!props.minimapAvailable ? (
            <p className="text-xs text-muted-foreground">{t("minimapTierHint")}</p>
          ) : null}
        </div>
        <div className="space-y-1.5">
          <span className="text-sm">{t("background")}</span>
          <ToggleGroup
            type="single"
            value={props.backgroundVariant}
            onValueChange={(v) => {
              if (v) props.onBackgroundChange(v as CanvasBackgroundVariant)
            }}
            variant="outline"
            className="w-full"
            aria-label={t("background")}
          >
            <ToggleGroupItem value="dots" className="flex-1" data-testid="wf-bg-dots">
              {t("bgDots")}
            </ToggleGroupItem>
            <ToggleGroupItem value="lines" className="flex-1" data-testid="wf-bg-lines">
              {t("bgLines")}
            </ToggleGroupItem>
            <ToggleGroupItem value="none" className="flex-1" data-testid="wf-bg-none">
              {t("bgNone")}
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
        <Separator />
        <PerformanceTierFields
          value={props.performanceTier}
          effective={props.effectivePerformanceTier}
          onChange={props.onPerformanceTierChange}
        />
        <Separator />
        <ViewportBookmarksContent
          workflowId={props.workflowId}
          currentViewport={props.currentViewport}
          onRestore={props.onRestoreViewport}
        />
      </PopoverContent>
    </Popover>
  )
}

export function VSep() {
  return <Separator orientation="vertical" className="mx-0.5 h-5" />
}

export const CanvasToolbar = memo(function CanvasToolbar(props: CanvasToolbarProps) {
  const t = useTranslations("workflows.editor.canvasToolbar")
  const { zoomIn, zoomOut, fitView } = useReactFlow()
  const duration = props.motionEnabled ? 200 : 0

  return (
    <Controls
      showZoom={false}
      showFitView={false}
      showInteractive={false}
      data-testid="wf-canvas-toolbar"
      className="absolute! right-auto! bottom-4! left-1/2! top-auto! z-10 flex -translate-x-1/2 items-center gap-0.5 rounded-pill border bg-popover/95 px-1.5 py-1 shadow-md backdrop-blur"
    >
      <ToolbarButton
        icon={Plus}
        label={t("addNode")}
        onClick={props.onAddNode}
        testid="wf-add-node"
      />
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8"
                aria-label={t("annotation")}
                data-testid="wf-annotation"
              >
                <StickyNote className="size-4" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="top">{t("annotation")}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="center" side="top" className="w-44">
          <DropdownMenuItem onSelect={props.onAddSticky} data-testid="wf-add-sticky">
            {t("addSticky")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={props.onAddGroup} data-testid="wf-add-group">
            {t("addGroup")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ToolbarButton
        icon={Search}
        label={t("search")}
        onClick={props.onOpenSearch}
        testid="wf-search"
      />
      <VSep />
      <ToolbarButton
        icon={Undo2}
        label={t("undo")}
        onClick={props.onUndo}
        disabled={!props.canUndo}
        testid="workflow-undo"
      />
      <ToolbarButton
        icon={Redo2}
        label={t("redo")}
        onClick={props.onRedo}
        disabled={!props.canRedo}
        testid="workflow-redo"
      />
      <VSep />
      <ToolbarButton
        icon={ZoomOut}
        label={t("zoomOut")}
        onClick={() => void zoomOut({ duration })}
        testid="wf-zoom-out"
      />
      <ZoomReadout resetLabel={t("zoomReset")} duration={duration} />
      <ToolbarButton
        icon={ZoomIn}
        label={t("zoomIn")}
        onClick={() => void zoomIn({ duration })}
        testid="wf-zoom-in"
      />
      <ToolbarButton
        icon={Maximize2}
        label={t("fitView")}
        onClick={() => void fitView({ duration, padding: 0.2 })}
        testid="wf-fit-view"
      />
      <ToolbarButton
        icon={props.interactive ? LockOpen : Lock}
        label={props.interactive ? t("lock") : t("unlock")}
        onClick={props.onToggleInteractive}
        pressed={!props.interactive}
        testid="wf-lock"
      />
      <VSep />
      <ToolbarButton
        icon={LayoutGrid}
        label={t("autoLayout")}
        onClick={props.onAutoLayout}
        testid="workflow-auto-layout"
      />
      <VSep />
      <ViewOptionsPopover {...props} />
    </Controls>
  )
})
