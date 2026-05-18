/**
 * Editor store — Zustand + zundo (undo/redo) holding the canvas state for a
 * single workflow. The store is created per-editor-instance via `createEditorStore`
 * (NOT a singleton) so opening two workflows in two windows / tabs doesn't
 * cross-pollute history.
 *
 * What lives here:
 *   • nodes / edges / viewport            — React Flow's canvas state
 *   • selectedNodeIds                     — for the inspector + delete shortcut
 *   • dirty                               — has the user changed anything since save
 *   • savedAt                             — timestamp of last successful save
 *   • baseWorkflow                        — the rest of the VisualWorkflow shape
 *                                           that doesn't live in nodes/edges
 *
 * What does NOT live here:
 *   • workflow definitions on disk (Dexie owns those)
 *   • run state / event log (separate runtime stores)
 *   • per-node config form state (react-hook-form owns that)
 */

import { create, type StoreApi, type UseBoundStore } from "zustand"
import { temporal, type TemporalState } from "zundo"
import { nanoid } from "nanoid"
import type { Viewport } from "@xyflow/react"
import type { VisualWorkflow, WorkflowNodeData, WorkflowNodeKind } from "@/types/workflow/visual"
import {
  reactFlowToWorkflow,
  workflowToReactFlow,
  type RFWorkflowEdge,
  type RFWorkflowNode,
} from "./react-flow-converter"
import {
  validateAllNodes,
  validateNodeParams,
  type NodeValidationResult,
} from "@/lib/workflow/nodes/validate-params"
import {
  cloneNodesAndEdges,
  rehydrateFromEnvelope,
  selectionBounds,
  type ClipboardEnvelope,
} from "./clipboard"
import type { PerformanceTier } from "./performance-tier"
import type { LastRunSummary } from "@/lib/workflow/runtime/last-run-summary"

export interface EditorStateSnapshot {
  nodes: RFWorkflowNode[]
  edges: RFWorkflowEdge[]
  viewport: Viewport
}

/**
 * Live execution state for each node. The run-status bridge subscribes to
 * `workflowRunEvents` for the currently-edited workflow and pushes per-step
 * states here; the canvas merges these into node `data` so the user sees
 * a green/red/spinning ring on each node as the run progresses.
 */
export type NodeRunStatus = "idle" | "running" | "succeeded" | "failed" | "skipped" | "waiting"

/**
 * Snapshot of the nearest snap-eligible target handle while the user is
 * dragging an edge from a source handle.
 */
export interface ConnectionCandidate {
  nodeId: string
  handleId: string | null
  /** Flow-space distance from the pointer to the candidate handle. */
  distance: number
}

export interface ConnectionState {
  sourceId: string
  sourceHandle: string | null
  /** Nearest compatible target handle within snap radius, or null. */
  candidate: ConnectionCandidate | null
  /** Latest pointer position in flow space, or null at drag-start. */
  pointer: { x: number; y: number } | null
}

export interface EditorState extends EditorStateSnapshot {
  /** The persisted workflow envelope; `nodes`/`edges`/`viewport` live above. */
  baseWorkflow: VisualWorkflow
  selectedNodeIds: string[]
  selectedEdgeIds: string[]
  dirty: boolean
  savedAt: number | null
  /** Per-stepId live execution status, keyed by node id. */
  runStatusByStepId: Record<string, NodeRunStatus>
  /**
   * Per-node validation result, keyed by node id. Only nodes with at least
   * one error are present — passing nodes are pruned so the canvas /
   * inspector can render based on key existence alone. Populated on params
   * change by `revalidateNode` and on save by `revalidateAll`.
   */
  validationByStepId: Record<string, NodeValidationResult>
  /**
   * Aggregated outcome of the most recent terminal event for each step.
   * Mirrored into the store by the canvas (which subscribes via Dexie
   * liveQuery `useLastRunSummaryByStep`) so that `useNodeDecoration` can
   * read per-node decorations with O(1) fine-grained subscriptions. (A4)
   */
  lastRunByStepId: Record<string, LastRunSummary>

