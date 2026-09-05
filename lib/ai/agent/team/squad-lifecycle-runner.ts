/**
 * Run one Squad lifecycle against the live store, from prepared records to
 * settlement.
 *
 * This is the body `agentTeamManager.start/resume` used to carry inline. It
 * moved here so `startSquadRun` (ADR-0140's one launch seam) and the resume
 * path of `squad-control.ts` execute the SAME code: assemble the runtime deps,
 * run `runTeamLifecycle`, then settle the durable run, the execution row, the
 * GitHub delivery graph and the scheduler event. Two copies of that tail were
 * how a legacy run's execution row once stayed `running` for good.
 *
 * Nothing in here decides whether a run MAY start. Readiness, the duplicate
 * live-run rule and the transactional record creation belong to
 * `start-squad-run.ts`. This module assumes both rows exist.
 */

import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { stackedDeliveryOn } from "@/lib/stack/team-policy"
import type { AgentTeammate, SendMessageInput, TeamTaskStatus } from "@/types/agent/agent-team"
import type { AgentTeamRunStatus } from "@/types/agent/agent-team-runtime"
import type { WorkflowTriggeredFrom } from "@/types/workflow/visual"
import type { AgentPermissionCeiling } from "@/types/agent/permission-ceiling"
import {
  runTeamLifecycle,
  type RunTeamLifecycleDeps,
  type RunTeamLifecycleResult,
} from "../agent-team-runtime"
import type { TeamRunOrigin } from "./gate-policy"

/**
 * Pluggable runtime dependencies. Normally set at bootstrap via
 * `configureAgentTeamRuntime`. When that never ran (headless, CLI, scheduler,
 * tests), the runner lazily builds the side-effect-free defaults instead of
 * dying. An explicit configuration still wins.
 */
export type ConfiguredSquadRuntimeDeps = Pick<
  RunTeamLifecycleDeps,
  | "runLeadPlanning"
  | "runLeadReview"
  | "notifierDeps"
  | "resolveTeamRepo"
  | "resolvePrObserveOctokit"
  | "runPrReview"
>

let configuredDeps: ConfiguredSquadRuntimeDeps | null = null

export function configureAgentTeamRuntime(deps: ConfiguredSquadRuntimeDeps): void {
  configuredDeps = deps
}

export function __resetAgentTeamRuntimeForTesting(): void {
  configuredDeps = null
}

export async function ensureConfiguredSquadRuntimeDeps(): Promise<ConfiguredSquadRuntimeDeps> {
  if (configuredDeps) return configuredDeps
  const { buildAgentTeamRuntimeDeps } = await import("../agent-team-runtime-deps")
  configuredDeps = buildAgentTeamRuntimeDeps()
  console.warn(
    "[agent-team] runtime auto-configured with defaults: " +
      "configureAgentTeamRuntime() was never called (bootstrap not mounted?)."
  )
  return configuredDeps
}

export function bindSquadStoreReader(): RunTeamLifecycleDeps["storeReader"] {
  return {
    getTeam: (id) => useAgentTeamStore.getState().getTeam(id),
    getTeammates: (teamId) => useAgentTeamStore.getState().getTeammates(teamId),
    getTeamTasks: (teamId) => useAgentTeamStore.getState().getTeamTasks(teamId),
  }
}

export function bindSquadStoreWriter(): RunTeamLifecycleDeps["storeWriter"] {
  return {
    addMessage: (input: SendMessageInput) => useAgentTeamStore.getState().addMessage(input),
    setTaskStatus: (taskId: string, status: TeamTaskStatus, result?: string, error?: string) =>
      useAgentTeamStore.getState().setTaskStatus(taskId, status, result, error),
    updateTeammate: (teammateId: string, updates: Partial<AgentTeammate>) =>
      useAgentTeamStore.getState().updateTeammate(teammateId, updates),
    setFinalResult: (teamId: string, result: string) =>
      useAgentTeamStore.getState().updateTeam(teamId, { finalResult: result }),
    addTask: (input) => useAgentTeamStore.getState().createTask(input),
    updateTask: (taskId, updates) => useAgentTeamStore.getState().updateTask(taskId, updates),
    addEvent: (event) => useAgentTeamStore.getState().addEvent(event),
    addTeammate: (input) => useAgentTeamStore.getState().addTeammate(input),
  }
}

