"use client"

/**
 * Thin per-frame canvas surface for the workflow editor.
 *
 * WHY THIS EXISTS — the editor's chrome (`CanvasInner`) is a large component
 * (toolbars, both sidebars, dialogs). React Flow is a *controlled* flow whose
 * `nodes`/`edges` live in the Zustand store, so every node-drag frame replaces
 * the `nodes` array reference. If the component that subscribes to `nodes` also
 * renders the chrome, the entire chrome subtree re-runs ~60×/s during a drag —
 * the documented React Flow perf anti-pattern, and the reason "a few nodes"
 * already felt janky.
 *
 * `FlowCanvas` is the ONLY component that subscribes to the per-frame data
 * (`nodes` / `edges` / `viewport` / `isDraggingAny`). `CanvasInner` no longer
 * does, so its body (and the memoized chrome) stops re-rendering during a drag.
 * The toolbars/empty-state are passed in as `overlays` — React preserves those
 * element identities across `FlowCanvas` re-renders, so they are NOT re-rendered
 * by the per-frame churn either.
 *
 * All React Flow change/drag handlers read the graph through
 * `store.getState()` rather than a subscribed closure, so their identities stay
 * stable (deps `[store]`) and React Flow does not re-attach listeners each
 * frame.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
  type RefObject,
} from "react"
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  applyEdgeChanges,
  applyNodeChanges,
  addEdge,
  useReactFlow,
  type Connection,
  type ConnectionLineComponentProps,
  type EdgeChange,
  type EdgeTypes,
  type NodeChange,
  type NodeTypes,
  type OnConnectEnd,
  type OnConnectStart,
} from "@xyflow/react"
import { useShallow } from "zustand/react/shallow"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import type { EditorStore, EditorState } from "@/lib/workflow/editor/store"
import { validateConnection } from "@/lib/workflow/editor/connection-validator"
import {
  computeAlignmentGuides,
  type GuidesResult,
  type RectLike,
} from "@/lib/workflow/editor/alignment-guides"
import { useDragSnapshot } from "@/hooks/workflow/use-drag-snapshot"
import { useRafThrottle } from "@/hooks/workflow/use-raf-throttle"
import type { EffectivePerfTier } from "@/hooks/workflow/use-effective-perf-tier"
import type { WorkflowNodeKind } from "@/types/workflow/visual"
import { PerfMiniMap } from "./minimap-perf"
import { ViewportBreadcrumb } from "./viewport-breadcrumb"
import { LassoOverlay } from "./lasso-overlay"
import { AlignmentOverlay } from "./alignment-overlay"
import { ConnectionPointerListener } from "./connection-overlay"
import { PerfBoundary } from "@/lib/perf"
import type { CanvasBackgroundVariant } from "./canvas-toolbar"
import { WorkflowNodeComponent } from "./nodes/workflow-node"
import { LoopContainerNode } from "./nodes/loop-container-node"
import { pickContainerTarget } from "@/lib/workflow/editor/node-handles"
import { SmartEdge } from "./edges/smart-edge"

const nodeTypes: NodeTypes = {
  workflowNode: WorkflowNodeComponent as unknown as NodeTypes[string],
  loopContainer: LoopContainerNode as unknown as NodeTypes[string],
}

const edgeTypes: EdgeTypes = {
  default: SmartEdge as unknown as EdgeTypes[string],
  smart: SmartEdge as unknown as EdgeTypes[string],
}

// Lifted to module scope so React Flow doesn't see a fresh array/object
// identity on every render and re-initialize internal state. (A2)
const SNAP_GRID: [number, number] = [16, 16]
const DELETE_KEY_CODE: string[] = ["Backspace", "Delete"]
const MULTI_SELECTION_KEY_CODE: string[] = ["Shift", "Meta", "Control"]
const FIT_VIEW_PROPS = false
const PRO_OPTIONS = { hideAttribution: true } as const

export interface FlowCanvasProps {
  store: EditorStore
  perfTier: EffectivePerfTier
  reactFlowInstance: import("@xyflow/react").ReactFlowInstance | null
  setReactFlowInstance: (instance: import("@xyflow/react").ReactFlowInstance) => void
  canvasWrapperRef: RefObject<HTMLDivElement | null>
  interactive: boolean
  minimapVisible: boolean
  backgroundVariant: CanvasBackgroundVariant
  minimapNodeColor: (n: { data?: { kind?: WorkflowNodeKind } }) => string
  connectionLineGhost: ComponentType<ConnectionLineComponentProps>
  onDrop: (event: React.DragEvent) => void
  onDragOver: (event: React.DragEvent) => void
  onPaneContextMenu: (event: React.MouseEvent | MouseEvent) => void
  onNodeContextMenu: (event: React.MouseEvent, node: { id: string }) => void
  onEdgeContextMenu: (event: React.MouseEvent, edge: { id: string }) => void
  /**
   * Toolbars + empty-state, created by `CanvasInner`. Rendered inside the
   * canvas wrapper (so they stay positioned over the flow) but their element
   * identity is owned by the parent, so the per-frame re-render of this
   * component does NOT re-render them.
   */
  overlays?: ReactNode
}

