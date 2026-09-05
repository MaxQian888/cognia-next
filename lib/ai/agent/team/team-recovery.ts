/**
 * The `team_recovery` review (ADR-0169).
 *
 * A Squad run that cannot be replayed from a verified safe point is never
 * resumed silently. It parks as `needs_input` with a reason code, and THIS
 * module raises the durable interrupt a person answers:
 *
 *   retry_same_host   re-queue the uncertain children where they ran
 *   retry_host        re-queue them on a named host (safe checkpoint only)
 *   restart_run       start a linked NEW run through the one launch seam and
 *                     stop this one
 *   terminate         stop this one
 *
 * A backfilled legacy run (`legacy_run_not_resumable`) has no children to
 * re-queue: it offers `restart_run` and `terminate` only, and the decision
 * validator refuses the rest against the subject's `choices`.
 *
 * The interrupt is the `ExecutionRunInterrupt` the Action Review contract
 * projects, so it is answered from the cockpit, a phone, the CLI or an IM card
 * alike, and survives a restart: the bootstrap re-arms every parked run that
 * has no pending recovery interrupt.
 */

import { LEGACY_RUN_NOT_RESUMABLE } from "@/lib/agent-team/legacy-run-history"
import {
  getAgentTeamRun,
  listAgentTeamRecoveryCandidates,
  listAgentTeamRuns,
} from "@/lib/db/agent-team-runtime"
import { getDb } from "@/lib/db/schema"
import { agentTeamExecutionRunId } from "@/lib/execution/agent-team-bridge"
import { getExecutionRun } from "@/lib/db/execution-runs"
import type { AgentTeamRunRecord } from "@/types/agent/agent-team-runtime"
import type {
  ExecutionRunInterrupt,
  RunControlCommand,
  SquadReviewDecision,
  TeamRecoveryChoice,
} from "@/types/execution/run"

export const ALL_RECOVERY_CHOICES: readonly TeamRecoveryChoice[] = [
  "retry_same_host",
  "retry_host",
  "restart_run",
  "terminate",
]
export const LEGACY_RECOVERY_CHOICES: readonly TeamRecoveryChoice[] = ["restart_run", "terminate"]

/** Reason codes under which a parked run needs a recovery decision. */
export const SQUAD_NOT_READY = "squad_not_ready"

export const RECOVERY_REASONS: ReadonlySet<string> = new Set([
  "uncertain_side_effect",
  "missing_checkpoint",
  "recover_needs_input",
  SQUAD_NOT_READY,
  LEGACY_RUN_NOT_RESUMABLE,
])

export interface TeamRecoverySubject extends Record<string, unknown> {
  reason: string
  choices: TeamRecoveryChoice[]
  uncertainChildIds: string[]
  /** The host the uncertain children ran on, when they agree on one. */
  hostRef?: string
}

export interface TeamRecoveryDeps {
  now?: () => number
  arm?: (input: {
    runId: string
    teamId: string
    projectId?: string
    instance: string
    subject: TeamRecoverySubject
  }) => Promise<{ interruptId: string; pending: boolean }>
  retryChild?: (childRunId: string, hostRef?: string) => Promise<unknown>
  control?: (runId: string, action: "resume" | "stop") => Promise<{ ok: boolean; reason?: string }>
  startReplacement?: (input: {
    teamId: string
    parentExecutionRunId: string
    sessionId?: string
  }) => Promise<{ started: boolean; executionRunId?: string; reason?: string }>
  listChildren?: (runId: string) => Promise<Array<{ id: string; status: string; hostRef?: string }>>
  assessReplay?: (runId: string) => Promise<{ safe: boolean; uncertainChildIds: string[] }>
}

export type TeamRecoveryApplyRefusal =
  | "interrupt_not_found"
  | "not_a_recovery"
  | "run_not_found"
  | "choice_not_offered"
  | "cross_host_unsafe"
  | "restart_refused"
  | "control_refused"

export interface TeamRecoveryApplyResult {
  applied: boolean
  choice: TeamRecoveryChoice
  reason?: TeamRecoveryApplyRefusal
  /** Set on `restart_run`: the replacement's execution run id. */
  replacementExecutionRunId?: string
}

async function defaultArm(input: {
  runId: string
  teamId: string
  projectId?: string
  instance: string
  subject: TeamRecoverySubject
}): Promise<{ interruptId: string; pending: boolean }> {
  const { armSquadReview } = await import("./squad-review-gate")
  const armed = await armSquadReview({
    runId: input.runId,
    teamId: input.teamId,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    kind: "team_recovery",
    instance: input.instance,
    subject: input.subject,
  })
  return { interruptId: armed.interruptId, pending: armed.settled === undefined }
}

async function defaultRetryChild(childRunId: string, hostRef?: string): Promise<unknown> {
  const { getDurableTeamCoordinator } = await import("./durable-runtime")
  return getDurableTeamCoordinator().retryChild(childRunId, hostRef)
}

