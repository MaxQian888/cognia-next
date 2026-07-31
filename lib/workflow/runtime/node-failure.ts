/**
 * Per-node failure semantics (Dify/n8n parity) — pure resolution shared by
 * the top-level orchestrator catch and the loop-container subgraph catch.
 *
 * A node's `data.errorHandling.onError` wins over the workflow-level
 * `settings.errorPolicy`; absent (or "fail", or set on a kind that doesn't
 * support error handling) → `mode: null` and the caller keeps the legacy
 * workflow-level behavior unchanged.
 *
 * Semantics note: per-node "continue" RUNS downstream with an error-shaped
 * output (n8n behavior) — the OPPOSITE of the legacy workflow-level
 * "continue", which skips the failed node's downstream. Both are locked by
 * orchestrator tests.
 */

import type { WorkflowNode } from "@/types/workflow/visual"
import { supportsErrorHandling } from "@/lib/workflow/editor/node-handles"

export interface NodeFailureResolution {
  /** null → defer to the legacy workflow-level errorPolicy handling. */
  mode: "continue" | "errorBranch" | "defaultValue" | null
  /** Only set for mode "defaultValue". */
  defaultValue?: unknown
}

export function resolveNodeFailure(node: WorkflowNode): NodeFailureResolution {
  const onError = node.data.errorHandling?.onError
  if (!onError || onError === "fail") return { mode: null }
  if (!supportsErrorHandling(node.type)) return { mode: null }
  if (onError === "defaultValue") {
    return { mode: "defaultValue", defaultValue: node.data.errorHandling?.defaultValue }
  }
  return { mode: onError }
}

/**
 * The error-shaped step output substituted for "continue" / "errorBranch"
 * so downstream expressions can read `$node['id'].failed` / `.error`.
 */
export function buildErrorOutput(err: unknown): {
  failed: true
  error: string
  errorType: string
} {
  return {
    failed: true,
    error: err instanceof Error ? err.message : String(err),
    errorType: err instanceof Error ? err.name : "Error",
  }
}
