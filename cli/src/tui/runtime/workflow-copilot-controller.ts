/**
 * Workflow Copilot controller — the CLI bridge that lets the TUI create and edit
 * visual workflows through the SAME copilot agent + proposal contract the
 * desktop editor uses. It owns only the HEADLESS half (Dexie CRUD, the
 * out-of-React editor-store registry, the proposal store, plugin activation) and
 * dispatches `COPILOT_*` actions; driving the actual LLM turns stays in
 * `useAgentSession` (a dedicated `workflow-editor`-kind session), and the
 * Apply/Discard decision rides the existing `confirm` overlay.
 *
 * Reuse, don't reimplement: `createEditorStore` + `registerEditorStore` give the
 * `wf_*` plugin tools (host-routed back into this process) a store to read and
 * propose against; `useProposalStore` holds staged batches; `applyProposalOps` +
 * `replaceWorkflow` are the desktop's own apply+persist path.
 */
import { createWorkflow, getWorkflow, replaceWorkflow } from "@/lib/db/workflows"
import { createEditorStore, type EditorStore } from "@/lib/workflow/editor/store"
import {
  getEditorStore,
  registerEditorStore,
  unregisterEditorStore,
} from "@/lib/workflow/editor/store-registry"
import { useProposalStore } from "@/lib/workflow/editor/proposal-store"
import type { ProposalOp } from "@/lib/workflow/editor/proposal-types"
import type { VisualWorkflow, WorkflowRow } from "@/types/workflow/visual"

import { ensureCliDb } from "../../db/bootstrap"
import { ensurePluginRuntime } from "../../plugin/plugin-runtime"
import { errorMessage } from "./shared"
import { buildProposalDoc, type ProjectEdge } from "./workflow-proposal-doc"
import type { DagNodeLike } from "./workflow-dag"
import type { TuiAction } from "../state/types"

/** Plugin id of the in-tree workflow-ai plugin (its `wf_*` tools back the copilot). */
export const WORKFLOW_AI_PLUGIN_ID = "cognia-workflow-ai"

/** Narrow view of the editor store the controller drives (eases test doubles). */
interface EditorStoreLike {
  getState: () => {
    nodes: ReadonlyArray<{ id: string; data?: { kind?: string; label?: string } }>
    edges: ReadonlyArray<{ id: string; source: string; target: string }>
    dirty: boolean
    applyProposalOps: (ops: ReadonlyArray<ProposalOp>) => { applied: number; firstError?: string }
    toWorkflow: () => VisualWorkflow
    markSaved: () => void
  }
}

/** Narrow view of the proposal store the controller reads/mutates. */
interface ProposalStoreLike {
  getState: () => {
    entries: Record<
      string,
      { open?: { proposalId: string; summary: string; ops: ReadonlyArray<ProposalOp> } }
    >
    markApplied: (workflowId: string) => void
    discardProposal: (workflowId: string) => void
  }
}

export interface CopilotDeps {
  dispatch: (action: TuiAction) => void
  /** Open the CLI-local Dexie (+ shims) before any workflow CRUD. */
  ensureDb?: () => Promise<unknown>
  /** Persist a brand-new empty workflow row. */
  create?: (draft: { name: string }) => Promise<WorkflowRow>
  /** Load a workflow row by id. */
  get?: (id: string) => Promise<WorkflowRow | undefined>
  /** Replace a workflow row on save/apply. */
  replace?: (workflow: VisualWorkflow) => Promise<void>
  /** Build an editor store for a freshly loaded workflow. */
  createStore?: (initial: VisualWorkflow) => EditorStore
  register?: (workflowId: string, store: EditorStore) => void
  unregister?: (workflowId: string) => void
  getStore?: (workflowId: string) => EditorStoreLike | null
  /** The staged-proposal store (defaults to the shared singleton). */
  proposals?: ProposalStoreLike
  /** Load the in-tree plugin runtime + enable workflow-ai so `wf_*` tools surface. */
  ensurePlugin?: () => Promise<void>
}

