/**
 * The sweep that gets stranded work moving again (ADR-0123).
 *
 * On the happy path a submission is dispatched by whoever accepted it, while
 * the user is still watching. This runner exists for every other path: the
 * process died between accept and dispatch, the runner died holding a lease,
 * or the execution target was away when the work arrived.
 *
 * Each pass takes claimable rows, asks {@link planWorkSubmissionRecovery}
 * whether replay is provably safe, and either re-dispatches or parks the
 * submission as `recovery_required` for a human. **It never replays work that
 * may already have run a tool** — see `recovery.ts` for why that asymmetry is
 * deliberate.
 *
 * Dispatch itself is injected. The runner owns *when* work moves and what
 * happens when it fails; it deliberately knows nothing about how a turn reaches
 * a runtime, so the same loop serves the desktop renderer and the headless
 * brain without either importing the other's transport.
 */

import {
  claimWorkSubmission,
  listClaimableWorkSubmissions,
  releaseWorkSubmission,
  renewWorkSubmissionLease,
  type WorkSubmissionRow,
} from "@/lib/db/work-submissions"

import { planWorkSubmissionRecovery, type WorkRecoveryDeps } from "./recovery"
import { markWorkSubmissionStarted, settleWorkSubmissionWithoutTranscript } from "./service"
import { startWorkSubmissionLeaseHeartbeat } from "./lease-heartbeat"

/** Base backoff between dispatch attempts, doubled per attempt. */
export const WORK_OUTBOX_BASE_BACKOFF_MS = 5_000
/** Ceiling for the exponential backoff, so a stuck target retries hourly. */
export const WORK_OUTBOX_MAX_BACKOFF_MS = 60 * 60 * 1000
/** How often an idle runner re-checks for work. */
export const WORK_OUTBOX_SWEEP_INTERVAL_MS = 30_000

export type Unsubscribe = () => void

export type WorkDispatchOutcome =
  /** Handed to a runtime; the turn now owns its own lifecycle. */
  | { status: "dispatched" }
  /** The target is away. Retried under `wait`, failed under anything else. */
  | { status: "unavailable"; errorCode?: string }
  /** This attempt failed but another may succeed. */
  | { status: "retry"; errorCode?: string }
  /** Terminal failure; do not retry. */
  | { status: "failed"; errorCode?: string }
  /** Frozen replay evidence is absent or invalid; require a human decision. */
  | { status: "recovery_required"; errorCode: string }

export interface WorkOutboxDeps extends WorkRecoveryDeps {
  /** Stable id for this runner, recorded as the lease owner. */
  runnerId: string
  dispatch: (submission: WorkSubmissionRow) => Promise<WorkDispatchOutcome>
  /** Stop a runtime immediately if this runner loses its execution fence. */
  abort: (submission: WorkSubmissionRow) => Promise<void>
  now?: () => number
  listClaimable?: typeof listClaimableWorkSubmissions
  /** Max rows per pass, so one sweep cannot monopolise the host. */
  batchSize?: number
  onError?: (error: unknown, submissionId: string) => void
}

export interface WorkOutboxPassResult {
  claimed: number
  dispatched: number
  deferred: number
  failed: number
  recoveryRequired: number
}

export interface WorkOutboxPassOptions {
  /** Reconcile work handed off by a previous process. Used only at startup. */
  includeDispatched?: boolean
}

/** Exponential backoff, capped. `attemptCount` is 1 on the first attempt. */
export function backoffForAttempt(attemptCount: number): number {
  const exponent = Math.max(0, attemptCount - 1)
  return Math.min(WORK_OUTBOX_BASE_BACKOFF_MS * 2 ** exponent, WORK_OUTBOX_MAX_BACKOFF_MS)
}

