"use client"

/**
 * Mobile-tuned React Flow surface for the workflow editor. It reuses the
 * desktop node/edge renderers, the run-status bridges, and the perf-tier
 * culling, but swaps the desktop interaction model (scroll-pan, marquee
 * select, drag-to-connect) for a touch-first one:
 *
 *   • Read mode  — one-finger pan, pinch-zoom, tap a node to inspect. Nodes
 *     can't be dragged or selected for structural edits.
 *   • Edit mode  — one-finger drag on a node moves it (drag on empty pane
 *     still pans), pinch-zoom. Connections are made via tap-to-connect, not
 *     handle drags, so `nodesConnectable` stays off.
 *
 * Node config / structure mutations all flow through the shared editor store.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  applyEdgeChanges,
  applyNodeChanges,
  type EdgeChange,
  type EdgeTypes,
  type NodeChange,
  type NodeTypes,
  type ReactFlowInstance,
  type Viewport,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import { useShallow } from "zustand/react/shallow"
import { useTranslations } from "next-intl"

import { WorkflowNodeComponent } from "@/components/workflow/editor/nodes/workflow-node"
import { SmartEdge } from "@/components/workflow/editor/edges/smart-edge"
import { lock as lockOrientation, unlock as unlockOrientation } from "@/lib/capacitor/screen-orientation"
import { useRunStatusBridge } from "@/lib/workflow/runtime/run-status-bridge"
import { useLastRunSummaryByStep } from "@/lib/workflow/runtime/last-run-summary"
import { useEffectivePerfTier } from "@/hooks/workflow/use-effective-perf-tier"
import type { EditorState, EditorStore } from "@/lib/workflow/editor/store"
import type { RFWorkflowNode, RFWorkflowEdge } from "@/lib/workflow/editor/react-flow-converter"

/** The React Flow instance specialised to the editor's node/edge shapes. */
export type WorkflowFlowInstance = ReactFlowInstance<RFWorkflowNode, RFWorkflowEdge>

const nodeTypes: NodeTypes = {
  workflowNode: WorkflowNodeComponent as unknown as NodeTypes[string],
}
const edgeTypes: EdgeTypes = {
  default: SmartEdge as unknown as EdgeTypes[string],
  smart: SmartEdge as unknown as EdgeTypes[string],
}

const SNAP_GRID: [number, number] = [16, 16]
const PRO_OPTIONS = { hideAttribution: true } as const

export interface MobileCanvasProps {
  store: EditorStore
  mode: "read" | "edit"
  /** True while waiting for the user to tap a connection target. */
  connectActive: boolean
  /** Tapped a node — inspect it, or complete a pending connection. */
  onNodeTap: (id: string) => void
  /** Tapped empty canvas — clear selection / cancel a pending connection. */
  onPaneTap: () => void
  onInit: (rf: WorkflowFlowInstance) => void
}