async function defaultControl(runId: string, action: "resume" | "stop") {
  const { controlSquadRun } = await import("./squad-control")
  return controlSquadRun(runId, action)
}

async function defaultStartReplacement(input: {
  teamId: string
  parentExecutionRunId: string
  sessionId?: string
}) {
  const { startSquadRun } = await import("./start-squad-run")
  return startSquadRun({
    squadId: input.teamId,
    goal: "",
    origin: "interactive",
    triggeredFrom: { source: "ui" },
    parentRunId: input.parentExecutionRunId,
    ...(input.sessionId
      ? { session: { id: input.sessionId } as import("@cognia/agent-config-types").ChatSession }
      : {}),
  })
}

async function defaultListChildren(runId: string) {
  const { listAgentTeamChildRuns } = await import("@/lib/db/agent-team-runtime")
  return listAgentTeamChildRuns(runId)
}

async function defaultAssessReplay(runId: string) {
  const { assessSquadRunReplay } = await import("./squad-control")
  return assessSquadRunReplay(runId)
}

/** The recovery interrupts already raised for a run, pending or settled. */
async function listRecoveryInterrupts(runId: string): Promise<ExecutionRunInterrupt[]> {
  const rows = await getDb()
    .executionRunInterrupts.where("runId")
    .equals(agentTeamExecutionRunId(runId))
    .toArray()
  return rows.filter((row) => row.type === "team_recovery")
}

/**
 * Raise (or find) the recovery interrupt for a parked run.
 *
 * Idempotent: a pending recovery is returned as is. After one was answered a
 * fresh instance is raised, because the situation the person decided on may
 * have recurred and the earlier receipt must stay what it was.
 */
export async function ensureTeamRecoveryInterrupt(
  runId: string,
  deps: TeamRecoveryDeps = {}
): Promise<{ interruptId: string; pending: boolean } | undefined> {
  const run = await getAgentTeamRun(runId)
  if (!run) return undefined
  if (["completed", "failed", "cancelled"].includes(run.status)) return undefined

  const existing = await listRecoveryInterrupts(runId)
  const pending = existing.find((row) => row.status === "pending")
  if (pending) return { interruptId: pending.id, pending: true }

  // Nothing to re-queue: a legacy row left no children, and a Squad that is
  // not ready cannot dispatch them. Both restart as a new run or stop.
  const legacy =
    run.recoveryReason === LEGACY_RUN_NOT_RESUMABLE || run.recoveryReason === SQUAD_NOT_READY
  const children = legacy ? [] : await (deps.listChildren ?? defaultListChildren)(runId)
  const replay = legacy
    ? { safe: false, uncertainChildIds: [] }
    : await (deps.assessReplay ?? defaultAssessReplay)(runId)
  const hosts = new Set(
    children
      .filter((child) => replay.uncertainChildIds.includes(child.id))
      .map((child) => child.hostRef)
      .filter((host): host is string => Boolean(host))
  )
  const subject: TeamRecoverySubject = {
    reason: run.recoveryReason ?? "recover_needs_input",
    choices: [...(legacy ? LEGACY_RECOVERY_CHOICES : ALL_RECOVERY_CHOICES)],
    uncertainChildIds: replay.uncertainChildIds,
    ...(hosts.size === 1 ? { hostRef: [...hosts][0]! } : {}),
  }
  const instance = `r${existing.length + 1}`
  return (deps.arm ?? defaultArm)({
    runId,
    teamId: run.teamId,
    ...(run.projectId ? { projectId: run.projectId } : {}),
    instance,
    subject,
  })
}

/**
 * Bootstrap re-arm: every run parked on a recovery reason gets its interrupt
 * back if the one it had did not survive (or was never raised, as with a
 * legacy row the history import just created).
 */
export async function armPendingTeamRecoveries(
  deps: TeamRecoveryDeps = {}
): Promise<{ armed: number; alreadyPending: number }> {
  const candidates = await listAgentTeamRecoveryCandidates().catch(() => [] as AgentTeamRunRecord[])
  const parked = (await listAgentTeamRuns().catch(() => [] as AgentTeamRunRecord[])).filter(
    (run) =>
      run.status === "needs_input" && run.recoveryReason && RECOVERY_REASONS.has(run.recoveryReason)
  )
  const seen = new Set<string>()
  let armed = 0
  let alreadyPending = 0
  for (const run of [...parked, ...candidates]) {
    if (seen.has(run.id)) continue
    seen.add(run.id)
    if (run.status !== "needs_input") continue
    const before = await listRecoveryInterrupts(run.id)
    const result = await ensureTeamRecoveryInterrupt(run.id, deps).catch(() => undefined)
    if (!result) continue
    if (before.some((row) => row.status === "pending")) alreadyPending += 1
    else armed += 1
  }
  return { armed, alreadyPending }
}