async function handleOne(
  row: WorkSubmissionRow,
  deps: WorkOutboxDeps,
  now: number,
  result: WorkOutboxPassResult
): Promise<void> {
  // Decide replay safety BEFORE claiming, so a submission that must not be
  // replayed is never even marked as attempted again.
  const plan = await planWorkSubmissionRecovery(row, deps)
  if (plan.action === "recovery_required") {
    await settleWorkSubmissionWithoutTranscript(row.id, "recovery_required", now, plan.reason)
    result.recoveryRequired += 1
    return
  }

  const claimed = await claimWorkSubmission(row.id, deps.runnerId, now)
  // Another runner won the race, or the row settled underneath us.
  if (!claimed) return
  result.claimed += 1

  let leaseLost = false
  const stopHeartbeat = startWorkSubmissionLeaseHeartbeat(row.id, deps.runnerId, {
    onLeaseLost: () => {
      leaseLost = true
    },
    onError: (error) => deps.onError?.(error, row.id),
  })
  const stillOwnsClaim = async (): Promise<boolean> => {
    if (leaseLost) return false
    try {
      const status = await renewWorkSubmissionLease(
        row.id,
        deps.runnerId,
        deps.now?.() ?? Date.now()
      )
      if (status === "renewed") return true
      stopHeartbeat()
      if (status === "lost") leaseLost = true
      return false
    } catch (error) {
      deps.onError?.(error, row.id)
      stopHeartbeat()
      leaseLost = true
      return false
    }
  }

  // A previous process handed this turn to the runtime but died before it
  // settled. Stop that old session before replacement dispatch; doing it here,
  // after ownership transfer but before handoff, cannot kill the new run.
  if (claimed.takeoverRequired) {
    try {
      await deps.abort(claimed)
    } catch (error) {
      deps.onError?.(error, row.id)
      if (!(await stillOwnsClaim())) return
      await settleWorkSubmissionWithoutTranscript(
        row.id,
        "recovery_required",
        now,
        "takeover_abort_failed"
      )
      result.recoveryRequired += 1
      return
    }
    if (!(await stillOwnsClaim())) return
  }

  let outcome: WorkDispatchOutcome
  try {
    outcome = await deps.dispatch(claimed)
  } catch (error) {
    deps.onError?.(error, row.id)
    outcome = {
      status: "retry",
      errorCode: error instanceof Error ? error.name : "dispatch_threw",
    }
  }

  // Ownership moved while this dispatch was in flight. The new owner decides
  // the ledger state; this runner only aborts its stale runtime above.
  if (leaseLost) return

  if (outcome.status === "dispatched") {
    await markWorkSubmissionStarted(row.id, now)
    result.dispatched += 1
    return
  }

  stopHeartbeat()

  if (outcome.status === "failed") {
    await settleWorkSubmissionWithoutTranscript(row.id, "failed", now, outcome.errorCode)
    result.failed += 1
    return
  }

  if (outcome.status === "recovery_required") {
    await settleWorkSubmissionWithoutTranscript(row.id, "recovery_required", now, outcome.errorCode)
    result.recoveryRequired += 1
    return
  }

  // `unavailable` only parks the work when the submission asked to wait.
  // Anything else surfaces the failure rather than growing a silent backlog.
  if (outcome.status === "unavailable" && claimed.availabilityPolicy !== "wait") {
    await settleWorkSubmissionWithoutTranscript(
      row.id,
      "failed",
      now,
      outcome.errorCode ?? "target_unavailable"
    )
    result.failed += 1
    return
  }

  await releaseWorkSubmission(
    row.id,
    {
      dispatchState: outcome.status === "unavailable" ? "blocked" : "pending",
      nextAttemptAt: now + backoffForAttempt(claimed.attemptCount),
      ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
    },
    now
  )
  result.deferred += 1
}

/**
 * Run one sweep.
 *
 * A failure on one submission never aborts the pass: one poisoned row must not
 * stop every other piece of stranded work from recovering.
 */
export async function runWorkOutboxPass(
  deps: WorkOutboxDeps,
  options: WorkOutboxPassOptions = {}
): Promise<WorkOutboxPassResult> {
  const now = deps.now?.() ?? Date.now()
  const result: WorkOutboxPassResult = {
    claimed: 0,
    dispatched: 0,
    deferred: 0,
    failed: 0,
    recoveryRequired: 0,
  }
  const rows = await (deps.listClaimable ?? listClaimableWorkSubmissions)(
    now,
    deps.batchSize ?? 25,
    { includeDispatched: options.includeDispatched ?? false }
  )
  for (const row of rows) {
    try {
      await handleOne(row, deps, now, result)
    } catch (error) {
      deps.onError?.(error, row.id)
    }
  }
  return result
}

/**
 * Start the periodic sweep and return an unsubscribe handle.
 *
 * The first pass runs immediately, because the most valuable moment to look for
 * stranded work is right after a restart.
 */
export function startWorkOutboxRunner(deps: WorkOutboxDeps): Unsubscribe {
  let stopped = false
  const tick = () => {
    if (stopped) return
    // A dispatched row may still hold an unexpired lease on the first tick
    // after restart. Reconsider it on every pass so it becomes recoverable as
    // soon as that lease expires, and so batches beyond the first page drain.
    void runWorkOutboxPass(deps, { includeDispatched: true }).catch((error) =>
      deps.onError?.(error, "sweep")
    )
  }
  tick()
  const timer = setInterval(tick, WORK_OUTBOX_SWEEP_INTERVAL_MS)
  return () => {
    stopped = true
    clearInterval(timer)
  }
}