/**
 * Task statuses a resume does NOT re-dispatch: finished and dropped work stays
 * so, and `review` awaits a human verdict on the board.
 */
export const RESUME_SKIP_STATUSES: ReadonlySet<TeamTaskStatus> = new Set([
  "completed",
  "cancelled",
  "review",
])

export const resumeTaskFilter: NonNullable<RunTeamLifecycleDeps["taskFilter"]> = (task) =>
  !RESUME_SKIP_STATUSES.has(task.status)

/**
 * Put a team's board back into a resumable shape after its lifecycle exited.
 *
 * Tasks the exited run left mid-flight belong to no live run any more, so they
 * go back to `pending` with their run-owned fields cleared. Teammates stuck in
 * run-owned statuses are reset. The blackboard is re-seeded from persisted
 * results (shared memory is in-memory only, so a restart empties it, and the
 * surviving tasks would otherwise read empty upstream results).
 *
 * Returns how many tasks are still runnable, so the caller can settle a team
 * with nothing left instead of entering a lifecycle that fails on it.
 */
export const SQUAD_NOT_READY_REASON = "squad_not_ready"

export interface GuardSquadResumeDeps {
  evaluate?: (
    team: AgentTeam,
    teammates: readonly AgentTeammate[]
  ) => Promise<{ ready: boolean; blockers: Array<{ code: string }> }>
  park?: (runId: string, teamId: string) => Promise<void>
  now?: () => number
}

/**
 * The readiness gate every RE-ENTRY passes (ADR-0169). `startSquadRun` refuses
 * a blocked Squad before it writes anything. A resume or a restart-time
 * recovery arrives with the run record already written, so a blocked Squad
 * is PARKED instead: `needs_input` with the `squad_not_ready` reason, a
 * `run.recovery_required` event, and a `team_recovery` review whose only
 * choices are restart or terminate. Nothing dispatches on a Squad that could
 * not have started.
 */
export async function guardSquadResume(
  teamId: string,
  runId: string,
  deps: GuardSquadResumeDeps = {}
): Promise<{ blocked: boolean; blockers: Array<{ code: string }> }> {
  const store = useAgentTeamStore.getState()
  const team = store.teams[teamId]
  if (!team) return { blocked: false, blockers: [] }
  const teammates = Object.values(store.teammates).filter((m) => m.teamId === teamId)
  const evaluate =
    deps.evaluate ??
    (async (t: AgentTeam, ms: readonly AgentTeammate[]) => {
      const { evaluateSquadReadiness } = await import("@/lib/agent-team/squad-readiness")
      return evaluateSquadReadiness({ team: t, teammates: ms })
    })
  const readiness = await evaluate(team, teammates)
  if (readiness.ready) return { blocked: false, blockers: [] }
  await (deps.park ?? defaultParkUnreadyRun)(runId, teamId)
  return { blocked: true, blockers: readiness.blockers }
}

