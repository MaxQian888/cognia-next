"use client"

/**
 * Contextual selection toolbar — a floating top-center glass capsule that
 * appears only when ≥1 node is selected. Surfaces multi-node actions
 * (duplicate · group · align/distribute · fit-to-selection · delete) that were
 * previously keyboard- or context-menu-only.
 *
 * Performance: this is the ONLY component subscribed to `selectedNodeIds`, and
 * it is a sibling of `<ReactFlow>` (not an ancestor). So lasso/click selection
 * churn re-renders just this small capsule, never the canvas. All mutations go
 * through `store.getState()` (stable actions) + the live React Flow instance —
 * no extra store subscriptions, so reading nodes/measured sizes never adds
 * render coupling.
 */

import { memo, useCallback } from "react"
import { useTranslations } from "next-intl"
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  Copy,
  Group,
  Maximize2,
  Trash2,
  Combine,
} from "lucide-react"
import type { ReactFlowInstance } from "@xyflow/react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { applyAutoLayoutPositions } from "@/lib/workflow/editor/auto-layout"
import {
  computeAlign,
  computeDistribute,
  type AlignOp,
  type DistributeAxis,
  type NodeRect,
  type PositionMap,
} from "@/lib/workflow/editor/align-distribute"
import type { EditorState, EditorStore } from "@/lib/workflow/editor/store"
import { ToolbarButton, VSep } from "./canvas-toolbar"

export interface SelectionToolbarProps {
  store: EditorStore
  reactFlowInstance: ReactFlowInstance | null
  /** Drop fit-view transition duration when the perf tier disables motion. */
  motionEnabled: boolean
  /** Extract the current selection into a new sub-workflow (C5). */
  onExtractToSubworkflow?: () => void
}

const ALIGN_ITEMS: ReadonlyArray<{
  op: AlignOp
  icon: typeof AlignStartVertical
  labelKey: string
  testid: string
}> = [
  { op: "left", icon: AlignStartVertical, labelKey: "alignLeft", testid: "wf-sel-align-left" },
  {
    op: "centerH",
    icon: AlignCenterVertical,
    labelKey: "alignCenterH",
    testid: "wf-sel-align-centerH",
  },
  { op: "right", icon: AlignEndVertical, labelKey: "alignRight", testid: "wf-sel-align-right" },
  { op: "top", icon: AlignStartHorizontal, labelKey: "alignTop", testid: "wf-sel-align-top" },
  {
    op: "centerV",
    icon: AlignCenterHorizontal,
    labelKey: "alignCenterV",
    testid: "wf-sel-align-centerV",
  },
  {
    op: "bottom",
    icon: AlignEndHorizontal,
    labelKey: "alignBottom",
    testid: "wf-sel-align-bottom",
  },
]

