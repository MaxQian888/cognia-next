/**
 * Replan approval gate (adaptive orchestration HITL). When a team enables
 * `adaptiveReplan.requireApproval`, the wave runner routes each non-trivial
 * re-plan decision through this gate before applying it. Rides the exact same
 * approval-bus + TeamNotifier machinery as the deadlock / budget gates
 * (scope `"agent-team-replan"`), so the workspace's existing GateModalsHost
 * renders the modal with zero new plumbing.
 *
 * Unlike the deadlock gate, the checkpoint runs BETWEEN waves with nothing in
 * flight, so there is no concurrency to pause. Reject = proceed with the
 * original plan (fail-open). Abort propagates (run cancellation).
 */
import { waitForDecision } from "@/lib/runtime/approval-bus"
import type { ApprovalDecision } from "@/lib/runtime/approval-bus"
import type { TeamNotifier } from "./team-notifier"
import { replanDecisionSchema, type ReplanDecision } from "./replan-schema"

export interface ReplanGateDeps {
  notifier: TeamNotifier
  runId: string
  teamId: string
  /** The lead's proposed decision; shown in the modal and applied on approve. */
  decision: ReplanDecision
  signal?: AbortSignal
  /** Injectable waiter for tests; defaults to the approval-bus. */
  waitFn?: (signal?: AbortSignal) => Promise<ApprovalDecision>
}

export interface ReplanGateOutcome {
  approved: boolean
  /** The decision to apply — the operator's edit when provided, else the lead's. */
  decision: ReplanDecision
}

export async function awaitReplanApproval(deps: ReplanGateDeps): Promise<ReplanGateOutcome> {
  const { notifier, runId, teamId, decision } = deps
  notifier.notify({
    level: "critical",
    title: "Re-plan checkpoint awaiting approval",
    body: decision.reasoning,
    runId,
    teamId,
    openApproval: { scope: "agent-team-replan", id: runId },
    dedupeKey: `replan:${runId}`,
  })
  const wait =
    deps.waitFn ?? ((signal) => waitForDecision({ scope: "agent-team-replan", id: runId }, signal))
  const result = await wait(deps.signal)
  if (result.outcome !== "approve") {
    // Operator declined the re-plan → proceed with the original plan.
    return { approved: false, decision }
  }
  // The operator may submit an edited decision payload; validate and prefer it.
  const edited = replanDecisionSchema.safeParse(result.plan)
  return { approved: true, decision: edited.success ? edited.data : decision }
}
