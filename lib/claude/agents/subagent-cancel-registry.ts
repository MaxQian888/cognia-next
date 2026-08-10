/**
 * In-memory registry mapping an in-flight subagent `runId` to the cancellation
 * handler owned by its runtime, so every UI surface uses one cancellation
 * entry point without assuming every runtime is backed by AbortController.
 *
 * The producer is `dispatch-agent-handler.ts`: it registers a controller right
 * after `recordDispatchStart` and unregisters on every terminal path. The
 * controller's `signal` is threaded into `dispatchSubagent`, whose loop observes
 * the abort and stops scheduling work.
 *
 * Mirrors `lib/workflow/runtime/run-cancel-registry.ts` — one process-wide map,
 * no React/Zustand coupling, safe to import from any runtime module.
 */

export type SubagentCancellationHandler = (reason?: string) => void | Promise<void>

const subagentCancellations = new Map<string, SubagentCancellationHandler>()

/** Register a live run's runtime-specific cancellation adapter. */
export function registerSubagentCancellation(
  runId: string,
  handler: SubagentCancellationHandler
): void {
  subagentCancellations.set(runId, handler)
}

/** Register a live subagent run's abort controller. */
export function registerSubagentRun(runId: string, controller: AbortController): void {
  registerSubagentCancellation(runId, (reason) => {
    controller.abort(new Error(reason ?? "Subagent run cancelled by request"))
  })
}

/** Drop a subagent run from the registry. Called on every terminal path. */
export function unregisterSubagentRun(runId: string): void {
  subagentCancellations.delete(runId)
}

/**
 * Abort an in-flight subagent run by id. Returns `true` when a live run was
 * found and signalled, `false` when no run with that id is currently executing
 * in this runtime.
 */
export function requestCancelSubagentRun(runId: string, reason?: string): boolean {
  const cancel = subagentCancellations.get(runId)
  if (!cancel) return false
  subagentCancellations.delete(runId)
  try {
    void Promise.resolve(cancel(reason)).catch(() => undefined)
  } catch {
    // The request still reached the registered runtime. Its terminal event or
    // diagnostics owns surfacing a synchronous adapter failure.
  }
  return true
}

/** Test/diagnostic helper — number of live registered subagent runs. */
export function liveSubagentRunCount(): number {
  return subagentCancellations.size
}
