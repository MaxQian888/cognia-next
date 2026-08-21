/**
 * The re-dispatch seam `retry` was waiting for.
 *
 * `retry` has been in `RunControlAction` since the vocabulary was written, and
 * has never been reachable: its whole point is a terminal run, and the event
 * journal closes on one (`appendInsideTransaction` refuses every event past a
 * terminal status). Accepting a control event past that boundary would weaken
 * the guarantee that a settled run's history is final, so the answer is not to
 * relax the journal — it is the shape the recovery policy already uses: mint a
 * NEW run, link it by `parentRunId`, journal there, leave the settled row
 * alone.
 *
 * "Mint a new run" means something different per engine, which is why this is a
 * registry rather than a switch. A registry also answers the second half of the
 * problem honestly: `allowedActions` can ask whether a kind has a re-dispatch
 * at all ({@link canRetryRunKind}) and simply not offer the button otherwise,
 * instead of rendering a control that always fails.
 *
 * Deliberately Dexie-free so both the control gate and the pure projection
 * reducer can consult it without the reducer acquiring a database import.
 */

import type { ExecutionRun, ExecutionRunKind, RunControlCommand } from "@/types/execution/run"

export interface RunRetryContext {
  /** The settled run being replaced. Never mutated by the handler. */
  run: ExecutionRun
  command: RunControlCommand
}

export interface RunRetryResult {
  /**
   * The replacement's EXECUTION run id — not the engine's own run id.
   *
   * The control gate links it back with `adoptExecutionRun`, so a handler that
   * returns an engine id would silently produce an unlinked orphan.
   */
  runId: string
}

export type RunRetryHandler = (context: RunRetryContext) => Promise<RunRetryResult>

const handlers = new Map<ExecutionRunKind, RunRetryHandler>()

export function registerRunRetryHandler(
  kind: ExecutionRunKind,
  handler: RunRetryHandler
): () => void {
  handlers.set(kind, handler)
  return () => {
    if (handlers.get(kind) === handler) handlers.delete(kind)
  }
}

export function getRunRetryHandler(kind: ExecutionRunKind): RunRetryHandler | undefined {
  return handlers.get(kind)
}

/**
 * Whether this kind can be re-dispatched in THIS process.
 *
 * Process-scoped on purpose: a thin client projecting a snapshot has no
 * handlers registered, and a Retry button there would post a command the host
 * it is talking to may not honour. Not offering it is the honest default.
 */
export function canRetryRunKind(kind: ExecutionRunKind): boolean {
  return handlers.has(kind)
}

/** Test-only: drop every registration so suites do not leak into each other. */
export function __resetRunRetryHandlersForTesting(): void {
  handlers.clear()
}