const dbOf = (d: CopilotDeps) => d.ensureDb ?? (() => ensureCliDb())
const createOf = (d: CopilotDeps) => d.create ?? createWorkflow
const getOf = (d: CopilotDeps) => d.get ?? getWorkflow
const replaceOf = (d: CopilotDeps) => d.replace ?? replaceWorkflow
const createStoreOf = (d: CopilotDeps) => d.createStore ?? createEditorStore
const registerOf = (d: CopilotDeps) => d.register ?? registerEditorStore
const unregisterOf = (d: CopilotDeps) => d.unregister ?? unregisterEditorStore
const getStoreOf = (d: CopilotDeps) =>
  d.getStore ?? ((id: string) => getEditorStore(id) as EditorStoreLike | null)
const proposalsOf = (d: CopilotDeps): ProposalStoreLike =>
  d.proposals ?? (useProposalStore as unknown as ProposalStoreLike)
const ensurePluginOf = (d: CopilotDeps) => d.ensurePlugin ?? defaultEnsurePlugin

/** Default plugin activation: load the runtime once, then enable workflow-ai. */
async function defaultEnsurePlugin(): Promise<void> {
  await ensurePluginRuntime()
  try {
    const { usePluginStore } = await import("@/stores/plugin-runtime")
    const store = usePluginStore.getState() as {
      plugins: Record<string, { status: string }>
      setPluginStatus: (id: string, status: "enabled" | "disabled") => void
    }
    if (store.plugins[WORKFLOW_AI_PLUGIN_ID]?.status !== "enabled") {
      store.setPluginStatus(WORKFLOW_AI_PLUGIN_ID, "enabled")
    }
  } catch {
    // Best-effort — if the plugin store can't be reached the copilot still runs;
    // the agent just won't have the wf_* tools (it will say it cannot edit).
  }
}

/** Project the live editor graph into the DAG/proposal-doc node & edge shapes. */
function snapshotGraph(store: EditorStoreLike | null): {
  nodes: DagNodeLike[]
  edges: ProjectEdge[]
} {
  if (!store) return { nodes: [], edges: [] }
  const s = store.getState()
  const nodes: DagNodeLike[] = s.nodes.map((n) => ({
    id: n.id,
    type: n.data?.kind ?? "annotation.note",
    ...(n.data?.label ? { data: { label: n.data.label } } : {}),
  }))
  const edges: ProjectEdge[] = s.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
  }))
  return { nodes, edges }
}

/** `/workflow create [name]` — start a new draft and enter copilot mode. */
export async function copilotCreate(name: string, deps: CopilotDeps): Promise<void> {
  await dbOf(deps)()
  let row: WorkflowRow
  try {
    row = await createOf(deps)({ name: name.trim() || "Untitled workflow" })
  } catch (err) {
    deps.dispatch({ type: "NOTICE", message: `Could not create workflow: ${errorMessage(err)}` })
    return
  }
  registerOf(deps)(row.id, createStoreOf(deps)(row))
  await ensurePluginOf(deps)()
  deps.dispatch({ type: "COPILOT_ENTER", workflowId: row.id, name: row.name, isNew: true })
  deps.dispatch({
    type: "NOTICE",
    message: `Workflow copilot · "${row.name}" — describe the workflow you want and I'll propose it. /workflow exit to leave.`,
  })
}

/** `/workflow edit <id>` — open an existing workflow in copilot mode. */
export async function copilotEdit(id: string, deps: CopilotDeps): Promise<void> {
  if (!id.trim()) {
    deps.dispatch({ type: "NOTICE", message: "Usage: /workflow edit <id>" })
    return
  }
  await dbOf(deps)()
  const row = await getOf(deps)(id.trim())
  if (!row) {
    deps.dispatch({ type: "NOTICE", message: `Workflow ${id} not found.` })
    return
  }
  registerOf(deps)(row.id, createStoreOf(deps)(row))
  await ensurePluginOf(deps)()
  deps.dispatch({ type: "COPILOT_ENTER", workflowId: row.id, name: row.name, isNew: false })
  deps.dispatch({
    type: "NOTICE",
    message: `Workflow copilot · editing "${row.name}". /workflow exit to leave.`,
  })
}

