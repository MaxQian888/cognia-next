/**
 * In-memory registry mapping an in-flight subagent `runId` to its
 * `AbortController`, so the chat UI (a `SubagentPart` card's Abort button) can
 * stop a run it did not directly start.
 *
 * The producer is `dispatch-agent-handler.ts`: it registers a controller right
 * after `recordDispatchStart` and unregisters on every terminal path. The
 * controller's `signal` is threaded into `dispatchSubagent`, whose loop observes
 * the abort and stops scheduling work.
 *
 * Mirrors `lib/workflow/runtime/run-cancel-registry.ts` — one process-wide map,
 * no React/Zustand coupling, safe to import from any runtime module.
 */

const subagentControllers = new Map<string, AbortController>()

/** Register a live subagent run's abort controller. */
export function registerSubagentRun(runId: string, controller: AbortController): void {
  subagentControllers.set(runId, controller)
}

/** Drop a subagent run from the registry. Called on every terminal path. */
export function unregisterSubagentRun(runId: string): void {
  subagentControllers.delete(runId)
}

/**
 * Abort an in-flight subagent run by id. Returns `true` when a live run was
 * found and signalled, `false` when no run with that id is currently executing
 * in this runtime.
 */
export function requestCancelSubagentRun(runId: string, reason?: string): boolean {
  const controller = subagentControllers.get(runId)
  if (!controller) return false
  controller.abort(new Error(reason ?? "Subagent run cancelled by request"))
  subagentControllers.delete(runId)
  return true
}

/** Test/diagnostic helper — number of live registered subagent runs. */
export function liveSubagentRunCount(): number {
  return subagentControllers.size
}
