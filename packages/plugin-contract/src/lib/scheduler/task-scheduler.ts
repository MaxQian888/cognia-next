/**
 * The plugin contract's share of `lib/scheduler/task-scheduler.ts`, which re-exports these.
 */
import type { TaskExecution } from "../../types/scheduler/index"

/**
 * The answer to "stop this run", which is never just a boolean.
 *
 * Four outcomes that a boolean would flatten into one, and the difference is
 * what the user needs to be told. `already-settled` means they are looking at
 * stale rows. `not-owned-here` means the run is real but this context cannot
 * reach it, which on the web is the ordinary case of a second tab. `requested`
 * means it was handed to the owning context and the status broadcast will say
 * what happened.
 */
export type CancelExecutionOutcome =
  | { cancelled: true }
  | { cancelled: false; reason: "not-found" }
  | { cancelled: false; reason: "already-settled"; status: TaskExecution["status"] }
  | { cancelled: false; reason: "requested" }
  | { cancelled: false; reason: "not-owned-here" }
  /**
   * The schedule on screen belongs to a paired host whose build does not know
   * the `scheduled_task_cancel_run` command. Named rather than folded into
   * `not-owned-here` because the fix is different: this one is an out-of-date
   * machine, not a run that moved.
   */
  | { cancelled: false; reason: "unsupported-on-remote" }
