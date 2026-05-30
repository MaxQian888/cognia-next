/**
 * In-memory registry mapping an in-flight workflow `runId` to its
 * `AbortController`, so an out-of-band caller can abort a run it did not start.
 *
 * The production caller is the Companion API `workflow_cancel_run` RPC, routed
 * through `lib/companion/desktop-write-source.ts`: a remote device asks the
 * desktop to stop a live run. The orchestrator (`orchestrator.ts`) registers
 * its controller right after creating it and unregisters on every terminal
 * path; `requestCancelRun` aborts the controller, which the orchestrator's
 * existing `ac.signal` handling observes (it stops scheduling new steps,
 * cancels pending wakes, and finalizes the run row).
 *
 * Mirrors the module-singleton style of `wake-bus.ts` — one process-wide map,
 * no React/Zustand coupling, safe to import from any runtime module.
 */

const runControllers = new Map<string, AbortController>()

/** Register a live run's abort controller. Called by the orchestrator. */
export function registerRun(runId: string, controller: AbortController): void {
  runControllers.set(runId, controller)
}

/** Drop a run from the registry. Called by the orchestrator on every exit. */
export function unregisterRun(runId: string): void {
  runControllers.delete(runId)
}

/**
 * Abort an in-flight run by id. Returns `true` when a live run was found and
 * signalled, `false` when no run with that id is currently executing in this
 * runtime (the caller can then fall back to a Dexie soft-cancel).
 */
export function requestCancelRun(runId: string, reason?: string): boolean {
  const controller = runControllers.get(runId)
  if (!controller) return false
  controller.abort(new Error(reason ?? "Workflow run cancelled by request"))
  runControllers.delete(runId)
  return true
}

/** Test/diagnostic helper — number of live registered runs. */
export function liveRunCount(): number {
  return runControllers.size
}