  // ── editor preferences (ephemeral; not undoable) ──────────────────────────
  /**
   * Visual workflow editor performance tier — controls minimap, alignment
   * guides, inspector live-query, and motion. `"auto"` is the default and
   * the resolver picks based on `prefers-reduced-motion` + node count. See
   * `lib/workflow/editor/performance-tier.ts`. Hydrated on mount from
   * `loadPerformanceTierPref` and persisted through `savePerformanceTierPref`.
   */
  performanceTier: PerformanceTier
  setPerformanceTier: (tier: PerformanceTier) => void
  /**
   * Whether any node is currently being dragged. Set by the canvas's
   * `onNodeDragStart` / `onNodeDragStop` handlers. Consumers degrade
   * gracefully while this is true (minimap loses listeners, inspector
   * live-query pauses).
   */
  isDraggingAny: boolean
  setIsDraggingAny: (v: boolean) => void
  /**
   * Whether `<ReactFlow>` should snap node positions to the grid. Mirrors
   * the React Flow `snapToGrid` prop. Defaults to `true`.
   */
  snapToGrid: boolean
  setSnapToGrid: (v: boolean) => void
  /**
   * Node currently being hovered (set by the unified node component).
   * Drives the floating mini toolbar and downstream affordances.
   */
  hoveredNodeId: string | null
  setHoveredNode: (id: string | null) => void
  /** Edge currently being hovered (smart-edge endpoint highlighting). */
  hoveredEdgeId: string | null
  setHoveredEdge: (id: string | null) => void
  /** Node id whose label is being edited inline (right-click → Rename). */
  editingNodeIdInline: string | null
  setEditingNodeIdInline: (id: string | null) => void
  /** Edge id whose label is being edited inline (double-click). */
  editingEdgeIdInline: string | null
  setEditingEdgeIdInline: (id: string | null) => void
  /**
   * Flow-space position where the command palette should drop the next added
   * node. Set by the context menu's "Add node here…" item and consumed
   * (then cleared) when the palette dispatches an add.
   */
  palettePrefillPosition: { x: number; y: number } | null
  setPalettePrefillPosition: (pos: { x: number; y: number } | null) => void
  /**
   * Transient pulse target — set by Spotlight search after `setViewport` so
   * the node renderer can apply a brief ring highlight. Auto-clears after
   * `durationMs` via `pulseNode`.
   */
  spotlightedNodeId: string | null
  setSpotlightedNodeId: (id: string | null) => void
  pulseNode: (id: string, durationMs: number) => void
  /**
   * Live state of an in-flight edge drag (Flowith-style "drag silk"). Set
   * by canvas on `onConnectStart`, updated on pointermove with the nearest
   * compatible candidate handle, cleared on `onConnectEnd`. Node renderers
   * read this to ring compatible handles green / incompatible red.
   */
  connectionState: ConnectionState | null
  beginConnection: (source: { sourceId: string; sourceHandle: string | null }) => void
  updateConnectionPointer: (
    pointer: { x: number; y: number } | null,
    candidate: ConnectionCandidate | null
  ) => void
  endConnection: () => void
  /**
   * Out-of-band signal from the mini toolbar's "More" button → canvas.
   * The canvas subscribes and opens the F1 context menu anchored at
   * `screenAnchor` for the supplied target kind. Cleared by the canvas
   * after the menu opens (or on next click anywhere).
   */
  requestedContextMenu: {
    target: { kind: "node"; nodeId: string } | { kind: "edge"; edgeId: string }
    screenAnchor: { x: number; y: number }
  } | null
  requestContextMenu: (
    target: { kind: "node"; nodeId: string } | { kind: "edge"; edgeId: string },
    screenAnchor: { x: number; y: number }
  ) => void
  clearRequestedContextMenu: () => void
  /**
   * Signal from mini-toolbar / context-menu → canvas to start a "Run from
   * here" run rooted at this node id. The canvas subscribes, executes
   * `runWorkflow({ workflow, trigger, startStepId })`, and clears the
   * field once the run starts.
   */
  requestedRunFromStepId: string | null
  requestRunFromStep: (stepId: string) => void
  clearRequestedRunFromStep: () => void

  // ── mutators (graph) ──────────────────────────────────────────────────────
  setNodes: (nodes: RFWorkflowNode[]) => void
  setEdges: (edges: RFWorkflowEdge[]) => void
  setViewport: (viewport: Viewport) => void
  addNode: (
    kind: WorkflowNodeKind,
    position: { x: number; y: number },
    overrides?: Partial<WorkflowNodeData>
  ) => string
  removeNodes: (ids: string[]) => void
  updateNodeData: (id: string, patch: Partial<WorkflowNodeData>) => void
  connect: (params: {
    source: string
    target: string
    sourceHandle?: string
    targetHandle?: string
  }) => string
  /** Update an edge's `data` field (undoable). Returns true if the edge existed. */
  updateEdgeData: (id: string, patch: Record<string, unknown>) => boolean
  /**
   * Replace an edge in place (undoable). Returns true if found. Used by the
   * "Reverse direction" context-menu item, which needs to swap source/target.
   */
  replaceEdge: (id: string, next: Partial<RFWorkflowEdge>) => boolean
  /** Remove the given edges (undoable). */
  removeEdges: (ids: string[]) => void

