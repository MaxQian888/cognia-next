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
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeData,
  WorkflowNodeKind,
} from "@/types/workflow/visual"
import {
  reactFlowToWorkflow,
  workflowToReactFlow,
  type RFWorkflowEdge,
  type RFWorkflowNode,
} from "./react-flow-converter"

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

export interface EditorState extends EditorStateSnapshot {
  /** The persisted workflow envelope; `nodes`/`edges`/`viewport` live above. */
  baseWorkflow: VisualWorkflow
  selectedNodeIds: string[]
  selectedEdgeIds: string[]
  dirty: boolean
  savedAt: number | null
  /** Per-stepId live execution status, keyed by node id. */
  runStatusByStepId: Record<string, NodeRunStatus>
  /** Per-node validation errors surfaced from the inspector / save path. */
  validationByStepId: Record<string, string[]>

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

  // ── runtime status (not undoable) ────────────────────────────────────────
  setRunStatus: (stepId: string, status: NodeRunStatus) => void
  setRunStatusBatch: (entries: Record<string, NodeRunStatus>) => void
  clearRunStatus: () => void
  setValidation: (stepId: string, errors: string[]) => void
  clearValidation: () => void
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

        setRunStatus: (stepId, status) =>
          set({
            runStatusByStepId: { ...get().runStatusByStepId, [stepId]: status },
          }),
        setRunStatusBatch: (entries) =>
          set({ runStatusByStepId: { ...get().runStatusByStepId, ...entries } }),
        clearRunStatus: () => set({ runStatusByStepId: {} }),

        setValidation: (stepId, errors) =>
          set({
            validationByStepId: { ...get().validationByStepId, [stepId]: errors },
          }),
        clearValidation: () => set({ validationByStepId: {} }),
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
