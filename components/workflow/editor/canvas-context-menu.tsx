"use client"

/**
 * Canvas-mounted right-click menu — three contexts: empty pane, node, edge.
 *
 * React Flow swallows the native `contextmenu` event on its pane, so this is
 * a controlled `<DropdownMenu>` whose content is positioned with
 * `position: fixed` at the click coordinates rather than the standard radix
 * floating-ui anchor. The trigger is invisible (`size: 0`); we drive `open`
 * via React Flow's `onPaneContextMenu` / `onNodeContextMenu` /
 * `onEdgeContextMenu` callbacks at the canvas layer.
 *
 * Every action routes through existing store mutators or canvas-level
 * callbacks passed in — no business logic lives in this file.
 */

import { useEffect, useMemo, useRef } from "react"
import { useTranslations } from "next-intl"
import { useShallow } from "zustand/react/shallow"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { EditorStore, EditorState } from "@/lib/workflow/editor/store"
import { workflowNodeCategory } from "@/types/workflow/visual"
import { validateConnection } from "@/lib/workflow/editor/connection-validator"

export type ContextTarget =
  | { kind: "pane"; flowPos: { x: number; y: number } }
  | { kind: "node"; nodeId: string }
  | { kind: "edge"; edgeId: string }

export interface CanvasContextMenuProps {
  open: boolean
  position: { x: number; y: number } | null
  target: ContextTarget | null
  store: EditorStore
  onClose: () => void
  onAddNodeAtPosition: (flowPos: { x: number; y: number }) => void
  onResetView: () => void
  onConfigureNode: (nodeId: string) => void
  onRunFromNode: (nodeId: string) => void
  onCopyNode: (nodeId: string) => void
  onEditEdgeLabel: (edgeId: string) => void
  onPaste: () => void
}

