/**
 * The `pool.onAllUnavailable` handler, extracted from `runTeamLifecycle` so the
 * `team.config.enableDeadlockRecovery` branch is unit-testable in isolation.
 *
 * - recovery enabled (default): open the HITL recovery gate — notify with
 *   `openApproval`, freeze concurrency, then wait for the operator to
 *   unquarantine teammates (approve) or abort (reject). Re-entrancy-safe while a
 *   decision is pending.
 * - recovery disabled (`enableDeadlockRecovery === false`): fast-fail — notify
 *   (no gate) and abort the run immediately, so a deadlocked run does not hang
 *   waiting for an operator that the team explicitly opted out of.
 */
import {
  waitForDecision as defaultWaitForDecision,
  type ApprovalDecision,
  type ApprovalKey,
} from "@/lib/runtime/approval-bus"
import type { ConcurrencyController } from "@/lib/workflow/runtime/concurrency-controller"
import type { TeammatePool } from "./teammate-pool"
import type { TeamNotifier } from "./team-notifier"

export interface DeadlockGateDeps {
  /** `team.config.enableDeadlockRecovery !== false` (default true). */
  recovery: boolean
  runId: string
  teamId: string
  notifier: TeamNotifier
  concurrency: ConcurrencyController
  pool: TeammatePool
  signal: AbortSignal
  /** Abort the run (the lifecycle's AbortController.abort). */
  abort: (reason: Error) => void
  /** Injectable for tests; defaults to the real approval-bus waiter. */
  waitForDecision?: (key: ApprovalKey, signal?: AbortSignal) => Promise<ApprovalDecision>
}

export function createDeadlockHandler(deps: DeadlockGateDeps): () => void {
  const waitFn = deps.waitForDecision ?? defaultWaitForDecision
  const dedupeKey = `deadlock:${deps.runId}`
  let active = false

  return () => {
    if (deps.signal.aborted) return

    if (!deps.recovery) {
      deps.notifier.notify({
        level: "critical",
        title: "All teammates unavailable",
        body: "Deadlock recovery is disabled — aborting the run.",
        runId: deps.runId,
        teamId: deps.teamId,
        dedupeKey,
      })
      deps.abort(new Error("Deadlock; recovery disabled"))
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
      openApproval: { scope: "agent-team-deadlock", id: deps.runId },
      dedupeKey,
    })
    deps.concurrency.reduceTo(0)
    void waitFn({ scope: "agent-team-deadlock", id: deps.runId }, deps.signal)
      .then((decision) => {
        if (decision.outcome === "approve") {
          deps.pool.forceUnquarantine(
            (decision.plan as { teammateIds?: string[]; resetAll?: boolean }) ?? {
              resetAll: true,
            }
          )
        } else {
          deps.abort(new Error("Operator aborted on deadlock"))
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
