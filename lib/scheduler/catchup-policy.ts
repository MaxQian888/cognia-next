/**
 * Per-task-type catch-up defaults — what happens to a slot the host was offline
 * for (ADR-0002 / ADR-0079).
 *
 * ## Why a table instead of one global default
 *
 * `DEFAULT_EXECUTION_CONFIG` sets `runMissedOnStartup: false`, so before this
 * module EVERY missed slot was dropped. On a 24/7 headless host that is wrong for
 * some task types and right for others, and the difference is not a preference —
 * it follows from what the task does:
 *
 * - A presence/liveness refresh has nothing to catch up: the next tick publishes
 *   the current value, and replaying a stale one is strictly worse.
 * - A daily digest the operator expects in a chat window IS the deliverable. A
 *   brain restarted at 09:00:30 must still post the 09:00 digest — but posting
 *   yesterday's at noon is noise, hence a bounded grace window.
 * - A state-rebuilding job (backup, wiki index, radar report) loses real work when
 *   a slot is dropped, so missed slots are replayed.
 *
 * ## The semantics these values have to work around
 *
 * `catchupWindowMs` is evaluated BEFORE `runMissedOnStartup` in
 * `TaskScheduler.reconcileMissedRecurringTask`, and it only ever REMOVES slots.
 * With `runMissedOnStartup: false` every surviving slot is skipped anyway, so a
 * window on its own is inert — it can only change the terminal reason from
 * `missed-run-skipped` to `catchup-window-expired`. The two fields must be set
 * together, which is exactly the trap this table exists to stop people falling
 * into. `catchup-policy.test.ts` pins that reasoning with a negative case.
 *
 * ## Known hazard in the `all` tier
 *
 * Missed slots execute SEQUENTIALLY (`for (const slot of dueSlots) await
 * this.executeTask(...)`), so a task down for a long time replays back-to-back on
 * boot. `maxMissedRuns` bounds that, but for idempotent rebuild jobs the ideal
 * behaviour is to coalesce to the newest slot rather than replay N times. That
 * coalescing does not exist yet — the bound below is the guard until it does.
 *
 * Every value here is a DEFAULT: an explicit `config` on `createTask` still wins.
 */
import type { ScheduledTaskType, TaskExecutionConfig } from "@/types/scheduler"

/**
 * How much lateness is still worth delivering for the `grace` tier. Sized to
 * cover a deploy/restart cycle, not an outage.
 */
export const CATCHUP_GRACE_WINDOW_MS = 15 * 60_000

/**
 * Upper bound on replayed slots in the `all` tier. Not a product choice — a
 * runaway guard, because replay is sequential (see the hazard note above).
 */
export const CATCHUP_MAX_REPLAYED_RUNS = 30

export type CatchupTier =
  /** Drop missed slots; the next tick is authoritative. */
  | "never"
  /** Deliver one missed slot if it is still fresh, otherwise drop it. */
  | "grace"
  /** Replay missed slots — dropping one loses work. */
  | "all"

/** The subset of `TaskExecutionConfig` this policy owns. */
export type CatchupDefaults = Pick<
  TaskExecutionConfig,
  "runMissedOnStartup" | "catchupWindowMs" | "maxMissedRuns"
>

/**
 * Task types whose tier differs from the conservative default.
 *
 * Anything absent falls to `never`, which is what the repo did before this
 * module — so adding a task type can never silently start replaying work. That
 * deliberately includes `script`, `plugin` and `custom`: their side effects are
 * user-defined, so opting them into catch-up is the task author's call.
 */
const TIER_BY_TYPE: Partial<Record<ScheduledTaskType, CatchupTier>> = {
  // Liveness — replaying a stale value is worse than skipping.
  "connection:presence:refresh": "never",

  // Operator-visible deliverables: late-but-fresh beats missing.
  "connection:scheduled:digest": "grace",
  "connection:outbound:send": "grace",
  chat: "grace",
  agent: "grace",
  skill: "grace",
  "external-agent": "grace",
  "agent-team": "grace",
  goal: "grace",
  plan: "grace",

  // State-rebuilding work: a dropped slot is lost work.
  backup: "all",
  "wiki-rebuild": "all",
  "wiki-lint": "all",
  "radar-report": "all",
  twin: "all",
}

/** The tier a task type falls into. Unknown/open types are `never`. */
export function resolveCatchupTier(taskType: string): CatchupTier {
  return TIER_BY_TYPE[taskType as ScheduledTaskType] ?? "never"
}

/** The config fragment a tier implies. */
export function catchupDefaultsForTier(tier: CatchupTier): CatchupDefaults {
  switch (tier) {
    case "never":
      return { runMissedOnStartup: false, maxMissedRuns: 1 }
    case "grace":
      return {
        runMissedOnStartup: true,
        catchupWindowMs: CATCHUP_GRACE_WINDOW_MS,
        maxMissedRuns: 1,
      }
    case "all":
      return { runMissedOnStartup: true, maxMissedRuns: CATCHUP_MAX_REPLAYED_RUNS }
  }
}

/**
 * Catch-up defaults for a task type. Merge BETWEEN `DEFAULT_EXECUTION_CONFIG`
 * and the caller's `config` so an explicit setting always wins.
 */
export function resolveCatchupDefaults(taskType: string): CatchupDefaults {
  return catchupDefaultsForTier(resolveCatchupTier(taskType))
}

/**
 * Whether an execution that fired from a missed slot should be labelled as late
 * when its output reaches a human. `triggerSource` is already on the execution
 * record; this keeps the wording decision in one place for every delivery
 * surface (IM segments, notification center, run detail).
 */
export function isLateDelivery(triggerSource: string | undefined): boolean {
  return triggerSource === "catch-up" || triggerSource === "backfill"
}