export function FlowCanvas({
  store,
  perfTier,
  reactFlowInstance,
  setReactFlowInstance,
  canvasWrapperRef,
  interactive,
  minimapVisible,
  backgroundVariant,
  minimapNodeColor,
  connectionLineGhost,
  onDrop,
  onDragOver,
  onPaneContextMenu,
  onNodeContextMenu,
  onEdgeContextMenu,
  overlays,
}: FlowCanvasProps) {
  const useStore = store
  const rf = useReactFlow()
  const tConnection = useTranslations("workflows.editor.connection")

  // The ONLY per-frame subscription in the editor. `setNodes` replaces these
  // references on every drag tick; isolating the subscription here keeps the
  // churn out of `CanvasInner` and the chrome. (`viewport` only changes once
  // per pan/zoom gesture — see the uncontrolled-camera note below.)
  const { nodes, edges, viewport, isDraggingAny, snapToGrid } = useStore(
    useShallow((s: EditorState) => ({
      nodes: s.nodes,
      edges: s.edges,
      viewport: s.viewport,
      isDraggingAny: s.isDraggingAny,
      snapToGrid: s.snapToGrid,
    }))
  )

  // ── Uncontrolled camera ───────────────────────────────────────────────────
  // The viewport is deliberately NOT passed as React Flow's controlled
  // `viewport` prop: in controlled mode the library stops writing pan/zoom
  // transforms to its internal store and instead requires an
  // `onViewportChange` round-trip through React on EVERY gesture frame —
  // without it the canvas simply does not move until `onMoveEnd` (the
  // "canvas doesn't follow the drag" bug), and with it the whole subtree
  // re-renders per frame. Uncontrolled, d3 drives the camera with zero React
  // work; the store keeps the persisted value via `onMoveEnd` below.
  //
  // The mount-time store value seeds the camera; *wholesale* replaces
  // (switching workflows re-creates the store, JSON import rewrites it via
  // `loadWorkflow`) are pushed imperatively by the effect. Gesture-end echoes
  // from `onMoveEnd` are value-equal to the live camera, so the guard skips
  // them and no feedback loop forms.
  const [initialViewport] = useState(viewport)
  useEffect(() => {
    const cur = rf.getViewport()
    if (cur.x === viewport.x && cur.y === viewport.y && cur.zoom === viewport.zoom) return
    rf.setViewport(viewport)
  }, [rf, viewport])

  // Alignment guides — populated by `onNodeDrag` while a node is moving,
  // cleared on drag stop so the overlay doesn't linger.
  const [alignmentGuides, setAlignmentGuides] = useState<GuidesResult | null>(null)
  // Track whether the user is actively panning/zooming the viewport so the
  // minimap can drop to its flat-colour degrade path (same as node-drag).
  const [isMovingViewport, setIsMovingViewport] = useState(false)

  // ── React Flow change handlers ────────────────────────────────────────────
  // Read the graph via `getState()` so the handler identities stay stable
  // (deps `[useStore]`) instead of being recreated every drag frame.
  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const s = useStore.getState()
      s.setNodes(applyNodeChanges(changes, s.nodes) as typeof s.nodes)
      const selected = changes
        .filter((c): c is Extract<NodeChange, { type: "select" }> => c.type === "select")
        .filter((c) => c.selected)
        .map((c) => c.id)
      if (selected.length > 0) s.setSelectedNodes(selected)
    },
    [useStore]
  )

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const s = useStore.getState()
      s.setEdges(applyEdgeChanges(changes, s.edges) as typeof s.edges)
      const selected = changes
        .filter((c): c is Extract<EdgeChange, { type: "select" }> => c.type === "select")
        .filter((c) => c.selected)
        .map((c) => c.id)
      if (selected.length > 0) s.setSelectedEdges(selected)
    },
    [useStore]
  )

  const onConnect = useCallback(
    (connection: Connection) => {
      const s = useStore.getState()
      const result = validateConnection(connection, s.nodes, s.edges)
      if (!result.valid) {
        toast.error(tConnection(result.reasonKey))
        return
      }
      s.setEdges(
        addEdge(
          {
            ...connection,
            id: "e_" + Math.random().toString(36).slice(2, 10),
            type: "default",
          },
          s.edges
        ) as typeof s.edges
      )
    },
    [useStore, tConnection]
  )

  const isValidConnection = useCallback(
    (connection: Connection | { source: string | null; target: string | null }) => {
      const s = useStore.getState()
      return validateConnection(connection, s.nodes, s.edges).valid
    },
    [useStore]
  )

  // Stabilized connect handlers — React Flow re-attaches its prop listeners
  // when the callback identity changes. (A2)
  const handleConnectStart = useCallback<OnConnectStart>(
    (_e, params) => {
      if (!params.nodeId) return
      useStore.getState().beginConnection({
        sourceId: params.nodeId,
        sourceHandle: params.handleId ?? null,
      })
    },
    [useStore]
  )
  const handleConnectEnd = useCallback<OnConnectEnd>(
    () => useStore.getState().endConnection(),
    [useStore]
  )

  // ── Viewport move tracking ────────────────────────────────────────────────
  const handleMoveStart = useCallback(() => setIsMovingViewport(true), [])
  const onMoveEnd = useCallback(
    (_e: unknown, v: import("@xyflow/react").Viewport) => {
      setIsMovingViewport(false)
      useStore.getState().setViewport(v)
    },
    [useStore]
  )

  // ── Drag + alignment-guide computation ───────────────────────────────────
  // The peer rect map is captured ONCE on drag start (O(n)) and looked up via
  // ref each frame; rAF coalesces multiple pointermove events per frame.
  const drag = useDragSnapshot()
  const dragRectRef = useRef<{ width: number; height: number } | null>(null)

  const dragComputeAndSet = useCallback(
    (dragged: RectLike) => {
      const index = drag.getAlignmentIndex()
      if (!index) return
      setAlignmentGuides(computeAlignmentGuides(dragged, index))
    },
    [drag]
  )
  const dragThrottled = useRafThrottle(dragComputeAndSet)

  const handleNodeDragStart = useCallback(
    (
      _e: unknown,
      draggedNode: {
        id: string
        position: { x: number; y: number }
        width?: number | null
        height?: number | null
      }
    ) => {
      const s = useStore.getState()
      // Pause + snapshot before any position `setNodes` fires, so the whole
      // drag coalesces into a single undo entry (see store.beginDragHistory).
      s.beginDragHistory()
      s.setIsDraggingAny(true)
      if (!perfTier.flags.alignmentGuides) {
        dragRectRef.current = null
        return
      }
      drag.capture(s.nodes, draggedNode.id)
      const live = rf.getNode(draggedNode.id)
      const w =
        (live?.measured?.width as number | undefined) ??
        (live?.width as number | undefined) ??
        draggedNode.width ??
        240
      const h =
        (live?.measured?.height as number | undefined) ??
        (live?.height as number | undefined) ??
        draggedNode.height ??
        80
      dragRectRef.current = { width: w, height: h }
    },
    [drag, perfTier.flags.alignmentGuides, rf, useStore]
  )

  const handleNodeDrag = useCallback(
    (_e: unknown, draggedNode: { id: string; position: { x: number; y: number } }) => {
      if (!perfTier.flags.alignmentGuides) return
      const cached = dragRectRef.current
      const live = rf.getNode(draggedNode.id)
      const w =
        (live?.measured?.width as number | undefined) ??
        (live?.width as number | undefined) ??
        cached?.width ??
        240
      const h =
        (live?.measured?.height as number | undefined) ??
        (live?.height as number | undefined) ??
        cached?.height ??
        80
      dragThrottled.call({
        id: draggedNode.id,
        x: draggedNode.position.x,
        y: draggedNode.position.y,
        width: w,
        height: h,
      })
    },
    [dragThrottled, perfTier.flags.alignmentGuides, rf]
  )

  const handleNodeDragStop = useCallback(
    (_e: unknown, draggedNode?: { id: string }) => {
      useStore.getState().commitDragHistory()
      dragThrottled.cancel()
      drag.release()
      dragRectRef.current = null
      setAlignmentGuides(null)
      useStore.getState().setIsDraggingAny(false)

      // Loop-container drop: re-parent a node dropped over a container's
      // body. (Dragging OUT is intentionally not a drag gesture — children
      // carry `extent: 'parent'` so they can't leave by accident; use the
      // node context menu / `setNodeParent(id, null)`.)
      if (!draggedNode) return
      const s = useStore.getState()
      const dropped = rf.getNode(draggedNode.id)
      if (!dropped) return
      const intersecting = rf
        .getIntersectingNodes(dropped)
        .filter((n) => n.type === "loopContainer")
        .map((n) => ({
          id: n.id,
          width: (n.measured?.width as number | undefined) ?? n.width,
          height: (n.measured?.height as number | undefined) ?? n.height,
        }))
      const target = pickContainerTarget(
        dropped.id,
        intersecting,
        s.nodes.map((n) => ({ id: n.id, parentId: n.parentId }))
      )
      if (target !== null && (dropped.parentId ?? null) !== target) {
        s.setNodeParent(dropped.id, target)
      }
    },
    [drag, dragThrottled, useStore, rf]
  )

  // Multi-selection drags route through React Flow's selection-drag events
  // (the canvas has `selectionOnDrag`), so they need the same coalescing.
  const handleSelectionDragStart = useCallback(() => {
    const s = useStore.getState()
    s.beginDragHistory()
    s.setIsDraggingAny(true)
  }, [useStore])

  const handleSelectionDragStop = useCallback(() => {
    const s = useStore.getState()
    s.commitDragHistory()
    s.setIsDraggingAny(false)
  }, [useStore])

  return (
    <div
      ref={canvasWrapperRef}
      className="relative h-full w-full overflow-hidden bg-muted/30"
      data-testid="workflow-canvas"
      onDrop={onDrop}
      onDragOver={onDragOver}
    >
      <ViewportBreadcrumb store={useStore} reactFlowInstance={reactFlowInstance} />
      <LassoOverlay
        containerRef={canvasWrapperRef}
        reactFlowInstance={reactFlowInstance}
        store={useStore}
        enabled={true}
      />
      <ConnectionPointerListener store={useStore} />
      <PerfBoundary id="workflow:canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          defaultViewport={initialViewport}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          isValidConnection={isValidConnection}
          onMoveStart={handleMoveStart}
          onMoveEnd={onMoveEnd}
          onNodeDragStart={handleNodeDragStart}
          onNodeDrag={handleNodeDrag}
          onNodeDragStop={handleNodeDragStop}
          onSelectionDragStart={handleSelectionDragStart}
          onSelectionDragStop={handleSelectionDragStop}
          onPaneContextMenu={onPaneContextMenu}
          onNodeContextMenu={onNodeContextMenu}
          onEdgeContextMenu={onEdgeContextMenu}
          onInit={setReactFlowInstance}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          connectionLineComponent={connectionLineGhost}
          onConnectStart={handleConnectStart}
          onConnectEnd={handleConnectEnd}
          fitView={FIT_VIEW_PROPS}
          minZoom={0.2}
          maxZoom={2}
          snapToGrid={snapToGrid}
          snapGrid={SNAP_GRID}
          deleteKeyCode={DELETE_KEY_CODE}
          multiSelectionKeyCode={MULTI_SELECTION_KEY_CODE}
          panOnScroll
          selectionOnDrag
          proOptions={PRO_OPTIONS}
          nodesDraggable={interactive}
          nodesConnectable={interactive}
          elementsSelectable={interactive}
          // (A1) Tier-aware viewport culling.
          onlyRenderVisibleElements={
            nodes.length >= perfTier.flags.cullingThreshold || perfTier.effective !== "high"
          }
        >
          {backgroundVariant !== "none" ? (
            <Background
              variant={
                backgroundVariant === "lines" ? BackgroundVariant.Lines : BackgroundVariant.Dots
              }
              gap={16}
              size={1}
            />
          ) : null}
          {perfTier.flags.showMinimap && minimapVisible ? (
            <PerfMiniMap
              degraded={isDraggingAny || isMovingViewport || perfTier.flags.minimapDegraded}
              nodeColor={minimapNodeColor}
              className="!rounded-md !border !bg-background"
            />
          ) : null}
          <AlignmentOverlay guides={alignmentGuides} />
        </ReactFlow>
      </PerfBoundary>
      {overlays}
    </div>
  )
}
