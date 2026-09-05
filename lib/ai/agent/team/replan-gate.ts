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
import { openSquadReview, type SquadReviewOutcome } from "./squad-review-gate"
import type { TeamNotifier } from "./team-notifier"
import { replanDecisionSchema, type ReplanDecision } from "./replan-schema"

export interface ReplanGateDeps {
  notifier: TeamNotifier
  runId: string
  teamId: string
  /** The lead's proposed decision; shown in the modal and applied on approve. */
  decision: ReplanDecision
  signal?: AbortSignal
  /**
   * Gate behavior from the run's origin policy (see `gate-policy.ts`).
   * Non-"block" resolves immediately as rejected — which is fail-open here:
   * the original plan proceeds. Defaults to "block" (interactive).
   */
  behavior?: import("./gate-policy").GateBehavior
  projectId?: string
  /**
   * Distinguishes this checkpoint's review from an earlier one in the same
   * run. Defaults to the wave the checkpoint fired at, when the caller has it.
   */
  instance?: string
  /** Injectable for tests. Defaults to the durable Squad review. */
  openReview?: (input: {
    runId: string
    teamId: string
    projectId?: string
    instance: string
    signal?: AbortSignal
  }) => Promise<SquadReviewOutcome>
}

export interface ReplanGateOutcome {
  approved: boolean
  /** The decision to apply — the operator's edit when provided, else the lead's. */
  decision: ReplanDecision
}

export async function awaitReplanApproval(deps: ReplanGateDeps): Promise<ReplanGateOutcome> {
  const { notifier, runId, teamId, decision } = deps
  if (deps.behavior !== undefined && deps.behavior !== "block") {
    // Headless: reject is fail-open (original plan proceeds) — inform, don't
    // open a modal nobody is watching.
    notifier.notify({
      level: "info",
      title: "Re-plan skipped (headless run)",
      body: `Approval required but the run is headless — continuing with the original plan. Proposed change: ${decision.reasoning}`,
      runId,
      teamId,
      dedupeKey: `replan:${runId}`,
    })
    return { approved: false, decision }
  }
  notifier.notify({
    level: "critical",
    title: "Re-plan checkpoint awaiting approval",
    body: decision.reasoning,
    runId,
    teamId,
    dedupeKey: `replan:${runId}`,
  })
  const instance = deps.instance ?? `replan-${Date.now()}`
  const openReview =
    deps.openReview ??
    ((input: {
      runId: string
      teamId: string
      projectId?: string
      instance: string
      signal?: AbortSignal
    }) =>
      openSquadReview({
        runId: input.runId,
        teamId: input.teamId,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        kind: "replan",
        instance: input.instance,
        subject: {
          action: decision.action,
          newTasks: decision.newTasks?.length ?? 0,
          newMembers: decision.newMembers?.length ?? 0,
        },
        ...(input.signal ? { signal: input.signal } : {}),
      }))
  // An abort while waiting propagates: the run is ending, and pretending the
  // operator declined would let a wave start on a run that was just stopped.
  const result: SquadReviewOutcome = await openReview({
    runId,
    teamId,
    ...(deps.projectId ? { projectId: deps.projectId } : {}),
    instance,
    ...(deps.signal ? { signal: deps.signal } : {}),
  })
  if (result.outcome !== "approve") {
    // Operator declined the re-plan: proceed with the original plan.
    return { approved: false, decision }
  }
  // The operator may submit an edited decision payload. Validate and prefer it.
  const edited = replanDecisionSchema.safeParse(
    result.kind === "replan" ? result.edited : undefined
  )
  return { approved: true, decision: edited.success ? edited.data : decision }
}