/**
 * Apply an answered recovery. Called by the team control handler after the
 * gate persisted the decision. Throws nothing: the result says what happened,
 * and the handler decides whether that is a rejection.
 */
export async function applyTeamRecoveryDecision(
  runId: string,
  interrupt: Pick<ExecutionRunInterrupt, "subject">,
  outcome: "approve" | "deny",
  decision: SquadReviewDecision | undefined,
  deps: TeamRecoveryDeps = {}
): Promise<TeamRecoveryApplyResult> {
  const result = await applyTeamRecoveryDecisionInner(runId, interrupt, outcome, decision, deps)
  const { recordSquadRecoveryOutcome } = await import("./squad-telemetry")
  recordSquadRecoveryOutcome({
    runId,
    choice: result.choice,
    applied: result.applied,
    ...(result.reason ? { reason: result.reason } : {}),
  })
  return result
}

async function applyTeamRecoveryDecisionInner(
  runId: string,
  interrupt: Pick<ExecutionRunInterrupt, "subject">,
  outcome: "approve" | "deny",
  decision: SquadReviewDecision | undefined,
  deps: TeamRecoveryDeps = {}
): Promise<TeamRecoveryApplyResult> {
  const choice: TeamRecoveryChoice =
    outcome === "deny" || decision?.kind !== "team_recovery" ? "terminate" : decision.choice
  const offered = (interrupt.subject as Partial<TeamRecoverySubject> | undefined)?.choices
  if (offered && !offered.includes(choice)) {
    return { applied: false, choice, reason: "choice_not_offered" }
  }
  const run = await getAgentTeamRun(runId)
  if (!run) return { applied: false, choice, reason: "run_not_found" }
  const control = deps.control ?? defaultControl

  if (choice === "terminate") {
    const result = await control(runId, "stop")
    return result.ok || result.reason === "already_terminal"
      ? { applied: true, choice }
      : { applied: false, choice, reason: "control_refused" }
  }

  if (choice === "restart_run") {
    // The conversation, if the parked run had one, lives on its execution
    // run row. The replacement keeps it so the chat sees the new run.
    const parentExecution = await getExecutionRun(agentTeamExecutionRunId(runId)).catch(
      () => undefined
    )
    const started = await (deps.startReplacement ?? defaultStartReplacement)({
      teamId: run.teamId,
      parentExecutionRunId: agentTeamExecutionRunId(runId),
      ...(parentExecution?.sessionId ? { sessionId: parentExecution.sessionId } : {}),
    })
    if (!started.started || !started.executionRunId) {
      return { applied: false, choice, reason: "restart_refused" }
    }
    // The old run stops AFTER the replacement exists, so a failed launch
    // leaves the parked run where a person can still decide.
    await control(runId, "stop").catch(() => undefined)
    return { applied: true, choice, replacementExecutionRunId: started.executionRunId }
  }

  // retry_same_host / retry_host: re-queue the uncertain children, then
  // resume. A re-queued child counts as safe to the replay check, so the
  // resume re-enters the lifecycle instead of parking again.
  const uncertain =
    (interrupt.subject as Partial<TeamRecoverySubject> | undefined)?.uncertainChildIds ??
    (await (deps.assessReplay ?? defaultAssessReplay)(runId)).uncertainChildIds
  const hostRef =
    choice === "retry_host" && decision?.kind === "team_recovery" ? decision.hostRef : undefined
  const retry = deps.retryChild ?? defaultRetryChild
  for (const childId of uncertain) {
    try {
      await retry(childId, hostRef)
    } catch {
      // The coordinator refuses a cross-host move without a safe checkpoint.
      // Nothing was re-queued for that child, and the run stays parked.
      return { applied: false, choice, reason: "cross_host_unsafe" }
    }
  }
  const resumed = await control(runId, "resume")
  return resumed.ok
    ? { applied: true, choice }
    : { applied: false, choice, reason: "control_refused" }
}

/** The handler-side entry: read the settled interrupt and apply it. */
export async function applyTeamRecoveryFromControl(
  command: RunControlCommand,
  deps: TeamRecoveryDeps = {}
): Promise<TeamRecoveryApplyResult> {
  if (!command.interruptId) {
    return { applied: false, choice: "terminate", reason: "interrupt_not_found" }
  }
  const row = await getDb().executionRunInterrupts.get(command.interruptId)
  if (!row || row.runId !== command.runId) {
    return { applied: false, choice: "terminate", reason: "interrupt_not_found" }
  }
  if (row.type !== "team_recovery") {
    return { applied: false, choice: "terminate", reason: "not_a_recovery" }
  }
  const runId = command.runId.startsWith("execution:team:")
    ? command.runId.slice("execution:team:".length)
    : command.runId
  return applyTeamRecoveryDecision(
    runId,
    row,
    command.action === "approve" ? "approve" : "deny",
    command.reviewDecision ?? row.decision,
    deps
  )
}
