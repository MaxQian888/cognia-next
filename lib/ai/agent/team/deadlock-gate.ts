/**
 * The `pool.onAllUnavailable` handler, extracted from `runTeamLifecycle` so the
 * `team.config.enableDeadlockRecovery` branch is unit-testable in isolation.
 *
 * - recovery enabled (default): open the HITL recovery gate — notify with
 *   a durable Squad review, freeze concurrency, then wait for the operator to
 *   unquarantine teammates (approve) or abort (reject). Re-entrancy-safe while a
 *   decision is pending.
 * - recovery disabled (`enableDeadlockRecovery === false`): fast-fail — notify
 *   (no gate) and abort the run immediately, so a deadlocked run does not hang
 *   waiting for an operator that the team explicitly opted out of.
 */
import { openSquadReview, type SquadReviewOutcome } from "./squad-review-gate"
import type { ConcurrencyController } from "@/lib/workflow/runtime/concurrency-controller"
import type { TeammatePool } from "./teammate-pool"
import type { TeamNotifier } from "./team-notifier"

export interface DeadlockGateDeps {
  /** `team.config.enableDeadlockRecovery !== false` (default true). */
  recovery: boolean
  /**
   * Gate behavior from the run's origin policy (see `gate-policy.ts`).
   * Anything other than "block" fast-fails like `recovery: false`, with an
   * origin-appropriate message — a headless run has no operator to
   * unquarantine teammates. Defaults to "block" (interactive).
   */
  behavior?: import("./gate-policy").GateBehavior
  runId: string
  teamId: string
  projectId?: string
  notifier: TeamNotifier
  concurrency: ConcurrencyController
  pool: TeammatePool
  signal: AbortSignal
  /** Abort the run (the lifecycle's AbortController.abort). */
  abort: (reason: Error) => void
  /** Injectable for tests. Defaults to the durable Squad review. */
  openReview?: (input: {
    runId: string
    teamId: string
    projectId?: string
    signal: AbortSignal
  }) => Promise<SquadReviewOutcome>
}

export function createDeadlockHandler(deps: DeadlockGateDeps): () => void {
  const openReview =
    deps.openReview ??
    ((input: { runId: string; teamId: string; projectId?: string; signal: AbortSignal }) =>
      openSquadReview({
        runId: input.runId,
        teamId: input.teamId,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        kind: "deadlock",
        instance: `deadlock-${++deadlockCount}`,
        signal: input.signal,
      }))
  let deadlockCount = 0
  const dedupeKey = `deadlock:${deps.runId}`
  let active = false

  return () => {
    if (deps.signal.aborted) return

    const headless = deps.behavior !== undefined && deps.behavior !== "block"
    if (!deps.recovery || headless) {
      deps.notifier.notify({
        level: "critical",
        title: "All teammates unavailable",
        body: headless
          ? "Headless run has no operator for deadlock recovery — aborting."
          : "Deadlock recovery is disabled — aborting the run.",
        runId: deps.runId,
        teamId: deps.teamId,
        dedupeKey,
      })
      deps.abort(
        new Error(headless ? "Deadlock; headless run aborted" : "Deadlock; recovery disabled")
      )
      return
    }

    if (active) return
    active = true
    deps.notifier.notify({
      level: "critical",
      title: "All teammates unavailable",
      body: "Run paused awaiting operator decision.",
      runId: deps.runId,
      teamId: deps.teamId,
      dedupeKey,
    })
    deps.concurrency.reduceTo(0)
    void openReview({
      runId: deps.runId,
      teamId: deps.teamId,
      ...(deps.projectId ? { projectId: deps.projectId } : {}),
      signal: deps.signal,
    })
      .then((decision) => {
        if (decision.outcome === "approve" && decision.kind === "deadlock") {
          deps.pool.forceUnquarantine(
            decision.resetAll ? { resetAll: true } : { teammateIds: decision.teammateIds ?? [] }
          )
        } else {
          deps.abort(new Error("deadlock_aborted_by_operator"))
        }
      })
      .catch(() => {
        // signal aborted while waiting — no-op
      })
      .finally(() => {
        active = false
      })
  }
}