export function CanvasContextMenu({
  open,
  position,
  target,
  store,
  onClose,
  onAddNodeAtPosition,
  onResetView,
  onConfigureNode,
  onRunFromNode,
  onCopyNode,
  onEditEdgeLabel,
  onPaste,
}: CanvasContextMenuProps) {
  const t = useTranslations("workflows.editor.contextMenu")

  const {
    nodes,
    edges,
    snapToGrid,
    setSnapToGrid,
    duplicateNodes,
    removeNodes,
    updateNodeData,
    addNode,
    groupSelected,
    updateEdgeData,
    replaceEdge,
    removeEdges,
  } = store(
    useShallow((s: EditorState) => ({
      nodes: s.nodes,
      edges: s.edges,
      snapToGrid: s.snapToGrid,
      setSnapToGrid: s.setSnapToGrid,
      duplicateNodes: s.duplicateNodes,
      removeNodes: s.removeNodes,
      updateNodeData: s.updateNodeData,
      addNode: s.addNode,
      groupSelected: s.groupSelected,
      updateEdgeData: s.updateEdgeData,
      replaceEdge: s.replaceEdge,
      removeEdges: s.removeEdges,
    }))
  )

  // Resolve the active node/edge so per-target items can render
  // conditionally without a parent prop drill.
  /* eslint-disable react-hooks/preserve-manual-memoization -- nodes/edges arrays may be mutated by React Flow; manual memo over the find() is intentional and the staleness window is one render tick. */
  const activeNode = useMemo(() => {
    if (target?.kind !== "node") return null
    return nodes.find((n) => n.id === target.nodeId) ?? null
  }, [target, nodes])
  const activeEdge = useMemo(() => {
    if (target?.kind !== "edge") return null
    return edges.find((e) => e.id === target.edgeId) ?? null
  }, [target, edges])
  /* eslint-enable react-hooks/preserve-manual-memoization */

  // Close on outside-click / Escape — radix DropdownMenu handles both via the
  // controlled `open` prop, but we still need to surface that to the parent.
  const closeRef = useRef(onClose)
  useEffect(() => {
    closeRef.current = onClose
  }, [onClose])

  if (!open || !position || !target) return null

  // Helper: run an action then close the menu.
  const fire = (fn: () => void) => () => {
    fn()
    closeRef.current()
  }

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        if (!next) closeRef.current()
      }}
    >
      {/* Invisible anchor at the click location. */}
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-hidden
          tabIndex={-1}
          style={{
            position: "fixed",
            left: position.x,
            top: position.y,
            width: 0,
            height: 0,
            pointerEvents: "none",
            opacity: 0,
          }}
          data-testid="canvas-context-menu-anchor"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={2}
        className="min-w-[180px]"
        data-testid="canvas-context-menu"
      >
        {target.kind === "pane" ? (
          <>
            <DropdownMenuItem onSelect={fire(onPaste)} data-testid="ctx-pane-paste">
              {t("pane.paste")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={fire(() => onAddNodeAtPosition(target.flowPos))}
              data-testid="ctx-pane-add-node"
            >
              {t("pane.addNode")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={fire(() => addNode("annotation.note", target.flowPos))}
              data-testid="ctx-pane-add-sticky"
            >
              {t("pane.addSticky")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={fire(() => addNode("annotation.group", target.flowPos))}
              data-testid="ctx-pane-add-group"
            >
              {t("pane.addGroup")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={fire(onResetView)} data-testid="ctx-pane-reset-view">
              {t("pane.resetView")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={fire(() => setSnapToGrid(!snapToGrid))}
              data-testid="ctx-pane-toggle-snap"
            >
              {t("pane.toggleSnap")}
            </DropdownMenuItem>
          </>
        ) : null}

        {target.kind === "node" && activeNode
          ? (() => {
              const kind = activeNode.data.kind
              const category = workflowNodeCategory(kind)
              const runnable = category !== "trigger" && category !== "annotation"
              const disabled = activeNode.data.disabled === true
              return (
                <>
                  <DropdownMenuItem
                    disabled={!runnable}
                    onSelect={fire(() => onRunFromNode(activeNode.id))}
                    data-testid="ctx-node-run-from"
                  >
                    {t("node.runFrom")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={fire(() => onConfigureNode(activeNode.id))}
                    data-testid="ctx-node-configure"
                  >
                    {t("node.configure")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={fire(() => store.getState().setEditingNodeIdInline(activeNode.id))}
                    data-testid="ctx-node-rename"
                  >
                    {t("node.rename")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={fire(() => duplicateNodes([activeNode.id]))}
                    data-testid="ctx-node-duplicate"
                  >
                    {t("node.duplicate")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={fire(() => onCopyNode(activeNode.id))}
                    data-testid="ctx-node-copy"
                  >
                    {t("node.copy")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={fire(() => groupSelected([activeNode.id]))}
                    data-testid="ctx-node-to-group"
                  >
                    {t("node.toGroup")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={fire(() =>
                      addNode("annotation.note", {
                        x: activeNode.position.x,
                        y: activeNode.position.y - 80,
                      })
                    )}
                    data-testid="ctx-node-add-sticky-above"
                  >
                    {t("node.addStickyAbove")}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={fire(() => updateNodeData(activeNode.id, { disabled: !disabled }))}
                    data-testid="ctx-node-toggle-disabled"
                  >
                    {disabled ? t("node.enable") : t("node.disable")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={fire(() => removeNodes([activeNode.id]))}
                    data-testid="ctx-node-delete"
                  >
                    {t("node.delete")}
                  </DropdownMenuItem>
                </>
              )
            })()
          : null}

        {target.kind === "edge" && activeEdge
          ? (() => {
              const reverseValid = validateConnection(
                {
                  source: activeEdge.target,
                  target: activeEdge.source,
                  sourceHandle: activeEdge.targetHandle ?? null,
                  targetHandle: activeEdge.sourceHandle ?? null,
                },
                nodes,
                edges.filter((e) => e.id !== activeEdge.id)
              ).valid
              return (
                <>
                  <DropdownMenuItem
                    onSelect={fire(() => onEditEdgeLabel(activeEdge.id))}
                    data-testid="ctx-edge-edit-label"
                  >
                    {t("edge.editLabel")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={fire(() => updateEdgeData(activeEdge.id, { kind: "then" }))}
                    data-testid="ctx-edge-to-conditional"
                  >
                    {t("edge.toConditional")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!reverseValid}
                    onSelect={fire(() =>
                      replaceEdge(activeEdge.id, {
                        source: activeEdge.target,
                        target: activeEdge.source,
                        sourceHandle: activeEdge.targetHandle,
                        targetHandle: activeEdge.sourceHandle,
                      })
                    )}
                    data-testid="ctx-edge-reverse"
                  >
                    {t("edge.reverse")}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={fire(() => removeEdges([activeEdge.id]))}
                    data-testid="ctx-edge-delete"
                  >
                    {t("edge.delete")}
                  </DropdownMenuItem>
                </>
              )
            })()
          : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
