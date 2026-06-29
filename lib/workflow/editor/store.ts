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
import type {
  VisualWorkflow,
  WorkflowCredentialRef,
  WorkflowNodeData,
  WorkflowNodeKind,
  WorkflowSettings,
} from "@/types/workflow/visual"
import {
  reactFlowToWorkflow,
  workflowToReactFlow,
  type RFWorkflowEdge,
  type RFWorkflowNode,
} from "./react-flow-converter"
import { mark as perfMark } from "@/lib/perf"
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
import { defaultTypeVersionFor } from "./node-handles"
import { validateConnection } from "./connection-validator"
import { computeSplitEdges } from "./edge-insert"
import type { ProposalOp } from "./proposal-types"
import type { PerformanceTier } from "./performance-tier"
import type { LastRunSummary } from "@/lib/workflow/runtime/last-run-summary"
import { runDiagnostics } from "@/lib/workflow/diagnostics/engine"
import { EMPTY_DIAGNOSTICS, type DiagnosticsResult } from "@/lib/workflow/diagnostics/types"
import { isTauri } from "@/lib/platform/detect"

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
   * Workflow-wide diagnostics (errors + warnings) — the union of param
   * validation, graph integrity, expression-reference scope, credential
   * preflight, etc. Recomputed debounced by the store's own driver whenever
   * the graph changes; read by the Problems panel, the node/edge decorations,
   * and the save/run gate. Distinct from `validationByStepId`, which is the
   * inspector's fast per-field path. See `lib/workflow/diagnostics/`.
   */
  diagnostics: DiagnosticsResult
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
   * Mobile-only switch: when true, the shared node renderer arms tap-to-connect
   * from a source handle on click (touch can't reliably drag a 12px handle).
   * Desktop never sets it, so the handle-tap path is a no-op there and the
   * native drag-to-connect interaction is untouched. Set by the mobile editor
   * when entering edit mode; cleared on read mode / unmount.
   */
  touchConnect: boolean
  setTouchConnect: (v: boolean) => void
  /**
   * Pending "create node from a dragged handle" (C2). Set when a connection is
   * released on the empty pane: the canvas opens the palette, and on pick
   * routes through `addNodeConnected` to create the node at `dropPos` and wire
   * `sourceId`(+`sourceHandle`) → it. Cleared when the palette closes.
   */
  pendingConnectFrom: {
    sourceId: string
    sourceHandle: string | null
    dropPos: { x: number; y: number }
  } | null
  setPendingConnectFrom: (
    v: { sourceId: string; sourceHandle: string | null; dropPos: { x: number; y: number } } | null
  ) => void
  /**
   * Create a node at `position` and connect `from.sourceId`(+handle) → it in a
   * single undo entry. Returns the new node id, or `null` if the resulting
   * connection is invalid. Used by add-node-from-handle (C2) and keyboard
   * create+connect (C3).
   */
  addNodeConnected: (
    kind: WorkflowNodeKind,
    position: { x: number; y: number },
    from: { sourceId: string; sourceHandle: string | null }
  ) => string | null
  /**
   * Replace a selected node set with a single new node (extract-to-subworkflow,
   * C5). Removes the selected nodes (cascading their container children) and
   * every edge touching them, adds `replacement`, and rewires the boundary
   * edges: external inbound → new node, new node → external outbound (deduped).
   * One undo entry. Returns the new node id.
   */
  replaceSelectionWithNode: (
    selectedIds: string[],
    replacement: {
      kind: WorkflowNodeKind
      params: Record<string, unknown>
      position: { x: number; y: number }
      label?: string
    },
    rewires: {
      inbound: Array<{ source: string; sourceHandle?: string }>
      outbound: Array<{ target: string; targetHandle?: string }>
    }
  ) => string
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
  /**
   * Signal → canvas to "Run this step": execute ONLY this node (plus any
   * ancestors lacking data), reusing pinned / last-run upstream. Mirrors the
   * `requestedRunFromStep` trio. The canvas subscribes, calls `runSingleNode`,
   * and clears the field once the run starts.
   */
  requestedRunSingleStepId: string | null
  requestRunSingleStep: (stepId: string) => void
  clearRequestedRunSingleStep: () => void
  /**
   * Signal → right sidebar to switch to the Problems tab. Set by the run gate
   * when a run is blocked on errors so the user is taken straight to the list.
   * The sidebar consumes it and clears it (respecting a pinned tab).
   */
  requestedProblemsPanel: boolean
  requestProblemsPanel: () => void
  clearRequestedProblemsPanel: () => void

  // ── mutators (graph) ──────────────────────────────────────────────────────
  setNodes: (nodes: RFWorkflowNode[]) => void
  setEdges: (edges: RFWorkflowEdge[]) => void
  setViewport: (viewport: Viewport) => void
  /**
   * Drag-history coalescing. `beginDragHistory` pauses zundo recording and
   * snapshots the pre-drag graph; `commitDragHistory` resumes recording and
   * pushes exactly one undo entry for the whole drag (or none if nothing
   * moved). Without this, the ~60 `setNodes` calls a drag emits each push a
   * full snapshot, exhausting the history limit in 1–2 drags.
   */
  beginDragHistory: () => void
  commitDragHistory: () => void
  addNode: (
    kind: WorkflowNodeKind,
    position: { x: number; y: number },
    overrides?: Partial<WorkflowNodeData>
  ) => string
  /**
   * Insert a new node onto an existing edge, splitting it
   * `source → new → target` in a single undo entry. Preserves the original
   * edge's source/target handles. No-ops (returns `null`) if the edge is gone
   * or either replacement connection fails validation.
   */
  insertNodeOnEdge: (
    edgeId: string,
    kind: WorkflowNodeKind,
    position: { x: number; y: number },
    overrides?: Partial<WorkflowNodeData>
  ) => string | null
  removeNodes: (ids: string[]) => void
  /**
   * Re-parent a node into (or out of, with `null`) a loop container's
   * sub-canvas. Converts the node's position between absolute and
   * parent-relative coordinates so it stays visually in place. No-ops on
   * self-parenting or when the target is not a loop container.
   */
  setNodeParent: (nodeId: string, parentId: string | null) => void
  updateNodeData: (id: string, patch: Partial<WorkflowNodeData>) => void
  /**
   * Apply the same `data` patch to every node in `ids` in a single `set()`
   * so the whole batch is one undo entry. Used by the multi-select inspector
   * to toggle `disabled` / set `notes` across the selection at once. Only the
   * cross-kind-safe fields (`disabled`, `notes`, `label`) should be patched —
   * `params` is kind-specific and must not be bulk-written.
   */
  updateNodeDataBatch: (ids: string[], patch: Partial<WorkflowNodeData>) => void
  /**
   * Set `errorHandling.onError` across a selection, MERGING per node so each
   * node keeps its own `retry` / `defaultValue` (a plain `updateNodeDataBatch`
   * would replace the whole `errorHandling` object and drop them). `"fail"`
   * clears the override (the default). One undo entry.
   */
  setBulkOnError: (
    ids: string[],
    onError: NonNullable<WorkflowNodeData["errorHandling"]>["onError"]
  ) => void
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
  /** Shallow-merge a patch into the workflow's run settings. */
  setSettings: (patch: Partial<WorkflowSettings>) => void
  /** Replace the workflow's author-time `variables` map. */
  setVariables: (next: Record<string, string>) => void
  /** Replace the workflow's credential refs map (refs only — never values). */
  setCredentials: (next: Record<string, WorkflowCredentialRef>) => void
  /**
   * Pin a node's output as a test fixture. Honored by editor manual runs
   * ("Run" / "Run this step") so downstream work doesn't re-hit external APIs.
   * Persisted on the `workflows` row via the existing save path (`pinData`).
   */
  pinNodeData: (nodeId: string, value: unknown) => void
  /** Remove a node's pinned fixture. */
  unpinNodeData: (nodeId: string) => void

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
   * Apply a batch of `ProposalOp`s from the workflow copilot in ONE undoable
   * step. The entire batch goes through a single `set()` call so a single
   * Ctrl+Z reverses the whole AI-authored change. Touched nodes are
   * re-validated and merged into `validationByStepId`. Returns the count of
   * applied ops + the first error message if any op was rejected (e.g.,
   * `connect_edge` referencing a node that does not exist).
   */
  applyProposalOps: (ops: ReadonlyArray<ProposalOp>) => { applied: number; firstError?: string }
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
  /**
   * Recompute the full diagnostics result NOW (synchronous) and write it to
   * the store if a cheap signature changed. Returns the (possibly unchanged)
   * result. The save/run gate calls this directly to get a fresh count.
   */
  recomputeDiagnostics: () => DiagnosticsResult
  /**
   * Request a debounced diagnostics recompute. Coalesces a burst of graph
   * mutations (and drag frames) into a single recompute ~300ms after the last
   * change — never per frame. Wired via a store subscription in the factory.
   */
  scheduleDiagnostics: () => void
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

/**
 * The label `addNode` bakes into a freshly-dropped node's `data.label`. This
 * is intentionally the un-localized English/raw value (the store is a plain
 * Zustand store with no access to next-intl) — the canvas renderer detects a
 * still-default label and substitutes the translated `workflows.nodes.<kind>`
 * catalog string. Exported so that comparison stays in one place.
 */
export function defaultLabelFor(kind: WorkflowNodeKind): string {
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

/**
 * Max undo/redo snapshots retained by zundo. Shared between the temporal
 * config and `commitDragHistory` so the drag-coalescing path trims to the
 * same bound (no magic-number drift).
 */
export const EDITOR_HISTORY_LIMIT = 100

/**
 * Debounce window for the diagnostics recompute driver. Long enough that a
 * drag (which fires `setNodes` per frame) only recomputes once after release.
 */
export const DIAGNOSTICS_DEBOUNCE_MS = 300

/**
 * Cheap signature for a `DiagnosticsResult` so `recomputeDiagnostics` can skip
 * a no-op `set()`. Counts + the ordered id list capture every add/remove and
 * cycle-membership change (cycle ids are per-node) without hashing messages.
 */
function diagnosticsSignature(r: DiagnosticsResult): string {
  return `${r.errorCount}:${r.warningCount}:${r.infoCount}:${r.diagnostics.map((d) => d.id).join(",")}`
}

export function createEditorStore(initial: VisualWorkflow): EditorStore {
  const converted = workflowToReactFlow(initial)
  // Pre-drag snapshot held across begin/commit. A factory-closure ref (not
  // store state) so it never triggers a re-render and stays per-editor.
  let dragHistorySnapshot: { nodes: RFWorkflowNode[]; edges: RFWorkflowEdge[] } | null = null
  // Debounce timer for the diagnostics recompute driver — closure-local so it
  // never re-renders and is isolated per editor instance.
  let diagnosticsTimer: ReturnType<typeof setTimeout> | null = null
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
        diagnostics: EMPTY_DIAGNOSTICS,
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
        touchConnect: false,
        pendingConnectFrom: null,
        requestedContextMenu: null,
        requestedRunFromStepId: null,
        requestedRunSingleStepId: null,
        requestedProblemsPanel: false,

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
        setTouchConnect: (v) => set({ touchConnect: v }),
        setPendingConnectFrom: (v) => set({ pendingConnectFrom: v }),
        requestContextMenu: (target, screenAnchor) =>
          set({ requestedContextMenu: { target, screenAnchor } }),
        clearRequestedContextMenu: () => set({ requestedContextMenu: null }),
        requestRunFromStep: (stepId) => set({ requestedRunFromStepId: stepId }),
        clearRequestedRunFromStep: () => set({ requestedRunFromStepId: null }),
        requestRunSingleStep: (stepId) => set({ requestedRunSingleStepId: stepId }),
        clearRequestedRunSingleStep: () => set({ requestedRunSingleStepId: null }),
        requestProblemsPanel: () => set({ requestedProblemsPanel: true }),
        clearRequestedProblemsPanel: () => set({ requestedProblemsPanel: false }),

        setNodes: (nodes) => set({ nodes, dirty: true }),
        setEdges: (edges) => set({ edges, dirty: true }),
        setViewport: (viewport) => set({ viewport, dirty: true }),

        beginDragHistory: () => {
          // Idempotent: overlapping node-drag + selection-drag events must not
          // re-snapshot or re-pause mid-drag.
          if (dragHistorySnapshot) return
          ;(useStore as EditorStore).temporal.getState().pause()
          const { nodes, edges } = get()
          dragHistorySnapshot = { nodes, edges }
        },
        commitDragHistory: () => {
          const snap = dragHistorySnapshot
          dragHistorySnapshot = null
          const temporalStore = (useStore as EditorStore).temporal
          temporalStore.getState().resume()
          if (!snap) return
          const cur = get()
          // No-op drag (click without move): the arrays keep their identity
          // because no `setNodes`/`setEdges` ran, so skip — mirrors the
          // temporal `equality` guard below.
          if (snap.nodes === cur.nodes && snap.edges === cur.edges) return
          const past = temporalStore.getState().pastStates.concat({
            nodes: snap.nodes,
            edges: snap.edges,
          })
          while (past.length > EDITOR_HISTORY_LIMIT) past.shift()
          temporalStore.setState({ pastStates: past, futureStates: [] })
        },

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
              // New nodes author at the kind's current generation (e.g.
              // branch/switch v2 structured conditions); loaded graphs keep
              // their stored version.
              typeVersion: defaultTypeVersionFor(kind),
            },
          }
          set({ nodes: [...get().nodes, node], dirty: true })
          return id
        },

        insertNodeOnEdge: (edgeId, kind, position, overrides) => {
          const { nodes, edges, baseWorkflow } = get()
          const edge = edges.find((e) => e.id === edgeId)
          if (!edge) return null
          const newId = "n_" + nanoid(8)
          const newNode: RFWorkflowNode = {
            id: newId,
            type: "workflowNode",
            position,
            data: {
              label: overrides?.label ?? defaultLabelFor(kind),
              params: overrides?.params ?? {},
              notes: overrides?.notes,
              credentialRefs: overrides?.credentialRefs,
              disabled: overrides?.disabled,
              authoredBy: overrides?.authoredBy,
              kind,
              typeVersion: defaultTypeVersionFor(kind),
            },
          }
          const { upstream, downstream } = computeSplitEdges(
            {
              source: edge.source,
              target: edge.target,
              sourceHandle: edge.sourceHandle,
              targetHandle: edge.targetHandle,
            },
            newId
          )
          // Validate both replacement connections against the graph WITH the
          // new node present; bail atomically if either is illegal.
          const candidateNodes = [...nodes, newNode]
          const otherEdges = edges.filter((e) => e.id !== edgeId)
          const opts = { errorPolicy: baseWorkflow.settings.errorPolicy }
          if (
            !validateConnection(upstream, candidateNodes, otherEdges, opts).valid ||
            !validateConnection(downstream, candidateNodes, otherEdges, opts).valid
          ) {
            return null
          }
          const upstreamEdge: RFWorkflowEdge = {
            id: "e_" + nanoid(8),
            source: upstream.source,
            target: upstream.target,
            sourceHandle: upstream.sourceHandle,
            type: "default",
          }
          const downstreamEdge: RFWorkflowEdge = {
            id: "e_" + nanoid(8),
            source: downstream.source,
            target: downstream.target,
            targetHandle: downstream.targetHandle,
            type: "default",
          }
          set({
            nodes: candidateNodes,
            edges: [...otherEdges, upstreamEdge, downstreamEdge],
            selectedNodeIds: [newId],
            dirty: true,
          })
          return newId
        },

        addNodeConnected: (kind, position, from) => {
          const { nodes, edges, baseWorkflow } = get()
          const newId = "n_" + nanoid(8)
          const newNode: RFWorkflowNode = {
            id: newId,
            type: "workflowNode",
            position,
            data: {
              label: defaultLabelFor(kind),
              params: {},
              kind,
              typeVersion: defaultTypeVersionFor(kind),
            },
          }
          const params = {
            source: from.sourceId,
            target: newId,
            sourceHandle: from.sourceHandle ?? undefined,
          }
          if (
            !validateConnection(params, [...nodes, newNode], edges, {
              errorPolicy: baseWorkflow.settings.errorPolicy,
            }).valid
          ) {
            return null
          }
          const newEdge: RFWorkflowEdge = {
            id: "e_" + nanoid(8),
            source: from.sourceId,
            target: newId,
            sourceHandle: from.sourceHandle ?? undefined,
            type: "default",
          }
          set({
            nodes: [...nodes, newNode],
            edges: [...edges, newEdge],
            selectedNodeIds: [newId],
            dirty: true,
          })
          return newId
        },

        replaceSelectionWithNode: (selectedIds, replacement, rewires) => {
          const { nodes, edges } = get()
          // Cascade: removing a selected loop container also removes its body.
          const removed = new Set(selectedIds)
          let grew = true
          while (grew) {
            grew = false
            for (const n of nodes) {
              if (n.parentId && removed.has(n.parentId) && !removed.has(n.id)) {
                removed.add(n.id)
                grew = true
              }
            }
          }
          const newId = "n_" + nanoid(8)
          const newNode: RFWorkflowNode = {
            id: newId,
            type: "workflowNode",
            position: replacement.position,
            data: {
              label: replacement.label ?? defaultLabelFor(replacement.kind),
              params: replacement.params,
              kind: replacement.kind,
              typeVersion: defaultTypeVersionFor(replacement.kind),
            },
          }
          const keptNodes = nodes.filter((n) => !removed.has(n.id))
          // Drop every edge touching a removed node; boundary edges are re-added rewired.
          const keptEdges = edges.filter((e) => !removed.has(e.source) && !removed.has(e.target))
          const seenIn = new Set<string>()
          const inboundEdges: RFWorkflowEdge[] = []
          for (const r of rewires.inbound) {
            const key = `${r.source} ${r.sourceHandle ?? ""}`
            if (seenIn.has(key)) continue
            seenIn.add(key)
            inboundEdges.push({
              id: "e_" + nanoid(8),
              source: r.source,
              target: newId,
              sourceHandle: r.sourceHandle,
              type: "default",
            })
          }
          const seenOut = new Set<string>()
          const outboundEdges: RFWorkflowEdge[] = []
          for (const r of rewires.outbound) {
            const key = `${r.target} ${r.targetHandle ?? ""}`
            if (seenOut.has(key)) continue
            seenOut.add(key)
            outboundEdges.push({
              id: "e_" + nanoid(8),
              source: newId,
              target: r.target,
              targetHandle: r.targetHandle,
              type: "default",
            })
          }
          set({
            nodes: [...keptNodes, newNode],
            edges: [...keptEdges, ...inboundEdges, ...outboundEdges],
            selectedNodeIds: [newId],
            dirty: true,
          })
          return newId
        },

        removeNodes: (ids) => {
          // Deleting a loop container cascades to its body children (the
          // confirm dialog lives in the UI layer; the store just executes).
          const idSet = new Set(ids)
          let grew = true
          while (grew) {
            grew = false
            for (const n of get().nodes) {
              if (n.parentId && idSet.has(n.parentId) && !idSet.has(n.id)) {
                idSet.add(n.id)
                grew = true
              }
            }
          }
          set({
            nodes: get().nodes.filter((n) => !idSet.has(n.id)),
            edges: get().edges.filter((e) => !idSet.has(e.source) && !idSet.has(e.target)),
            selectedNodeIds: get().selectedNodeIds.filter((id) => !idSet.has(id)),
            dirty: true,
          })
        },

        setNodeParent: (nodeId, parentId) => {
          const nodes = get().nodes
          const node = nodes.find((n) => n.id === nodeId)
          if (!node) return
          if (parentId === (node.parentId ?? null)) return
          if (parentId !== null) {
            if (parentId === nodeId) return
            const parent = nodes.find((n) => n.id === parentId)
            // Only containers host children: loop containers (flow.loop v2) and
            // group frames (annotation.group v2). Refuse cycles through the
            // node's own descendants.
            const parentKind = parent?.data.kind
            const isContainerParent =
              !!parent &&
              (parentKind === "flow.loop" || parentKind === "annotation.group") &&
              parent.data.typeVersion >= 2
            if (!isContainerParent) return
            let cur: typeof parent | undefined = parent
            while (cur?.parentId) {
              if (cur.parentId === nodeId) return
              cur = nodes.find((n) => n.id === cur!.parentId)
            }
          }
          // Convert coordinates so the node stays visually in place: child
          // positions are parent-relative in React Flow v12.
          const absOf = (id: string | undefined): { x: number; y: number } => {
            let x = 0
            let y = 0
            let cur = id ? nodes.find((n) => n.id === id) : undefined
            while (cur) {
              x += cur.position.x
              y += cur.position.y
              cur = cur.parentId ? nodes.find((n) => n.id === cur!.parentId) : undefined
            }
            return { x, y }
          }
          const oldBase = absOf(node.parentId)
          const abs = { x: oldBase.x + node.position.x, y: oldBase.y + node.position.y }
          const newBase = parentId ? absOf(parentId) : { x: 0, y: 0 }
          const position = { x: abs.x - newBase.x, y: abs.y - newBase.y }
          let next = nodes.map((n) => {
            if (n.id !== nodeId) return n
            if (parentId === null) {
              const { parentId: _drop, extent: _dropExtent, ...rest } = n
              return { ...rest, position }
            }
            return { ...n, parentId, extent: "parent" as const, position }
          })
          // React Flow v12 requires parents BEFORE children in the array —
          // move the re-parented node right after its container if needed.
          if (parentId !== null) {
            const childIdx = next.findIndex((n) => n.id === nodeId)
            const parentIdx = next.findIndex((n) => n.id === parentId)
            if (childIdx >= 0 && parentIdx > childIdx) {
              const [child] = next.splice(childIdx, 1)
              next = [...next.slice(0, parentIdx), child, ...next.slice(parentIdx)]
            }
          }
          set({ nodes: next, dirty: true })
        },

        updateNodeData: (id, patch) => {
          set({
            nodes: get().nodes.map((n) =>
              n.id === id ? { ...n, data: { ...n.data, ...patch } } : n
            ),
            dirty: true,
          })
        },

        updateNodeDataBatch: (ids, patch) => {
          if (ids.length === 0) return
          const idSet = new Set(ids)
          set({
            nodes: get().nodes.map((n) =>
              idSet.has(n.id) ? { ...n, data: { ...n.data, ...patch } } : n
            ),
            dirty: true,
          })
        },

        setBulkOnError: (ids, onError) => {
          if (ids.length === 0) return
          const idSet = new Set(ids)
          set({
            nodes: get().nodes.map((n) => {
              if (!idSet.has(n.id)) return n
              const eh = { ...(n.data.errorHandling ?? {}) }
              if (onError === "fail") delete eh.onError
              else eh.onError = onError
              const nextEh = Object.keys(eh).length > 0 ? eh : undefined
              return { ...n, data: { ...n.data, errorHandling: nextEh } }
            }),
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
        setSettings: (patch) =>
          set((s) => ({
            baseWorkflow: {
              ...s.baseWorkflow,
              settings: { ...s.baseWorkflow.settings, ...patch },
            },
            dirty: true,
          })),
        setVariables: (next) =>
          set((s) => ({
            baseWorkflow: { ...s.baseWorkflow, variables: next },
            dirty: true,
          })),
        setCredentials: (next) =>
          set((s) => ({
            baseWorkflow: { ...s.baseWorkflow, credentials: next },
            dirty: true,
          })),
        pinNodeData: (nodeId, value) =>
          set((s) => ({
            baseWorkflow: {
              ...s.baseWorkflow,
              pinData: { ...s.baseWorkflow.pinData, [nodeId]: value },
            },
            dirty: true,
          })),
        unpinNodeData: (nodeId) =>
          set((s) => {
            const pin = s.baseWorkflow.pinData
            if (!pin || !(nodeId in pin)) return {}
            const nextPin = { ...pin }
            delete nextPin[nodeId]
            return { baseWorkflow: { ...s.baseWorkflow, pinData: nextPin }, dirty: true }
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

        applyProposalOps: (ops) => {
          if (!ops || ops.length === 0) return { applied: 0 }
          perfMark("apply-start")
          // Compute terminal nodes/edges + validation map locally so the
          // whole batch lands in a single set() call — that's what makes
          // zundo collapse the batch into one undo entry.
          const startNodes = get().nodes
          const startEdges = get().edges
          const startValidation = get().validationByStepId

          const nodeById = new Map(startNodes.map((n) => [n.id, n]))
          const edgeById = new Map(startEdges.map((e) => [e.id, e]))
          // Track ids touched so we know which nodes to re-validate.
          const touchedNodeIds = new Set<string>()
          let firstError: string | undefined
          let applied = 0

          for (let i = 0; i < ops.length; i++) {
            const op = ops[i]
            switch (op.type) {
              case "add_node": {
                if (nodeById.has(op.nodeId)) {
                  firstError = firstError ?? `op ${i}: node id "${op.nodeId}" already exists`
                  continue
                }
                const data: RFWorkflowNode["data"] = {
                  label: (op.data?.label as string | undefined) ?? defaultLabelFor(op.kind),
                  params: (op.data?.params as Record<string, unknown> | undefined) ?? {},
                  notes: op.data?.notes,
                  credentialRefs: op.data?.credentialRefs as Record<string, string> | undefined,
                  disabled: op.data?.disabled as boolean | undefined,
                  authoredBy: (op.data?.authoredBy as "ai" | "user" | undefined) ?? "ai",
                  kind: op.kind,
                  typeVersion: 1,
                }
                nodeById.set(op.nodeId, {
                  id: op.nodeId,
                  type: "workflowNode",
                  position: op.position,
                  data,
                })
                touchedNodeIds.add(op.nodeId)
                applied++
                break
              }
              case "remove_node": {
                if (!nodeById.has(op.nodeId)) {
                  firstError = firstError ?? `op ${i}: node id "${op.nodeId}" does not exist`
                  continue
                }
                nodeById.delete(op.nodeId)
                // drop incident edges
                for (const [eid, e] of edgeById) {
                  if (e.source === op.nodeId || e.target === op.nodeId) {
                    edgeById.delete(eid)
                  }
                }
                touchedNodeIds.delete(op.nodeId)
                applied++
                break
              }
              case "connect_edge": {
                if (edgeById.has(op.edgeId)) {
                  firstError = firstError ?? `op ${i}: edge id "${op.edgeId}" already exists`
                  continue
                }
                if (!nodeById.has(op.source)) {
                  firstError =
                    firstError ?? `op ${i}: connect_edge source "${op.source}" does not exist`
                  continue
                }
                if (!nodeById.has(op.target)) {
                  firstError =
                    firstError ?? `op ${i}: connect_edge target "${op.target}" does not exist`
                  continue
                }
                const data =
                  typeof op.label === "string" && op.label.length > 0
                    ? { label: op.label }
                    : undefined
                edgeById.set(op.edgeId, {
                  id: op.edgeId,
                  source: op.source,
                  target: op.target,
                  sourceHandle: op.sourceHandle,
                  targetHandle: op.targetHandle,
                  type: "default",
                  ...(data ? { data } : {}),
                })
                applied++
                break
              }
              case "disconnect_edge": {
                if (!edgeById.has(op.edgeId)) {
                  firstError = firstError ?? `op ${i}: edge id "${op.edgeId}" does not exist`
                  continue
                }
                edgeById.delete(op.edgeId)
                applied++
                break
              }
              case "configure_node": {
                const node = nodeById.get(op.nodeId)
                if (!node) {
                  firstError = firstError ?? `op ${i}: node id "${op.nodeId}" does not exist`
                  continue
                }
                // Stamp authoredBy: "ai" by default on patches so the
                // touched node carries provenance even if the agent forgot.
                const patchWithProvenance: Partial<WorkflowNodeData> = {
                  authoredBy: "ai",
                  ...op.patch,
                }
                nodeById.set(op.nodeId, {
                  ...node,
                  data: { ...node.data, ...patchWithProvenance },
                })
                touchedNodeIds.add(op.nodeId)
                applied++
                break
              }
            }
          }

          // Re-validate every touched node and merge into the validation map.
          const nextValidation: Record<string, NodeValidationResult> = { ...startValidation }
          for (const id of touchedNodeIds) {
            const node = nodeById.get(id)
            if (!node) {
              delete nextValidation[id]
              continue
            }
            const result = validateNodeParams(
              node.data.kind as WorkflowNodeKind,
              (node.data.params as Record<string, unknown> | undefined) ?? {}
            )
            if (result.hasErrors) nextValidation[id] = result
            else delete nextValidation[id]
          }
          // Also prune validation entries for nodes that were removed by
          // this batch (whose ids never made it into touchedNodeIds).
          for (const id of Object.keys(startValidation)) {
            if (!nodeById.has(id)) delete nextValidation[id]
          }

          const nextNodes = Array.from(nodeById.values())
          const nextEdges = Array.from(edgeById.values())
          const nextSelectedNodes = get().selectedNodeIds.filter((id) => nodeById.has(id))
          const nextSelectedEdges = get().selectedEdgeIds.filter((id) => edgeById.has(id))
          set({
            nodes: nextNodes,
            edges: nextEdges,
            selectedNodeIds: nextSelectedNodes,
            selectedEdgeIds: nextSelectedEdges,
            validationByStepId: nextValidation,
            dirty: true,
          })
          perfMark("apply-end")
          return firstError ? { applied, firstError } : { applied }
        },

        groupSelected: (ids) => {
          if (ids.length === 0) return null
          const { nodes } = get()
          const bounds = selectionBounds(nodes, ids)
          if (!bounds) return null
          const padding = 32
          const id = "n_" + nanoid(8)
          const width = bounds.width + padding * 2
          const height = bounds.height + padding * 2.25
          const groupPos = { x: bounds.x - padding, y: bounds.y - padding * 1.5 }
          const group: RFWorkflowNode = {
            id,
            // typeVersion 2 renders as a real container (group-container-node)
            // that hosts its members as React Flow children.
            type: "groupContainer",
            position: groupPos,
            width,
            height,
            data: {
              label: "Group",
              kind: "annotation.group",
              typeVersion: 2,
              params: { title: "Group", width, height },
            },
          }
          const memberSet = new Set(ids)
          // Re-parent currently top-level members into the group, converting
          // their positions to parent-relative so they stay visually in place.
          // Members that already have a parent (e.g., inside a loop) are left
          // alone — a node can only live in one container.
          const reparented = nodes.map((n) => {
            if (n.id === id || !memberSet.has(n.id) || n.parentId) return n
            return {
              ...n,
              parentId: id,
              extent: "parent" as const,
              position: { x: n.position.x - groupPos.x, y: n.position.y - groupPos.y },
            }
          })
          set({
            // Group goes FIRST so React Flow paints it under its members and
            // (v12 requirement) the parent precedes its children in the array.
            nodes: [group, ...reparented],
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
        recomputeDiagnostics: () => {
          const workflow = get().toWorkflow()
          const result = runDiagnostics({ workflow, isWeb: !isTauri() })
          const prev = get().diagnostics
          if (diagnosticsSignature(prev) === diagnosticsSignature(result)) return prev
          set({ diagnostics: result })
          return result
        },
        scheduleDiagnostics: () => {
          if (diagnosticsTimer) clearTimeout(diagnosticsTimer)
          diagnosticsTimer = setTimeout(() => {
            diagnosticsTimer = null
            get().recomputeDiagnostics()
          }, DIAGNOSTICS_DEBOUNCE_MS)
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
        limit: EDITOR_HISTORY_LIMIT,
      }
    )
  ) as EditorStore

  // Single recompute driver: whenever the graph shape (nodes/edges identity)
  // changes — via any mutator OR a React Flow change — schedule a debounced
  // diagnostics recompute. One choke point, no per-mutator wiring, and it only
  // resets a timer per drag frame (cheap), never recomputes inline. Writing
  // `diagnostics` itself doesn't touch nodes/edges, so there is no feedback loop.
  let lastNodes = useStore.getState().nodes
  let lastEdges = useStore.getState().edges
  useStore.subscribe((state) => {
    if (state.nodes !== lastNodes || state.edges !== lastEdges) {
      lastNodes = state.nodes
      lastEdges = state.edges
      state.scheduleDiagnostics()
    }
  })
  // Seed the initial result so the Problems panel / badges are correct on open.
  useStore.getState().recomputeDiagnostics()

  return useStore
}
