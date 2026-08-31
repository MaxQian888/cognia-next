/**
 * Workflow-AI plugin — shared store resolution for tool handlers.
 *
 * Plugin tool handlers run outside React (they fire from a stdio callback
 * dispatched by the sidecar's `cognia-plugin-tools` MCP server). They
 * reach the per-editor Zustand store via the renderer-side registry
 * mounted by `EditorStoreProvider` (see `lib/workflow/editor/store-registry.ts`).
 *
 * Resolution rules:
 *   • If the tool input includes `workflowId`, use that.
 *   • Else if exactly ONE editor is currently open, target that one.
 *   • Else fail with `EditorNotOpenError("ambiguous")` — the agent must
 *     pick a workflow before issuing graph-mutating calls.
 *
 * All write tools that mutate the graph go through the store's existing
 * undoable actions so manual edits and AI edits share one history stack.
 */

import type { PluginContext, WorkflowNodeData, WorkflowNodeKind } from "@cognia/plugin-sdk"
import type {
  PluginWorkflowEditorSnapshot,
  PluginWorkflowEditorMutationResult,
} from "@cognia/plugin-sdk/context"
import type { ProposalOp } from "@cognia/plugin-sdk/api/workflow-editor"

type WorkflowApi = PluginContext["workflow"]

let activeWorkflowApi: WorkflowApi | undefined

export function configureWorkflowApi(api: WorkflowApi): void {
  activeWorkflowApi = api
}

export function clearWorkflowApi(): void {
  activeWorkflowApi = undefined
}

export function getWorkflowApi(): WorkflowApi {
  if (!activeWorkflowApi)
    throw new Error("Workflow API is unavailable because the plugin is inactive.")
  return activeWorkflowApi
}

type EditorSnapshot = PluginWorkflowEditorSnapshot

interface EditorStateFacade extends EditorSnapshot {
  addNode(
    kind: WorkflowNodeKind,
    position: { x: number; y: number },
    overrides?: Partial<WorkflowNodeData>
  ): string
  removeNodes(ids: string[]): void
  removeEdges(ids: string[]): void
  connect(input: {
    source: string
    target: string
    sourceHandle?: string
    targetHandle?: string
  }): string | null
  updateEdgeData(id: string, patch: Record<string, unknown>): boolean
  updateNodeData(id: string, patch: Partial<WorkflowNodeData>): void
  revalidateNode(
    id: string
  ): Extract<PluginWorkflowEditorMutationResult, { kind: "revalidate-node" }>["validation"]
  applyProposalOps(
    ops: ReadonlyArray<ProposalOp>
  ): Extract<PluginWorkflowEditorMutationResult, { kind: "apply-proposal" }>
  setNodes(nodes: EditorSnapshot["nodes"]): void
  groupSelected(ids: string[]): string | null
  setSelectedNodes(ids: string[]): void
  setViewport(viewport: EditorSnapshot["viewport"]): void
  pulseNode(id: string, durationMs: number): void
  toWorkflow(): EditorSnapshot["workflow"]
}

interface EditorStoreFacade {
  getState(): EditorStateFacade
}

function mutation<TKind extends PluginWorkflowEditorMutationResult["kind"]>(
  workflowId: string,
  command: Parameters<WorkflowApi["mutateEditor"]>[1],
  kind: TKind
): Extract<PluginWorkflowEditorMutationResult, { kind: TKind }> {
  const result = getWorkflowApi().mutateEditor(workflowId, command)
  if (result.kind !== kind) throw new Error(`Unexpected workflow mutation result: ${result.kind}`)
  return result as Extract<PluginWorkflowEditorMutationResult, { kind: TKind }>
}