  // ── mutators (selection) ──────────────────────────────────────────────────
  setSelectedNodes: (ids: string[]) => void
  setSelectedEdges: (ids: string[]) => void
  clearSelection: () => void

  // ── mutators (envelope) ───────────────────────────────────────────────────
  setName: (name: string) => void
  setDescription: (d?: string) => void

  // ── lifecycle ─────────────────────────────────────────────────────────────
  /** Replace entire state with a fresh workflow (e.g., on route change). */
  loadWorkflow: (wf: VisualWorkflow) => void
  /** Snapshot back into a `VisualWorkflow` for `replaceWorkflow(wf)`. */
  toWorkflow: () => VisualWorkflow
  /** Mark the editor as saved at the current timestamp. */
  markSaved: () => void
  resetDirty: () => void

  // ── productivity actions (undoable) ──────────────────────────────────────
  /**
   * Duplicate the given nodes (and the edges fully inside the subset),
   * offset by `{x:24,y:24}`, select the clones, return their new ids.
   */
  duplicateNodes: (ids: string[]) => string[]
  /**
   * Insert nodes/edges from a system-clipboard envelope. Used by Ctrl+V to
   * paste content potentially copied from another workflow.
   */
  pasteFromEnvelope: (envelope: ClipboardEnvelope) => string[]
  /**
   * Wrap the given nodes in an `annotation.group` frame sized to the
   * selection bounding box (with padding). Returns the new group's id.
   */
  groupSelected: (ids: string[]) => string | null
  /** Select every node + edge in the workflow. */
  selectAll: () => void

  // ── runtime status (not undoable) ────────────────────────────────────────
  setRunStatus: (stepId: string, status: NodeRunStatus) => void
  setRunStatusBatch: (entries: Record<string, NodeRunStatus>) => void
  clearRunStatus: () => void
  /** Replace one node's validation result. Pass `null` to clear. */
  setValidation: (stepId: string, result: NodeValidationResult | null) => void
  /** Replace the whole validation map (used by `revalidateAll`). */
  setValidationBatch: (entries: Record<string, NodeValidationResult>) => void
  clearValidation: () => void
  /**
   * Replace the entire last-run-summary map. The canvas calls this from a
   * `useEffect` driven by the `useLastRunSummaryByStep` Dexie liveQuery.
   * Identity is referentially compared before write so unrelated runs do
   * not churn subscribers.
   */
  setLastRunByStepId: (entries: Record<string, LastRunSummary>) => void
  clearLastRun: () => void
  /** Run zod validation for one node and write the result to the store. */
  revalidateNode: (id: string) => NodeValidationResult
  /** Run zod validation for every node and replace `validationByStepId`. */
  revalidateAll: () => Record<string, NodeValidationResult>
}

export type EditorStore = UseBoundStore<StoreApi<EditorState>> & {
  temporal: StoreApi<TemporalState<Pick<EditorState, "nodes" | "edges">>>
}

const labelByKind: Partial<Record<WorkflowNodeKind, string>> = {
  "trigger.manual": "Run manually",
  "trigger.cron": "On schedule",
  "trigger.connector.inbound": "Incoming message",
  "trigger.chat.message": "On chat message",
  "trigger.webhook": "On webhook",
  "action.character.send": "Send as character",
  "action.team.run": "Run team",
  "action.skill.invoke": "Invoke skill",
  "action.twin.rag": "Twin RAG",
  "action.connector.send": "Send via connector",
  "ai.prompt": "AI prompt",
  "flow.branch": "If / else",
  "flow.set": "Set variable",
}

function defaultLabelFor(kind: WorkflowNodeKind): string {
  return labelByKind[kind] ?? kind
}

/**
 * Cheap equality test for `NodeValidationResult` so `revalidateNode` can
 * skip a no-op `set()` and avoid re-triggering subscribers (which would
 * loop with effects that depend on the selected node).
 */