async function defaultParkUnreadyRun(runId: string, teamId: string): Promise<void> {
  const at = Date.now()
  const [
    { updateAgentTeamRun },
    { agentTeamExecutionRunId },
    { runEventJournal, semanticRunEvent, getExecutionRun },
  ] = await Promise.all([
    import("@/lib/db/agent-team-runtime"),
    import("@/lib/execution/agent-team-bridge"),
    import("@/lib/db/execution-runs"),
  ])
  await updateAgentTeamRun(runId, {
    status: "needs_input",
    recoveryReason: SQUAD_NOT_READY_REASON,
    updatedAt: at,
  })
  const executionRunId = agentTeamExecutionRunId(runId)
  const executionRun = await getExecutionRun(executionRunId).catch(() => undefined)
  if (executionRun && !["completed", "failed", "cancelled"].includes(executionRun.status)) {
    await runEventJournal
      .append(
        executionRunId,
        semanticRunEvent(
          "run.recovery_required",
          { reason: SQUAD_NOT_READY_REASON },
          { ts: at, sourceEventId: `agent-team:${runId}:recovery_required:${at}` }
        )
      )
      .catch(() => undefined)
  }
  useAgentTeamStore.getState().setTeamStatus(teamId, "paused")
  const { ensureTeamRecoveryInterrupt } = await import("./team-recovery")
  await ensureTeamRecoveryInterrupt(runId).catch(() => undefined)
}

export async function prepareSquadResume(teamId: string): Promise<{ remaining: number }> {
  const store = useAgentTeamStore.getState()
  const teamTasks = Object.values(store.tasks).filter((t) => t.teamId === teamId)
  for (const t of teamTasks) {
    if (t.status === "claimed" || t.status === "in_progress") {
      store.updateTask(t.id, {
        status: "pending",
        claimedBy: undefined,
        startedAt: undefined,
        completedAt: undefined,
        actualDuration: undefined,
      })
    }
  }
  for (const m of Object.values(store.teammates).filter((m) => m.teamId === teamId)) {
    if (
      m.status === "executing" ||
      m.status === "planning" ||
      m.status === "paused" ||
      m.status === "awaiting_approval"
    ) {
      store.updateTeammate(m.id, { status: "idle", currentTaskId: undefined })
    }
  }
  const { autoPublishTaskResult } = await import("./shared-memory-orchestrator")
  for (const t of teamTasks) {
    if (t.status === "completed" && typeof t.result === "string" && t.result.length > 0) {
      const writer = t.claimedBy ? useAgentTeamStore.getState().teammates[t.claimedBy] : undefined
      autoPublishTaskResult({ id: teamId }, t, t.result, writer ?? { id: "system", name: "System" })
    }
  }
  const remaining = Object.values(useAgentTeamStore.getState().tasks).filter(
    (t) => t.teamId === teamId && !RESUME_SKIP_STATUSES.has(t.status)
  ).length
  return { remaining }
}

export interface RunSquadLifecycleInput {
  teamId: string
  /** The durable run id. Its records already exist. */
  runId: string
  origin?: TeamRunOrigin | string
  triggeredFrom?: WorkflowTriggeredFrom
  sessionId?: string
  ultracode?: boolean
  taskFilter?: RunTeamLifecycleDeps["taskFilter"]
  planApprovalDelegate?: RunTeamLifecycleDeps["planApprovalDelegate"]
  requirePlanApprovalFloor?: boolean
  permissionCeiling?: AgentPermissionCeiling
  sessionWorkingDir?: string
  /** Persona to enter the Squad as, resolved by the caller. */
  entryPersona?: { id: string; name: string; systemPrompt: string }
  traceId?: string
}

export interface RunSquadLifecycleDeps {
  /** Overrides the configured deps, for tests and for a caller-bound persona. */
  runtimeDeps?: ConfiguredSquadRuntimeDeps
  run?: typeof runTeamLifecycle
}

/**
 * Execute the lifecycle and settle everything it owns. Never throws on the
 * run's own failure: the result carries the status and the journal carries the
 * event. Throws only when the store has no such team.
 */