function editorStore(editor: EditorSnapshot): EditorStoreFacade {
  const workflowId = editor.workflowId
  return {
    getState: () => {
      const resolved = getWorkflowApi().resolveEditor(workflowId)
      if (!resolved.ok) throw new EditorNotOpenError({ kind: "not-open", requestedId: workflowId })
      const snapshot = resolved.editor
      return {
        ...snapshot,
        addNode: (kind, position, overrides) =>
          mutation(
            workflowId,
            { kind: "add-node", nodeKind: kind, position, overrides },
            "add-node"
          ).nodeId,
        removeNodes: (ids) => {
          mutation(workflowId, { kind: "remove-nodes", ids }, "remove-nodes")
        },
        removeEdges: (ids) => {
          mutation(workflowId, { kind: "remove-edges", ids }, "remove-edges")
        },
        connect: (input) => mutation(workflowId, { kind: "connect", ...input }, "connect").edgeId,
        updateEdgeData: (id, patch) =>
          mutation(workflowId, { kind: "update-edge", id, patch }, "update-edge").updated,
        updateNodeData: (id, patch) => {
          mutation(workflowId, { kind: "update-node", id, patch }, "update-node")
        },
        revalidateNode: (id) =>
          mutation(workflowId, { kind: "revalidate-node", id }, "revalidate-node").validation,
        applyProposalOps: (ops) =>
          mutation(workflowId, { kind: "apply-proposal", ops }, "apply-proposal"),
        setNodes: (nodes) => {
          mutation(workflowId, { kind: "set-nodes", nodes }, "set-nodes")
        },
        groupSelected: (ids) =>
          mutation(workflowId, { kind: "group-nodes", ids }, "group-nodes").groupId,
        setSelectedNodes: (ids) => {
          mutation(workflowId, { kind: "select-nodes", ids }, "select-nodes")
        },
        setViewport: (viewport) => {
          mutation(workflowId, { kind: "set-viewport", viewport }, "set-viewport")
        },
        pulseNode: (id, durationMs) => {
          mutation(workflowId, { kind: "pulse-node", id, durationMs }, "pulse-node")
        },
        toWorkflow: () => snapshot.workflow,
      }
    },
  }
}
export type StoreResolutionFailure =
  { kind: "not-open"; requestedId?: string } | { kind: "ambiguous"; openIds: string[] }

export class EditorNotOpenError extends Error {
  readonly code = "editor-not-open" as const
  readonly detail: StoreResolutionFailure
  constructor(detail: StoreResolutionFailure) {
    super(
      detail.kind === "ambiguous"
        ? `Multiple workflow editors are open (${detail.openIds.join(", ")}); pass workflowId explicitly.`
        : detail.requestedId
          ? `Workflow editor for "${detail.requestedId}" is not open.`
          : "No workflow editor is open."
    )
    this.name = "EditorNotOpenError"
    this.detail = detail
  }
}

export interface ResolveStoreInput {
  workflowId?: string
}

/**
 * Resolve the editor store for a tool call. Throws `EditorNotOpenError`
 * if no candidate exists or if the call is ambiguous; tool handlers
 * format the error into a structured tool-result payload before
 * returning to the agent.
 */
export function resolveStore(input: ResolveStoreInput): {
  workflowId: string
  store: EditorStoreFacade
} {
  const resolved = getWorkflowApi().resolveEditor(input.workflowId)
  if (resolved.ok) {
    return { workflowId: resolved.editor.workflowId, store: editorStore(resolved.editor) }
  }
  if (resolved.reason === "ambiguous") {
    throw new EditorNotOpenError({ kind: "ambiguous", openIds: resolved.openIds })
  }
  throw new EditorNotOpenError({ kind: "not-open", requestedId: resolved.requestedId })
}

/**
 * Format any thrown error from a tool execution into the structured
 * payload shape the agent consumes. Keeps the tool handlers terse:
 * `try { ... } catch (err) { return formatToolError(err) }`.
 */
export function formatToolError(err: unknown): {
  ok: false
  error: { code: string; message: string; detail?: unknown }
} {
  if (err instanceof EditorNotOpenError) {
    return { ok: false, error: { code: err.code, message: err.message, detail: err.detail } }
  }
  const message = err instanceof Error ? err.message : String(err)
  return { ok: false, error: { code: "tool-execution-failed", message } }
}
