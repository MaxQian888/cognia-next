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

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
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
import { LoopContainerNode } from "@/components/workflow/editor/nodes/loop-container-node"
import { GroupContainerNode } from "@/components/workflow/editor/nodes/group-container-node"
import { SmartEdge } from "@/components/workflow/editor/edges/smart-edge"
import { outputHandlesFor } from "@/lib/workflow/editor/node-handles"
import { lock as lockOrientation, unlock as unlockOrientation } from "@/lib/capacitor/screen-orientation"
import { useRunStatusBridge } from "@/lib/workflow/runtime/run-status-bridge"
import { useLastRunSummaryByStep } from "@/lib/workflow/runtime/last-run-summary"
import { useEffectivePerfTier } from "@/hooks/workflow/use-effective-perf-tier"
import type { EditorState, EditorStore } from "@/lib/workflow/editor/store"
import type { RFWorkflowNode, RFWorkflowEdge } from "@/lib/workflow/editor/react-flow-converter"
import { useCanvasLongPress, type CanvasPressTarget } from "./use-canvas-long-press"

/** The React Flow instance specialised to the editor's node/edge shapes. */
export type WorkflowFlowInstance = ReactFlowInstance<RFWorkflowNode, RFWorkflowEdge>

// All three renderers, not just the plain card. `react-flow-converter` assigns
// `loopContainer` / `groupContainer` to `flow.loop@2` and `annotation.group@2`,
// so registering only `workflowNode` meant a graph authored on the desktop
// opened on a phone with its loop bodies and group frames falling through to
// React Flow's default renderer.
const nodeTypes: NodeTypes = {
  workflowNode: WorkflowNodeComponent as unknown as NodeTypes[string],
  loopContainer: LoopContainerNode as unknown as NodeTypes[string],
  groupContainer: GroupContainerNode as unknown as NodeTypes[string],
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
  /** Tapped an edge (edit mode) — select it so the delete bar can act on it. */
  onEdgeTap: (id: string) => void
  /** Tapped empty canvas — clear selection / cancel a pending connection. */
  onPaneTap: () => void
  /** Held on a node, an edge or empty space — open the action sheet. */
  onLongPress: (target: CanvasPressTarget) => void
  /** Keep the shell in landscape. The editor's default, and escapable. */
  orientationLocked: boolean
  onInit: (rf: WorkflowFlowInstance) => void
}

export function MobileCanvas({
  store,
  mode,
  connectActive,
  onNodeTap,
  onEdgeTap,
  onPaneTap,
  onLongPress,
  orientationLocked,
  onInit,
}: MobileCanvasProps) {
  const t = useTranslations("mobile.workflow.editor")
  const tNode = useTranslations("workflows.node")
  const useStore = store

  const { nodes, edges, viewport, snapToGrid } = useStore(
    useShallow((s: EditorState) => ({
      nodes: s.nodes,
      edges: s.edges,
      viewport: s.viewport,
      snapToGrid: s.snapToGrid,
    }))
  )
  const connectionState = useStore((s) => s.connectionState)
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
  // portrait column, so landscape is the default while the editor canvas is
  // mounted. It is a default, not a rule: the lock used to be unconditional,
  // which meant a user holding their phone in portrait had the OS rotate the
  // app out from under them with no way to say no. `orientationLocked` is the
  // opt-out, and either way the user's own orientation is restored on exit.
  // No-ops on web / Tauri (the wrapper resolves `unsupported`), so this only
  // takes effect on the Capacitor shell.
  useEffect(() => {
    if (orientationLocked) void lockOrientation("landscape")
    else void unlockOrientation()
  }, [orientationLocked])
  useEffect(
    () => () => {
      void unlockOrientation()
    },
    []
  )

  const editable = mode === "edit"

  // The desktop reaches its context menu through `contextmenu`, which touch
  // fires inconsistently. Everything destructive on a phone is a long press.
  const longPress = useCanvasLongPress({
    onLongPress,
    // Read mode has nothing destructive to offer, and a stray hold while
    // reading a graph should not pop a sheet.
    enabled: editable && !connectActive,
  })

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
  const handleEdgeClick = useCallback(
    (_e: React.MouseEvent, edge: { id: string }) => onEdgeTap(edge.id),
    [onEdgeTap]
  )
  const handlePaneClick = useCallback(() => onPaneTap(), [onPaneTap])

  // Connect banner copy. When the connection is rooted at a labeled output
  // (branch true/false/case, error path) name it so the user knows which path
  // they're wiring; otherwise the generic "tap a node" prompt.
  const connectBannerText = useMemo(() => {
    const handle = connectionState?.sourceHandle
    if (!connectionState || !handle) return t("connectTarget")
    if (handle === "error") return t("connectFrom", { label: t("errorOutput") })
    const src = nodes.find((n) => n.id === connectionState.sourceId)
    const handles = src
      ? outputHandlesFor({
          kind: src.data.kind,
          typeVersion: src.data.typeVersion,
          params: (src.data.params as Record<string, unknown>) ?? {},
        })
      : null
    const h = handles?.find((x) => x.id === handle)
    if (!h) return t("connectTarget")
    const label = h.kind === "case" ? (h.label ?? h.id) : tNode(`outputHandles.${h.kind}`)
    return t("connectFrom", { label })
  }, [connectionState, nodes, t, tNode])

  return (
    <div
      className="wf-touch-canvas relative h-full w-full overflow-hidden bg-muted/30"
      data-testid="mobile-canvas"
      {...longPress}
    >
      {connectActive ? (
        <div
          className="pointer-events-none absolute inset-x-0 top-2 z-20 mx-auto w-fit rounded-pill bg-primary px-3 py-1 text-xs font-medium text-primary-foreground shadow-md"
          data-testid="mobile-connect-banner"
        >
          {connectBannerText}
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
        onEdgeClick={handleEdgeClick}
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