export async function runSquadLifecycle(
  input: RunSquadLifecycleInput,
  deps: RunSquadLifecycleDeps = {}
): Promise<RunTeamLifecycleResult> {
  const { teamId, runId } = input
  let runtimeDeps = deps.runtimeDeps
  if (!runtimeDeps) {
    if (input.entryPersona) {
      const { buildAgentTeamRuntimeDeps } = await import("../agent-team-runtime-deps")
      runtimeDeps = buildAgentTeamRuntimeDeps({ entryPersona: input.entryPersona })
    } else {
      runtimeDeps = await ensureConfiguredSquadRuntimeDeps()
    }
  }
  const run = deps.run ?? runTeamLifecycle

  // The store's `status` is a mirror of the durable run, written here and only
  // here (ADR-0169): surfaces read the run record, and the mirror exists so
  // synchronous callers (board guards, presence) do not each open a query.
  useAgentTeamStore.getState().setTeamStatus(teamId, "executing")

  // The root span. Teammate dispatch spans join it through `traceId`, reviews
  // and recovery hang off it, and the terminal reason closes it.
  const { startSquadRunSpan } = await import("./squad-telemetry")
  const team = useAgentTeamStore.getState().teams[teamId]
  const rootSpan = startSquadRunSpan({
    runId,
    teamId,
    ...(team?.projectId ? { projectId: team.projectId } : {}),
    ...(input.origin ? { origin: input.origin } : {}),
    ...(input.traceId ? { traceId: input.traceId } : {}),
  })

  const result = await run(teamId, {
    runId,
    storeReader: bindSquadStoreReader(),
    storeWriter: bindSquadStoreWriter(),
    runLeadPlanning: runtimeDeps.runLeadPlanning,
    ...(runtimeDeps.runLeadReview ? { runLeadReview: runtimeDeps.runLeadReview } : {}),
    notifierDeps: runtimeDeps.notifierDeps,
    ...(runtimeDeps.resolveTeamRepo ? { resolveTeamRepo: runtimeDeps.resolveTeamRepo } : {}),
    ...(runtimeDeps.resolvePrObserveOctokit
      ? { resolvePrObserveOctokit: runtimeDeps.resolvePrObserveOctokit }
      : {}),
    ...(runtimeDeps.runPrReview ? { runPrReview: runtimeDeps.runPrReview } : {}),
    ...(input.origin ? { origin: input.origin as TeamRunOrigin } : {}),
    ...(input.triggeredFrom ? { triggeredFrom: input.triggeredFrom } : {}),
    ...(input.taskFilter ? { taskFilter: input.taskFilter } : {}),
    ...(input.planApprovalDelegate ? { planApprovalDelegate: input.planApprovalDelegate } : {}),
    ...(input.requirePlanApprovalFloor ? { requirePlanApprovalFloor: true } : {}),
    ...(input.permissionCeiling ? { parentPermissionCeiling: input.permissionCeiling } : {}),
    ...(input.sessionWorkingDir ? { sessionWorkingDir: input.sessionWorkingDir } : {}),
    traceId: input.traceId ?? rootSpan.traceId,
    // Manual "Run with ultracode" forces orchestration, an explicit normal run
    // turns it off, omitted lets the team's autoMode decide.
    ...(input.ultracode === true
      ? { ultracodeOverride: "force" as const }
      : input.ultracode === false
        ? { ultracodeOverride: "off" as const }
        : {}),
  })

  await settleSquadRun(teamId, runId, result, runtimeDeps)
  return result
}

