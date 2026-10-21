/**
 * The plugin contract's share of `lib/workflow/library/lookup.ts`, which re-exports these.
 */
export interface WorkflowSummary {
  id: string
  name: string
  description?: string
}

export type FindWorkflowByNameResult =
  | { ok: true; workflowId: string; name: string }
  | { ok: false; reason: "ambiguous"; candidates: WorkflowSummary[] }
  | { ok: false; reason: "not-found" }
