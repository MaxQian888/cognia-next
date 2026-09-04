/**
 * The global execution cap, and what a start that hits it turns into.
 *
 * `SchedulerPermissionPolicy.maxConcurrentExecutions` shipped with a type, a
 * default of 5 and a settings control the user could edit and persist, and had
 * zero enforcement callers anywhere in the repository. ADR-0167 made the other
 * four policy fields real through `write-authority.ts` and left this one
 * behind, which is the more misleading half of the pair. The other four gate a
 * *write*, so a refusal is visible immediately. This one governs *execution*,
 * and its absence is only visible as a machine under more load than the user
 * ever asked for.
 *
 * `TaskExecutionTerminalReason` has carried `"concurrency-blocked"` since the
 * union was written and nothing has ever produced it. This module is what
 * produces it.
 *
 * Kept separate from the scheduler so the decision is a pure function over two
 * numbers and an enum. `TaskSchedulerImpl` is roughly 2,700 lines of timing,
 * retry and lifecycle state. A rule this load-bearing should be readable and
 * testable without standing any of that up.
 */

import type { TaskOverlapPolicy } from "@/types/scheduler"
import { DEFAULT_PERMISSION_POLICY } from "@/types/scheduler"

/**
 * What happens to a start that arrives with every execution slot taken.
 *
 * `buffer` reuses the scheduler's existing per-task queue rather than adding a
 * second waiting room. A blocked start is already exactly what `queue-one` and
 * `queue-all` describe, and giving the cap its own global FIFO would mean two
 * mechanisms answering "what is waiting to run" with two different answers.
 */
export type ConcurrencyAdmission =
  | { admit: true }
  | { admit: false; disposition: "buffer" }
  | { admit: false; disposition: "drop"; message: string }

/**
 * The cap, sanitized.
 *
 * The settings control clamps to `[1, 20]`, but a policy row can also arrive
 * from a restored backup, a hand-edited settings export, or a build of this app
 * that predates the field. A zero, a negative or a `NaN` reaching the scheduler
 * as a literal cap would stop every task on the host from ever running again,
 * which is a silent and total outage produced by a number nobody typed. So
 * anything that is not a positive integer falls back to the shipped default
 * rather than being honoured literally.
 *
 * There is deliberately no "unlimited" sentinel. The setting is a cap, and a
 * user who wants effectively no cap raises it.
 */
export function resolveConcurrencyLimit(maxConcurrentExecutions: number | undefined): number {
  if (typeof maxConcurrentExecutions !== "number") {
    return DEFAULT_PERMISSION_POLICY.maxConcurrentExecutions
  }
  if (!Number.isFinite(maxConcurrentExecutions) || maxConcurrentExecutions < 1) {
    return DEFAULT_PERMISSION_POLICY.maxConcurrentExecutions
  }
  return Math.floor(maxConcurrentExecutions)
}

export interface ConcurrencyAdmissionInput {
  /** Executions currently running across every task on this host. */
  runningCount: number
  /** Already sanitized by {@link resolveConcurrencyLimit}. */
  limit: number
  /** The overlap policy of the task whose start is being decided. */
  overlapPolicy: TaskOverlapPolicy
}

/**
 * Decide whether a start may take an execution slot.
 *
 * The cap answers "may anything else start right now", and the task's own
 * overlap policy answers "what becomes of a start that may not". Those are two
 * different questions and this function keeps them that way, which is why the
 * cap applies under `allow` too. `allow` means "do not hold this task up behind
 * *itself*", not "this task is exempt from the user's ceiling". A policy that
 * could opt a task out of the cap would make the cap advisory, and an advisory
 * cap is the state this module exists to end.
 *
 * The disposition mapping:
 *
 * - `queue-one` and `queue-all` already describe a start that waits for
 *   capacity, so a capped start is buffered and the scheduler drains it when a
 *   slot frees. This is the only branch that preserves the fire.
 * - `skip` says a colliding start is dropped. A capped one is dropped the same
 *   way, under `concurrency-blocked` rather than `overlap-skipped` so the run
 *   history can distinguish "this task was busy" from "the host was".
 * - `allow` and `cancel-previous` have no waiting semantics to reuse. Reaching
 *   here under `cancel-previous` also means the slots are held by *other*
 *   tasks, because the per-task branch runs first and a `cancel-previous` task
 *   blocking itself has already aborted its own run and freed that slot.
 *   Cancelling someone else's execution to make room is not something an
 *   overlap policy is entitled to authorize, so the start is dropped and
 *   recorded.
 */
export function decideConcurrencyAdmission(input: ConcurrencyAdmissionInput): ConcurrencyAdmission {
  const { runningCount, limit, overlapPolicy } = input
  if (runningCount < limit) return { admit: true }

  if (overlapPolicy === "queue-one" || overlapPolicy === "queue-all") {
    return { admit: false, disposition: "buffer" }
  }

  return {
    admit: false,
    disposition: "drop",
    message: `Skipped: ${runningCount} executions already running, which is this host's configured limit of ${limit}`,
  }
}
