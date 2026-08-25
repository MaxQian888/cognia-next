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

import { memo, useCallback, useState } from "react"
import { useShallow } from "zustand/react/shallow"
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
  Lock,
  LockOpen,
  Maximize2,
  MousePointerSquareDashed,
  Play,
  Power,
  Trash2,
  Combine,
  PackagePlus,
} from "lucide-react"
import type { ReactFlowInstance } from "@xyflow/react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { applyAutoLayoutPositions } from "@/lib/workflow/editor/auto-layout"
import { groupChildIds, groupEntryChildIds } from "@/lib/workflow/editor/group-utils"
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
import { NodeGroupCreateDialog } from "./node-group-create-dialog"

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
  const [nodeGroupDialogOpen, setNodeGroupDialogOpen] = useState(false)

  // Stable-primitive selector: re-renders only when the lock state / group
  // status actually flips, not on every drag frame that mutates `nodes`.
  // One `useShallow` subscription with a single early-exit pass over the
  // node list (instead of two selectors doing filter + find each frame) —
  // drag frames still invoke the selector, but the scan stops as soon as
  // every selected node has been seen.
  const { allLocked, singleGroupId } = store(
    useShallow((s: EditorState) => {
      const sel = s.selectedNodeIds
      if (sel.length === 0) return { allLocked: false, singleGroupId: null as string | null }
      const wanted = new Set(sel)
      let seen = 0
      let locked = 0
      let groupId: string | null = null
      for (const n of s.nodes) {
        if (!wanted.has(n.id)) continue
        seen++
        if (n.data.locked) locked++
        if (sel.length === 1 && n.data.kind === "annotation.group") groupId = n.id
        if (seen === wanted.size) break
      }
      return { allLocked: seen > 0 && locked === seen, singleGroupId: groupId }
    })
  )

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
  const handleToggleLock = useCallback(() => {
    store.getState().updateNodeDataBatch(selectedNodeIds, { locked: !allLocked })
  }, [store, selectedNodeIds, allLocked])
  const handleSelectChildren = useCallback(() => {
    if (!singleGroupId) return
    const childIds = groupChildIds(store.getState().nodes, singleGroupId)
    if (childIds.length > 0) store.getState().setSelectedNodes(childIds)
  }, [store, singleGroupId])
  const handleToggleGroupDisabled = useCallback(() => {
    if (!singleGroupId) return
    const nodes = store.getState().nodes
    const childIds = groupChildIds(nodes, singleGroupId)
    if (childIds.length === 0) return
    const childSet = new Set(childIds)
    const allDisabled = nodes
      .filter((n) => childSet.has(n.id))
      .every((n) => Boolean(n.data.disabled))
    store.getState().updateNodeDataBatch(childIds, { disabled: !allDisabled })
  }, [store, singleGroupId])
  const handleRunBlock = useCallback(() => {
    if (!singleGroupId) return
    const s = store.getState()
    const entries = groupEntryChildIds(s.nodes, s.edges, singleGroupId)
    if (entries.length > 0) s.requestRunFromStep(entries[0])
  }, [store, singleGroupId])
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
      className="absolute top-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-0.5 rounded-pill border bg-popover/95 px-2 py-1 shadow-md backdrop-blur"
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
      <ToolbarButton
        icon={PackagePlus}
        label={t("createNodeGroup")}
        onClick={() => setNodeGroupDialogOpen(true)}
        side="bottom"
        testid="wf-sel-create-node-group"
      />
      <AlignPopover
        disabled={!canGroup}
        canDistribute={canDistribute}
        onAlign={handleAlign}
        onDistribute={handleDistribute}
      />
      <ToolbarButton
        icon={allLocked ? LockOpen : Lock}
        label={allLocked ? t("unlock") : t("lock")}
        onClick={handleToggleLock}
        side="bottom"
        testid="wf-sel-lock"
      />
      <ToolbarButton
        icon={Maximize2}
        label={t("fit")}
        onClick={handleFit}
        side="bottom"
        testid="wf-sel-fit"
      />
      {singleGroupId ? (
        <>
          <VSep />
          <ToolbarButton
            icon={MousePointerSquareDashed}
            label={t("selectChildren")}
            onClick={handleSelectChildren}
            side="bottom"
            testid="wf-sel-group-children"
          />
          <ToolbarButton
            icon={Power}
            label={t("toggleGroupDisabled")}
            onClick={handleToggleGroupDisabled}
            side="bottom"
            testid="wf-sel-group-disable"
          />
          <ToolbarButton
            icon={Play}
            label={t("runBlock")}
            onClick={handleRunBlock}
            side="bottom"
            testid="wf-sel-group-run"
          />
        </>
      ) : null}
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
      <NodeGroupCreateDialog
        open={nodeGroupDialogOpen}
        onOpenChange={setNodeGroupDialogOpen}
        store={store}
        selectedNodeIds={selectedNodeIds}
      />
    </div>
  )
})