/** Close the root span with the terminal status, the reason code and the token totals. */
async function closeSquadRunSpan(
  runId: string,
  durableRun: { status: AgentTeamRunStatus; recoveryReason?: string } | undefined,
  result: RunTeamLifecycleResult
): Promise<void> {
  const [{ endSquadRunSpan, squadDuplicateControlCount }, { aggregateAgentTeamRunUsage }] =
    await Promise.all([import("./squad-telemetry"), import("@/lib/db/agent-team-runtime")])
  const parked = durableRun?.status === "needs_input" || durableRun?.status === "paused"
  // Suites stub the db module without the aggregate. No totals is a span
  // without usage, not a failed settle.
  const totals =
    typeof aggregateAgentTeamRunUsage === "function"
      ? ((await aggregateAgentTeamRunUsage(runId).catch(() => undefined)) as
          Record<string, unknown> | undefined)
      : undefined
  const num = (key: string) => (typeof totals?.[key] === "number" ? (totals[key] as number) : 0)
  endSquadRunSpan({
    runId,
    terminalStatus: parked ? durableRun!.status : result.status,
    ...(durableRun?.recoveryReason
      ? { terminalReason: durableRun.recoveryReason }
      : result.reason
        ? { terminalReason: result.reason }
        : {}),
    ...(totals
      ? {
          usage: {
            inputTokens: num("promptTokens"),
            outputTokens: num("completionTokens"),
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
          },
        }
      : {}),
    duplicateControls: squadDuplicateControlCount(runId),
  })
}

/**
 * Settle after the lifecycle returned: mirror the terminal status, settle the
 * execution row, publish the GitHub stack, emit the scheduler event.
 */
async function settleSquadRun(
  teamId: string,
  runId: string,
  result: RunTeamLifecycleResult,
  runtimeDeps: ConfiguredSquadRuntimeDeps
): Promise<void> {
  const [{ getAgentTeamRun, updateAgentTeamRun }, { settleAgentTeamExecutionRun }] =
    await Promise.all([
      import("@/lib/db/agent-team-runtime"),
      import("@/lib/execution/agent-team-bridge"),
    ])
  const durableRun = await getAgentTeamRun(runId).catch(() => undefined)
  const durableStatus: AgentTeamRunStatus | undefined = durableRun?.status

  useAgentTeamStore
    .getState()
    .setTeamStatus(
      teamId,
      durableStatus === "needs_input" || durableStatus === "paused" ? "paused" : result.status
    )

  const terminal = ["completed", "failed", "cancelled"].includes(result.status)
  await closeSquadRunSpan(runId, durableRun, result)
  if (durableRun && durableStatus !== "needs_input" && durableStatus !== "paused" && terminal) {
    await settleAgentTeamExecutionRun(
      durableRun,
      result.status as "completed" | "failed" | "cancelled"
    ).catch(() => undefined)
  }

  const team = useAgentTeamStore.getState().teams[teamId]
  if (
    team &&
    durableRun &&
    result.status === "completed" &&
    stackedDeliveryOn(team.config.githubDeliveryPolicy)
  ) {
    const { prepareAndPublishGithubStack } = await import("./github-delivery-adapter")
    try {
      await prepareAndPublishGithubStack(team, runId, {
        resolveTeamRepo: runtimeDeps.resolveTeamRepo,
        resolveOctokit: runtimeDeps.resolvePrObserveOctokit,
      })
    } catch (error) {
      // A reason CODE on the run. The message stays out of the record: it is
      // provider text, and the row is projected onto every surface.
      await updateAgentTeamRun(runId, {
        status: "needs_input",
        recoveryReason: "delivery_failed",
        updatedAt: Date.now(),
      }).catch(() => undefined)
      useAgentTeamStore.getState().setTeamStatus(teamId, "paused")
      console.warn("[agent-team] GitHub delivery failed", { runId, error })
      return
    }
  }

  if (durableStatus !== "needs_input") {
    void emitTeamCompletedSchedulerEvent(teamId, result.status)
  }
}

/**
 * Emit an `agent-team:completed` scheduler event when a team run reaches a
 * terminal status, so event-triggered scheduled tasks (and forward chains) can
 * react. Lazy import and best-effort.
 */
export async function emitTeamCompletedSchedulerEvent(
  teamId: string,
  status: string
): Promise<void> {
  try {
    const { emitSchedulerEvent } = await import("@/lib/scheduler/event-integration")
    await emitSchedulerEvent("agent-team:completed", { teamId, status }, "agent-team")
  } catch {
    // Scheduler unavailable (web-only path). Best-effort.
  }
}
