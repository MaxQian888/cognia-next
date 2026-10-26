/**
 * The plugin contract's share of `lib/workflow/runtime/error-explainer.ts`, which re-exports these.
 */
export type ExplainedSeverity = "error" | "warning" | "info"

/**
 * One explained validation issue, scoped to a single node. `fields` lists
 * the offending param paths so the agent can fix them in one batch.
 */
export interface ExplainedValidation {
  nodeId: string
  nodeLabel: string
  nodeKind: string
  severity: ExplainedSeverity
  message: string
  fields: string[]
  /** True when the issue blocks a workflow run. */
  blocking: boolean
  /** Suggested next action — empty if no actionable advice applies. */
  suggestion: string
  /** The node the editor should focus when the user clicks "jump to". */
  jumpToNodeId: string
}

/**
 * Aggregated explanation of the most recent workflow run. `failedStep`
 * is set only when at least one step ended in `"failed"`; otherwise the
 * report mirrors the run's overall state ("succeeded" or "no run yet").
 */
export interface ExplainedLastRun {
  /** "no-run" when no terminal event has fired for this workflow. */
  status: "no-run" | "succeeded" | "partial" | "failed"
  failedStepId?: string
  failedStepLabel?: string
  errorSummary?: string
  suggestion?: string
  jumpToNodeId?: string
  /** Per-step counts so the agent can give a quick verbal recap. */
  counts: { succeeded: number; failed: number; skipped: number }
}