function shallowEqualValidation(a: NodeValidationResult, b: NodeValidationResult): boolean {
  if (a === b) return true
  if (a.hasErrors !== b.hasErrors) return false
  const aKeys = Object.keys(a.fields)
  const bKeys = Object.keys(b.fields)
  if (aKeys.length !== bKeys.length) return false
  for (const k of aKeys) {
    if (!(k in b.fields)) return false
    if (a.fields[k].key !== b.fields[k].key) return false
  }
  return true
}

export function createEditorStore(initial: VisualWorkflow): EditorStore {
  const converted = workflowToReactFlow(initial)
  const useStore = create<EditorState>()(
    temporal(
      (set, get) => ({
        baseWorkflow: initial,
        nodes: converted.nodes,
        edges: converted.edges,
        viewport: converted.viewport,
        selectedNodeIds: [],
        selectedEdgeIds: [],
        dirty: false,
        savedAt: initial.updatedAt > 0 ? initial.updatedAt : null,
        runStatusByStepId: {},
        validationByStepId: {},
        lastRunByStepId: {},
        performanceTier: "auto",
        isDraggingAny: false,
        snapToGrid: true,
        hoveredNodeId: null,
        hoveredEdgeId: null,
        editingNodeIdInline: null,
        editingEdgeIdInline: null,
        palettePrefillPosition: null,
        spotlightedNodeId: null,
        connectionState: null,
        requestedContextMenu: null,
        requestedRunFromStepId: null,

        setPerformanceTier: (performanceTier) => set({ performanceTier }),
        setIsDraggingAny: (isDraggingAny) => set({ isDraggingAny }),
        setSnapToGrid: (snapToGrid) => set({ snapToGrid }),
        setHoveredNode: (id) => {
          if (get().hoveredNodeId === id) return
          set({ hoveredNodeId: id })
        },
        setHoveredEdge: (id) => {
          if (get().hoveredEdgeId === id) return
          set({ hoveredEdgeId: id })
        },
        setEditingNodeIdInline: (id) => set({ editingNodeIdInline: id }),
        setEditingEdgeIdInline: (id) => set({ editingEdgeIdInline: id }),
        setPalettePrefillPosition: (pos) => set({ palettePrefillPosition: pos }),
        setSpotlightedNodeId: (id) => set({ spotlightedNodeId: id }),
        pulseNode: (id, durationMs) => {
          set({ spotlightedNodeId: id })
          if (durationMs <= 0) {
            set({ spotlightedNodeId: null })
            return
          }
          setTimeout(() => {
            if (get().spotlightedNodeId === id) {
              set({ spotlightedNodeId: null })
            }
          }, durationMs)
        },
        beginConnection: (source) =>
          set({
            connectionState: {
              sourceId: source.sourceId,
              sourceHandle: source.sourceHandle,
              candidate: null,
              pointer: null,
            },
          }),
        updateConnectionPointer: (pointer, candidate) => {
          const cur = get().connectionState
          if (!cur) return
          // Skip no-op writes so node renderers don't churn on every
          // pointermove when neither pointer nor candidate has shifted.
          const prevCand = cur.candidate
          const sameCand =
            (prevCand?.nodeId === candidate?.nodeId &&
              prevCand?.handleId === candidate?.handleId) ||
            (prevCand === null && candidate === null)
          const samePointer = cur.pointer?.x === pointer?.x && cur.pointer?.y === pointer?.y
          if (sameCand && samePointer) return
          set({
            connectionState: {
              ...cur,
              candidate,
              pointer,
            },
          })
        },
        endConnection: () => set({ connectionState: null }),
        requestContextMenu: (target, screenAnchor) =>
          set({ requestedContextMenu: { target, screenAnchor } }),
        clearRequestedContextMenu: () => set({ requestedContextMenu: null }),
        requestRunFromStep: (stepId) => set({ requestedRunFromStepId: stepId }),
        clearRequestedRunFromStep: () => set({ requestedRunFromStepId: null }),

        setNodes: (nodes) => set({ nodes, dirty: true }),
        setEdges: (edges) => set({ edges, dirty: true }),
        setViewport: (viewport) => set({ viewport, dirty: true }),

        addNode: (kind, position, overrides) => {
          const id = "n_" + nanoid(8)
          const node: RFWorkflowNode = {
            id,
            type: "workflowNode",
            position,
            data: {
              label: overrides?.label ?? defaultLabelFor(kind),
              params: overrides?.params ?? {},
              notes: overrides?.notes,
              credentialRefs: overrides?.credentialRefs,
              disabled: overrides?.disabled,
              // Provenance (Phase E): "ai" when created via the
              // workflow-ai plugin tools, "user" / undefined otherwise.
              authoredBy: overrides?.authoredBy,
              kind,
              typeVersion: 1,
            },
          }
          set({ nodes: [...get().nodes, node], dirty: true })
          return id
        },

        removeNodes: (ids) => {
          const idSet = new Set(ids)
          set({
            nodes: get().nodes.filter((n) => !idSet.has(n.id)),
            edges: get().edges.filter((e) => !idSet.has(e.source) && !idSet.has(e.target)),
            selectedNodeIds: get().selectedNodeIds.filter((id) => !idSet.has(id)),
            dirty: true,
          })
        },

        updateNodeData: (id, patch) => {
          set({
            nodes: get().nodes.map((n) =>
              n.id === id ? { ...n, data: { ...n.data, ...patch } } : n
            ),
            dirty: true,
          })
        },

        connect: ({ source, target, sourceHandle, targetHandle }) => {
          const id = "e_" + nanoid(8)
          const edge: RFWorkflowEdge = {
            id,
            source,
            target,
            sourceHandle: sourceHandle ?? undefined,
            targetHandle: targetHandle ?? undefined,
            type: "default",
          }
          set({ edges: [...get().edges, edge], dirty: true })
          return id
        },

        updateEdgeData: (id, patch) => {
          const edges = get().edges
          const idx = edges.findIndex((e) => e.id === id)
          if (idx < 0) return false
          const target = edges[idx]
          const nextData = { ...((target.data as Record<string, unknown>) ?? {}), ...patch }
          const next: RFWorkflowEdge = { ...target, data: nextData }
          const arr = [...edges]
          arr[idx] = next
          set({ edges: arr, dirty: true })
          return true
        },

        replaceEdge: (id, patch) => {
          const edges = get().edges
          const idx = edges.findIndex((e) => e.id === id)
          if (idx < 0) return false
          const arr = [...edges]
          arr[idx] = { ...edges[idx], ...patch, id }
          set({ edges: arr, dirty: true })
          return true
        },

        removeEdges: (ids) => {
          if (ids.length === 0) return
          const idSet = new Set(ids)
          set({
            edges: get().edges.filter((e) => !idSet.has(e.id)),
            selectedEdgeIds: get().selectedEdgeIds.filter((eId) => !idSet.has(eId)),
            dirty: true,
          })
        },

        setSelectedNodes: (ids) => set({ selectedNodeIds: ids }),
        setSelectedEdges: (ids) => set({ selectedEdgeIds: ids }),
        clearSelection: () => set({ selectedNodeIds: [], selectedEdgeIds: [] }),

        setName: (name) =>
          set({
            baseWorkflow: { ...get().baseWorkflow, name },
            dirty: true,
          }),
        setDescription: (description) =>
          set({
            baseWorkflow: { ...get().baseWorkflow, description },
            dirty: true,
          }),

        loadWorkflow: (wf) => {
          const c = workflowToReactFlow(wf)
          set({
            baseWorkflow: wf,
            nodes: c.nodes,
            edges: c.edges,
            viewport: c.viewport,
            selectedNodeIds: [],
            selectedEdgeIds: [],
            dirty: false,
            savedAt: wf.updatedAt > 0 ? wf.updatedAt : null,
          })
          // Reset history so the freshly loaded graph doesn't show "undo"
          // back to a prior workflow.
          ;(useStore as EditorStore).temporal.getState().clear()
        },

        toWorkflow: () => {
          const s = get()
          return reactFlowToWorkflow(s.baseWorkflow, s.nodes, s.edges, s.viewport)
        },

        markSaved: () => set({ dirty: false, savedAt: Date.now() }),
        resetDirty: () => set({ dirty: false }),

        duplicateNodes: (ids) => {
          if (ids.length === 0) return []
          const { nodes, edges } = get()
          const cloned = cloneNodesAndEdges(nodes, edges, ids)
          if (cloned.nodes.length === 0) return []
          set({
            nodes: [...nodes, ...cloned.nodes],
            edges: [...edges, ...cloned.edges],
            selectedNodeIds: cloned.nodes.map((n) => n.id),
            dirty: true,
          })
          return cloned.nodes.map((n) => n.id)
        },

        pasteFromEnvelope: (envelope) => {
          if (!envelope || envelope.nodes.length === 0) return []
          const { nodes, edges } = get()
          const cloned = rehydrateFromEnvelope(envelope)
          set({
            nodes: [...nodes, ...cloned.nodes],
            edges: [...edges, ...cloned.edges],
            selectedNodeIds: cloned.nodes.map((n) => n.id),
            dirty: true,
          })
          return cloned.nodes.map((n) => n.id)
        },

        groupSelected: (ids) => {
          if (ids.length === 0) return null
          const { nodes } = get()
          const bounds = selectionBounds(nodes, ids)
          if (!bounds) return null
          const padding = 32
          const id = "n_" + nanoid(8)
          const group: RFWorkflowNode = {
            id,
            type: "workflowNode",
            position: { x: bounds.x - padding, y: bounds.y - padding * 1.5 },
            data: {
              label: "Group",
              kind: "annotation.group",
              typeVersion: 1,
              params: {
                title: "Group",
                width: bounds.width + padding * 2,
                height: bounds.height + padding * 2.25,
              },
            },
          }
          set({
            // Group goes FIRST in the array so React Flow paints it under
            // its members (group should not occlude its contents).
            nodes: [group, ...get().nodes],
            selectedNodeIds: [id],
            dirty: true,
          })
          return id
        },

        selectAll: () => {
          const { nodes, edges } = get()
          set({
            selectedNodeIds: nodes.map((n) => n.id),
            selectedEdgeIds: edges.map((e) => e.id),
          })
        },

        setRunStatus: (stepId, status) =>
          set({
            runStatusByStepId: { ...get().runStatusByStepId, [stepId]: status },
          }),
        setRunStatusBatch: (entries) =>
          set({ runStatusByStepId: { ...get().runStatusByStepId, ...entries } }),
        clearRunStatus: () => set({ runStatusByStepId: {} }),

        setValidation: (stepId, result) => {
          const next = { ...get().validationByStepId }
          if (result === null || !result.hasErrors) {
            delete next[stepId]
          } else {
            next[stepId] = result
          }
          set({ validationByStepId: next })
        },
        setValidationBatch: (entries) => set({ validationByStepId: { ...entries } }),
        clearValidation: () => set({ validationByStepId: {} }),
        setLastRunByStepId: (entries) => {
          // Skip the write entirely when the reference matches — Dexie
          // liveQuery hands us a fresh object only when underlying rows
          // actually changed.
          if (get().lastRunByStepId === entries) return
          set({ lastRunByStepId: entries })
        },
        clearLastRun: () => set({ lastRunByStepId: {} }),
        revalidateNode: (id) => {
          const node = get().nodes.find((n) => n.id === id)
          if (!node) return { fields: {}, summary: [], hasErrors: false }
          const result = validateNodeParams(
            node.data.kind as WorkflowNodeKind,
            (node.data.params as Record<string, unknown> | undefined) ?? {}
          )
          const current = get().validationByStepId
          if (!result.hasErrors) {
            if (!(id in current)) return result
            const next = { ...current }
            delete next[id]
            set({ validationByStepId: next })
            return result
          }
          const prev = current[id]
          if (prev && shallowEqualValidation(prev, result)) return result
          set({ validationByStepId: { ...current, [id]: result } })
          return result
        },
        revalidateAll: () => {
          const errs = validateAllNodes(
            get().nodes.map((n) => ({
              id: n.id,
              data: {
                kind: n.data.kind as string,
                params: (n.data.params as Record<string, unknown> | undefined) ?? {},
              },
            }))
          )
          set({ validationByStepId: errs })
          return errs
        },
      }),
      {
        // Track only nodes + edges in the temporal slice. Viewport and
        // selection should not be undoable: panning and clicking should not
        // pollute the history stack.
        partialize: (state) => ({ nodes: state.nodes, edges: state.edges }),
        // Equality skips no-op pushes (e.g., when a re-render produces the
        // same array reference). Drag-coalescing (so undo rolls back to the
        // pre-drag position, not each intermediate frame) is deferred to
        // Phase 9 polish.
        equality: (a, b) => a.nodes === b.nodes && a.edges === b.edges,
        limit: 100,
      }
    )
  ) as EditorStore
  return useStore
}
