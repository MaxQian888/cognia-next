/**
 * The plugin contract's share of `lib/workflow/runtime/last-run-summary.ts`, which re-exports these.
 */
/** One step's outcome from its most recent terminal event. */
export type LastRunStatus = "succeeded" | "failed" | "skipped"

export interface LastRunSummary {
  status: LastRunStatus
  /** The run whose terminal event produced this summary. */
  runId?: string
  /** Wall-clock when the step started (last attempt). May be 0 if missing. */
  startedAt: number
  /** Wall-clock when the step ended (terminal event). */
  finishedAt: number
  /** finishedAt - startedAt; 0 when startedAt is missing. */
  durationMs: number
  /** First line of the failure message, if status is "failed". */
  errorMessage?: string
  /** Attempts of this step within {@link runId}; earlier runs never add to it. */
  attempt: number
  /**
   * True when the step FAILED but its per-node error handling substituted an
   * output and the run continued (step_failed followed by step_completed
   * with no new attempt in between). Status is "succeeded"; the UI renders
   * a warning state instead of plain success.
   */
  handled?: boolean
  /**
   * Tokens and cost this step reported, when it is LLM-backed.
   *
   * The figures were already aggregated from `step_usage` events for the Runs
   * UI, but stopped at the run detail page: the canvas node footer showed
   * status and duration only, so the most expensive node in a graph looked
   * exactly like the cheapest.
   */
  usage?: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    /** Absent when the provider reported no pricing. */
    costUsd?: number
  }
}