/**
 * After a copilot turn, surface any newly-staged proposal as an Apply/Discard
 * confirm overlay. No-op when the turn produced no proposal.
 */
export function copilotCheckProposal(workflowId: string, deps: CopilotDeps): void {
  const open = proposalsOf(deps).getState().entries[workflowId]?.open
  if (!open) return
  const { nodes, edges } = snapshotGraph(getStoreOf(deps)(workflowId))
  const body = buildProposalDoc({ summary: open.summary, ops: open.ops, nodes, edges })
  deps.dispatch({ type: "COPILOT_SET_PROPOSAL", proposalId: open.proposalId })
  deps.dispatch({
    type: "OVERLAY_OPEN",
    overlay: {
      kind: "confirm",
      title: "Apply workflow proposal?",
      body,
      format: "markdown",
      onConfirmCommand: "workflow apply",
      onCancelCommand: "workflow discard",
    },
  })
}

/** Apply the open proposal to the draft and persist it to Dexie. */
export async function copilotApply(workflowId: string, deps: CopilotDeps): Promise<void> {
  const store = getStoreOf(deps)(workflowId)
  const open = proposalsOf(deps).getState().entries[workflowId]?.open
  if (!store || !open) {
    deps.dispatch({ type: "NOTICE", message: "No proposal to apply." })
    deps.dispatch({ type: "COPILOT_CLEAR_PROPOSAL" })
    return
  }
  const result = store.getState().applyProposalOps(open.ops)
  if (result.firstError) {
    deps.dispatch({ type: "NOTICE", message: `Proposal failed: ${result.firstError}` })
    return
  }
  try {
    await replaceOf(deps)(store.getState().toWorkflow())
  } catch (err) {
    deps.dispatch({ type: "NOTICE", message: `Could not save workflow: ${errorMessage(err)}` })
    return
  }
  proposalsOf(deps).getState().markApplied(workflowId)
  store.getState().markSaved()
  deps.dispatch({ type: "COPILOT_CLEAR_PROPOSAL" })
  deps.dispatch({ type: "NOTICE", message: `Applied ${result.applied} change(s) and saved.` })
}

/** Discard the open proposal without touching the draft. */
export function copilotDiscard(workflowId: string, deps: CopilotDeps): void {
  proposalsOf(deps).getState().discardProposal(workflowId)
  deps.dispatch({ type: "COPILOT_CLEAR_PROPOSAL" })
  deps.dispatch({ type: "NOTICE", message: "Proposal discarded." })
}

/** `/workflow save` — persist the current draft without leaving copilot mode. */
export async function copilotSave(workflowId: string, deps: CopilotDeps): Promise<void> {
  const store = getStoreOf(deps)(workflowId)
  if (!store) {
    deps.dispatch({ type: "NOTICE", message: "No workflow open." })
    return
  }
  try {
    await replaceOf(deps)(store.getState().toWorkflow())
    store.getState().markSaved()
    deps.dispatch({ type: "NOTICE", message: "Workflow saved." })
  } catch (err) {
    deps.dispatch({ type: "NOTICE", message: `Could not save workflow: ${errorMessage(err)}` })
  }
}

/** `/workflow exit` — save any pending changes, tear down, and leave copilot mode. */
export async function copilotExit(workflowId: string, deps: CopilotDeps): Promise<void> {
  const store = getStoreOf(deps)(workflowId)
  if (store?.getState().dirty) {
    try {
      await replaceOf(deps)(store.getState().toWorkflow())
      store.getState().markSaved()
    } catch (err) {
      deps.dispatch({
        type: "NOTICE",
        message: `Exited without saving (save failed: ${errorMessage(err)}).`,
      })
    }
  }
  unregisterOf(deps)(workflowId)
  deps.dispatch({ type: "COPILOT_EXIT" })
  deps.dispatch({ type: "NOTICE", message: "Left workflow copilot." })
}