function AlignPopover({
  disabled,
  canDistribute,
  onAlign,
  onDistribute,
}: {
  disabled: boolean
  canDistribute: boolean
  onAlign: (op: AlignOp) => void
  onDistribute: (axis: DistributeAxis) => void
}) {
  const t = useTranslations("workflows.editor.selectionToolbar")
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
              disabled={disabled}
              aria-label={t("align")}
              data-testid="wf-sel-align"
            >
              <AlignCenterVertical className="size-4" aria-hidden />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t("align")}</TooltipContent>
      </Tooltip>
      <PopoverContent align="center" side="bottom" className="w-auto p-1.5">
        <div className="grid grid-cols-3 gap-0.5">
          {ALIGN_ITEMS.map(({ op, icon: Icon, labelKey, testid }) => (
            <Tooltip key={op}>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  onClick={() => onAlign(op)}
                  aria-label={t(labelKey)}
                  data-testid={testid}
                >
                  <Icon className="size-4" aria-hidden />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t(labelKey)}</TooltipContent>
            </Tooltip>
          ))}
        </div>
        <Separator className="my-1" />
        <div className="grid grid-cols-2 gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8"
                disabled={!canDistribute}
                onClick={() => onDistribute("horizontal")}
                aria-label={t("distributeH")}
                data-testid="wf-sel-distribute-h"
              >
                <AlignHorizontalDistributeCenter className="size-4" aria-hidden />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t("distributeH")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8"
                disabled={!canDistribute}
                onClick={() => onDistribute("vertical")}
                aria-label={t("distributeV")}
                data-testid="wf-sel-distribute-v"
              >
                <AlignVerticalDistributeCenter className="size-4" aria-hidden />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t("distributeV")}</TooltipContent>
          </Tooltip>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export const SelectionToolbar = memo(function SelectionToolbar({
  store,
  reactFlowInstance,
  motionEnabled,
  onExtractToSubworkflow,
}: SelectionToolbarProps) {
  const t = useTranslations("workflows.editor.selectionToolbar")
  const selectedNodeIds = store((s: EditorState) => s.selectedNodeIds)
  const count = selectedNodeIds.length

  const gatherRects = useCallback((): NodeRect[] => {
    const selected = new Set(selectedNodeIds)
    return store
      .getState()
      .nodes.filter((n) => selected.has(n.id))
      .map((n) => {
        const live = reactFlowInstance?.getNode(n.id)
        const width = (live?.measured?.width ?? live?.width ?? 240) as number
        const height = (live?.measured?.height ?? live?.height ?? 80) as number
        return { id: n.id, x: n.position.x, y: n.position.y, width, height }
      })
  }, [store, selectedNodeIds, reactFlowInstance])

  const applyPositions = useCallback(
    (positions: PositionMap) => {
      if (Object.keys(positions).length === 0) return
      const nodes = store.getState().nodes
      store.getState().setNodes(applyAutoLayoutPositions(nodes, positions))
    },
    [store]
  )

  const handleAlign = useCallback(
    (op: AlignOp) => applyPositions(computeAlign(gatherRects(), op)),
    [applyPositions, gatherRects]
  )
  const handleDistribute = useCallback(
    (axis: DistributeAxis) => applyPositions(computeDistribute(gatherRects(), axis)),
    [applyPositions, gatherRects]
  )
  const handleDuplicate = useCallback(() => {
    store.getState().duplicateNodes(selectedNodeIds)
  }, [store, selectedNodeIds])
  const handleGroup = useCallback(() => {
    store.getState().groupSelected(selectedNodeIds)
  }, [store, selectedNodeIds])
  const handleDelete = useCallback(() => {
    store.getState().removeNodes(selectedNodeIds)
  }, [store, selectedNodeIds])
  const handleFit = useCallback(() => {
    const selected = new Set(selectedNodeIds)
    const nodes = store.getState().nodes.filter((n) => selected.has(n.id))
    void reactFlowInstance?.fitView({
      nodes,
      duration: motionEnabled ? 240 : 0,
      padding: 0.3,
    })
  }, [reactFlowInstance, selectedNodeIds, store, motionEnabled])

  if (count === 0) return null
  const canGroup = count >= 2
  const canDistribute = count >= 3

  return (
    <div
      data-testid="wf-selection-toolbar"
      className="absolute top-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-0.5 rounded-full border bg-popover/95 px-2 py-1 shadow-md backdrop-blur"
    >
      <span
        className="px-1 text-xs font-medium tabular-nums text-muted-foreground"
        data-testid="wf-selection-count"
      >
        {t("selected", { count })}
      </span>
      <VSep />
      <ToolbarButton
        icon={Copy}
        label={t("duplicate")}
        onClick={handleDuplicate}
        side="bottom"
        testid="wf-sel-duplicate"
      />
      <ToolbarButton
        icon={Group}
        label={t("group")}
        onClick={handleGroup}
        disabled={!canGroup}
        side="bottom"
        testid="wf-sel-group"
      />
      <AlignPopover
        disabled={!canGroup}
        canDistribute={canDistribute}
        onAlign={handleAlign}
        onDistribute={handleDistribute}
      />
      <ToolbarButton
        icon={Maximize2}
        label={t("fit")}
        onClick={handleFit}
        side="bottom"
        testid="wf-sel-fit"
      />
      {onExtractToSubworkflow ? (
        <ToolbarButton
          icon={Combine}
          label={t("extract")}
          onClick={onExtractToSubworkflow}
          side="bottom"
          testid="wf-sel-extract"
        />
      ) : null}
      <VSep />
      <ToolbarButton
        icon={Trash2}
        label={t("delete")}
        onClick={handleDelete}
        destructive
        side="bottom"
        testid="wf-sel-delete"
      />
    </div>
  )
})
