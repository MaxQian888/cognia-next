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

import { getEditorStore, listEditorStores } from "@cognia/plugin-sdk/api/workflow-editor"
import type { EditorStore } from "@cognia/plugin-sdk/api/workflow-editor"
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
  store: EditorStore
} {
  if (input.workflowId) {
    const store = getEditorStore(input.workflowId)
    if (!store) throw new EditorNotOpenError({ kind: "not-open", requestedId: input.workflowId })
    return { workflowId: input.workflowId, store }
  }
  const open = listEditorStores()
  if (open.length === 1) return open[0]
  if (open.length === 0) throw new EditorNotOpenError({ kind: "not-open" })
  throw new EditorNotOpenError({
    kind: "ambiguous",
    openIds: open.map((o) => o.workflowId),
  })
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