export function MobileCanvas({
  store,
  mode,
  connectActive,
  onNodeTap,
  onPaneTap,
  onInit,
}: MobileCanvasProps) {
  const t = useTranslations("mobile.workflow.editor")
  const useStore = store

  const { nodes, edges, viewport, snapToGrid } = useStore(
    useShallow((s: EditorState) => ({
      nodes: s.nodes,
      edges: s.edges,
      viewport: s.viewport,
      snapToGrid: s.snapToGrid,
    }))
  )
  const setNodes = useStore((s) => s.setNodes)
  const setEdges = useStore((s) => s.setEdges)
  const setViewport = useStore((s) => s.setViewport)
  const setIsDraggingAny = useStore((s) => s.setIsDraggingAny)
  const setLastRunByStepId = useStore((s) => s.setLastRunByStepId)
  const workflowId = useStore((s) => s.baseWorkflow.id)

  const perfTier = useEffectivePerfTier(useStore)

  // Live run status (Dexie-backed; no Tauri) — decorates nodes with the same
  // ring/last-run badges as the desktop canvas when run events sync down.
  useRunStatusBridge(workflowId, useStore)
  const lastRunByStepId = useLastRunSummaryByStep(workflowId)
  useEffect(() => {
    setLastRunByStepId(lastRunByStepId)
  }, [lastRunByStepId, setLastRunByStepId])

  // The 2D node canvas reads far better on the wide axis than in a 360-px
  // portrait column, so lock landscape while the editor canvas is mounted and
  // restore the user's orientation on exit. No-ops on web / Tauri (the wrapper
  // resolves `unsupported`), so this only takes effect on the Capacitor shell.
  useEffect(() => {
    void lockOrientation("landscape")
    return () => {
      void unlockOrientation()
    }
  }, [])

  const editable = mode === "edit"

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setNodes(applyNodeChanges(changes, nodes) as typeof nodes)
    },
    [nodes, setNodes]
  )
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      setEdges(applyEdgeChanges(changes, edges) as typeof edges)
    },
    [edges, setEdges]
  )

  const onMoveEnd = useCallback(
    (_e: unknown, v: Viewport) => setViewport(v),
    [setViewport]
  )

  // ── Uncontrolled camera (mirrors the desktop FlowCanvas) ─────────────────
  // Passing the store viewport as the controlled `viewport` prop without an
  // `onViewportChange` round-trip freezes the camera during pan/pinch — the
  // canvas stops following the finger and only jumps at gesture end. Keep the
  // camera uncontrolled (d3-internal, zero React work per frame), seed it from
  // the mount-time store value, and push only wholesale store replaces
  // (workflow switch / import) imperatively. Gesture-end `onMoveEnd` echoes
  // are value-equal, so the guard skips them.
  const [initialViewport] = useState(viewport)
  const rfRef = useRef<WorkflowFlowInstance | null>(null)
  const handleInit = useCallback(
    (rf: WorkflowFlowInstance) => {
      rfRef.current = rf
      onInit(rf)
    },
    [onInit]
  )
  useEffect(() => {
    const rf = rfRef.current
    if (!rf) return
    const cur = rf.getViewport()
    if (cur.x === viewport.x && cur.y === viewport.y && cur.zoom === viewport.zoom) return
    rf.setViewport(viewport)
  }, [viewport])

  // Coalesce a drag into a single undo entry (mirrors the desktop canvas).
  const onNodeDragStart = useCallback(() => {
    useStore.getState().beginDragHistory()
    setIsDraggingAny(true)
  }, [useStore, setIsDraggingAny])
  const onNodeDragStop = useCallback(() => {
    useStore.getState().commitDragHistory()
    setIsDraggingAny(false)
  }, [useStore, setIsDraggingAny])

  const handleNodeClick = useCallback(
    (_e: React.MouseEvent, node: { id: string }) => onNodeTap(node.id),
    [onNodeTap]
  )
  const handlePaneClick = useCallback(() => onPaneTap(), [onPaneTap])

  return (
    <div className="relative h-full w-full overflow-hidden bg-muted/30" data-testid="mobile-canvas">
      {connectActive ? (
        <div
          className="pointer-events-none absolute inset-x-0 top-2 z-20 mx-auto w-fit rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground shadow-md"
          data-testid="mobile-connect-banner"
        >
          {t("connectTarget")}
        </div>
      ) : null}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        defaultViewport={initialViewport}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onMoveEnd={onMoveEnd}
        onNodeDragStart={onNodeDragStart}
        onNodeDragStop={onNodeDragStop}
        onNodeClick={handleNodeClick}
        onPaneClick={handlePaneClick}
        onInit={handleInit}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        minZoom={0.2}
        maxZoom={2}
        snapToGrid={snapToGrid}
        snapGrid={SNAP_GRID}
        proOptions={PRO_OPTIONS}
        // Touch-first interaction: one-finger pan, pinch zoom, no marquee
        // select, no double-tap zoom (too easy to trigger accidentally).
        panOnDrag
        zoomOnPinch
        panOnScroll={false}
        selectionOnDrag={false}
        zoomOnDoubleClick={false}
        // A slightly higher threshold so a tap doesn't register as a micro-drag.
        nodeDragThreshold={6}
        // Read mode is non-destructive; edit mode allows moving nodes. Handle
        // connections never use drag (tap-to-connect), so connectable stays off.
        nodesDraggable={editable}
        nodesConnectable={false}
        elementsSelectable={editable}
        onlyRenderVisibleElements={
          nodes.length >= perfTier.flags.cullingThreshold || perfTier.effective !== "high"
        }
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
      </ReactFlow>
    </div>
  )
}
