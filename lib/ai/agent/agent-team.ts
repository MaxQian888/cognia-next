/**
 * `agentTeamManager` facade over the Zustand `agent-team-store`.
 *
 * `list/get/create/update/delete` proxy the store's CRUD; `start/pause/shutdown`
 * drive the F-path runtime via `agent-team-runtime`'s `runTeamLifecycle` +
 * `abortTeam` (ADR-0022).
 *
 * The runtime needs `runLeadPlanning` (and optional `notifierDeps`) injected
 * via `configureAgentTeamRuntime` at app startup. The facade itself binds the
 * live Zustand store as `storeReader` + `storeWriter` on each `start()` call.
 */

import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { mintSquadRunId } from "./team/start-squad-run"
import { stackedDeliveryOn } from "@/lib/stack/team-policy"
import type {
  AgentTeam,
  AgentTeammate,
  AgentTeamTask,
  SendMessageInput,
  TeamTaskStatus,
} from "@/types/agent/agent-team"
import {
  abortTeam,
  runTeamLifecycle,
  type LeadPlanResult,
  type RunTeamLifecycleDeps,
} from "./agent-team-runtime"

export type AgentTeamConfig = AgentTeam

export interface AgentTeamManager {
  list(): AgentTeam[]
  get(id: string): AgentTeam | undefined
  create(config: AgentTeamConfig): AgentTeam
  update(id: string, patch: Partial<AgentTeamConfig>): void
  delete(id: string): void
  start(
    id: string,
    opts?: {
      ultracode?: boolean
      /** Trigger origin; headless origins resolve HITL gates via gate-policy. */
      origin?: import("./team/gate-policy").TeamRunOrigin
      /**
       * The conversation that asked for this run, when the caller has one.
       * Names the thread on the execution row so a gate can find its way back
       * to what is waiting — see `TeamExecutionRunSeed.sessionId`.
       */
      sessionId?: string
    }
  ): Promise<void>
  pause(id: string): Promise<void>
  /**
   * Resume a paused team: unstrand the tasks the aborted run left in
   * `claimed`/`in_progress` (→ `pending`), reset stuck teammates, re-seed the
   * blackboard from persisted results (a restart empties the in-memory
   * shared memory), then re-enter the lifecycle over the not-yet-done tasks
   * only. No-op unless the team is `paused`.
   */
  resume(
    id: string,
    opts?: Parameters<AgentTeamManager["start"]>[1],
    /**
     * The run being resumed, when the caller is addressing one.
     *
     * Omitted, a resume mints a fresh run id, which is right for the Squad
     * console: it addresses a TEAM and has no particular run in mind. The run
     * cockpit addresses one row, so it passes that row's id and the remaining
     * work continues under the same run instead of stranding the row it was
     * pressed on at `paused` for good.
     */
    existingRunId?: string
  ): Promise<void>
  retryChild(childRunId: string, optionalHostRef?: string): Promise<void>
  shutdown(id: string): Promise<void>
}

/**
 * Pluggable runtime dependencies. Normally set at app startup via
 * `configureAgentTeamRuntime` (the React initializer). When that never ran
 * (headless / CLI / scheduler-triggered runs, SSR, tests), `start()` lazily
 * builds the side-effect-free defaults instead of dying — an explicit
 * `configureAgentTeamRuntime` still wins.
 */
type ConfiguredDeps = Pick<
  RunTeamLifecycleDeps,
  | "runLeadPlanning"
  | "runLeadReview"
  | "notifierDeps"
  | "resolveTeamRepo"
  | "resolvePrObserveOctokit"
  | "runPrReview"
>
let configuredDeps: ConfiguredDeps | null = null

export function configureAgentTeamRuntime(deps: ConfiguredDeps): void {
  configuredDeps = deps
}

export function __resetAgentTeamRuntimeForTesting(): void {
  configuredDeps = null
}

/**
 * Return the configured runtime deps, or lazily build the default deps when
 * the startup initializer never ran. `buildAgentTeamRuntimeDeps()` is
 * side-effect-free and produces safe defaults, so dispatch self-heals instead
 * of throwing "runtime is not configured". Dynamic import keeps the default
 * notifier/DB graph out of the SSR/test path unless it's actually needed.
 */
async function ensureConfiguredDeps(): Promise<ConfiguredDeps> {
  if (configuredDeps) return configuredDeps
  const { buildAgentTeamRuntimeDeps } = await import("./agent-team-runtime-deps")
  configuredDeps = buildAgentTeamRuntimeDeps()
  console.warn(
    "[agent-team] runtime auto-configured with defaults — " +
      "configureAgentTeamRuntime() was never called (initializer not mounted?)."
  )
  return configuredDeps
}

function bindStoreReader(): RunTeamLifecycleDeps["storeReader"] {
  return {
    getTeam: (id) => useAgentTeamStore.getState().getTeam(id),
    getTeammates: (teamId) => useAgentTeamStore.getState().getTeammates(teamId),
    getTeamTasks: (teamId) => useAgentTeamStore.getState().getTeamTasks(teamId),
  }
}

function bindStoreWriter(): RunTeamLifecycleDeps["storeWriter"] {
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
    // Adaptive re-plan recruit sink — bring a digital employee onto the team
    // mid-run (see `replan-checkpoint.ts`).
    addTeammate: (input) => useAgentTeamStore.getState().addTeammate(input),
  }
}

/**
 * Task statuses `resume()` does NOT re-dispatch: finished/dropped work stays
 * finished, and `review` awaits a human verdict on the board (completing it
 * automatically would bypass the review column).
 */
const RESUME_SKIP_STATUSES: ReadonlySet<TeamTaskStatus> = new Set([
  "completed",
  "cancelled",
  "review",
])

/**
 * Shared run path for `start` / `resume`: assemble deps, run the lifecycle,
 * mirror the terminal status, emit the completion scheduler event.
 */
async function runManaged(
  id: string,
  opts?: Parameters<AgentTeamManager["start"]>[1],
  taskFilter?: RunTeamLifecycleDeps["taskFilter"],
  existingRunId?: string
): Promise<void> {
  const deps = await ensureConfiguredDeps()
  useAgentTeamStore.getState().setTeamStatus(id, "executing")
  // Mint the run id HERE and record the execution row before the lifecycle
  // starts, the way `startSquadRun` does for chat and IM.
  //
  // ADR-0140 made `startSquadRun` the funnel, but it reaches `runTeamLifecycle`
  // directly, so everything that starts a Squad through the manager — the
  // scheduler, `ctx.agent.runTeam`, the external bridge's `team_run`,
  // `action.team.compose` — produced a run with no journal row at all unless
  // the Squad happened to be `durable-v2`. The cockpit could not list a run
  // that was genuinely happening. This is the manager's half of the same
  // funnel; the ids converge because both derive from
  // `agentTeamExecutionRunId`, so whichever writes first wins.
  //
  // It is not moved into `runTeamLifecycle` because the lifecycle is also what
  // `startSquadRun` calls, which has already created the row (with the
  // conversation binding IM needs) by the time it gets there.
  const runId = existingRunId ?? mintSquadRunId()
  const startingTeam = useAgentTeamStore.getState().teams[id]
  try {
    const { ensureTeamExecutionRun } = await import("@/lib/execution/agent-team-bridge")
    const at = Date.now()
    await ensureTeamExecutionRun({
      sourceRunId: runId,
      objective: startingTeam?.task || startingTeam?.name || id,
      teamId: id,
      ...(startingTeam?.projectId ? { projectId: startingTeam.projectId } : {}),
      ...(opts?.sessionId ? { sessionId: opts.sessionId } : {}),
      startedAt: at,
      updatedAt: at,
    })
  } catch {
    /* best-effort: an unrecorded run still executes */
  }
  const result = await runTeamLifecycle(id, {
    runId,
    storeReader: bindStoreReader(),
    storeWriter: bindStoreWriter(),
    runLeadPlanning: deps.runLeadPlanning,
    ...(deps.runLeadReview ? { runLeadReview: deps.runLeadReview } : {}),
    notifierDeps: deps.notifierDeps,
    ...(deps.resolveTeamRepo ? { resolveTeamRepo: deps.resolveTeamRepo } : {}),
    ...(deps.resolvePrObserveOctokit
      ? { resolvePrObserveOctokit: deps.resolvePrObserveOctokit }
      : {}),
    ...(deps.runPrReview ? { runPrReview: deps.runPrReview } : {}),
    ...(opts?.origin ? { origin: opts.origin } : {}),
    ...(taskFilter ? { taskFilter } : {}),
    // Manual "Run with ultracode" forces orchestration; an explicit normal
    // run turns it off. Omitted → the team's autoMode decides.
    ...(opts?.ultracode === true
      ? { ultracodeOverride: "force" as const }
      : opts?.ultracode === false
        ? { ultracodeOverride: "off" as const }
        : {}),
  })
  let durableRunStatus: import("@/types/agent/agent-team-runtime").AgentTeamRunStatus | undefined
  if (
    result.runId &&
    useAgentTeamStore.getState().teams[id]?.config.runtimeVersion === "durable-v2"
  ) {
    const { getAgentTeamRun } = await import("@/lib/db/agent-team-runtime")
    durableRunStatus = (await getAgentTeamRun(result.runId))?.status
  }
  // Optimistically mirror the terminal result onto store team.status as an
  // in-flight bridge. The authoritative source is the workflowRuns
  // subscription (`useTeamLiveStatus`), which the workspace overview and the
  // teams-list card both consume; `deriveTeamStatus` only lets this
  // optimistic write win while it's still non-terminal.
  useAgentTeamStore
    .getState()
    .setTeamStatus(id, durableRunStatus === "needs_input" ? "paused" : result.status)
  const team = useAgentTeamStore.getState().teams[id]
  if (
    team?.config.runtimeVersion === "durable-v2" &&
    result.runId &&
    durableRunStatus !== "needs_input" &&
    ["completed", "failed", "cancelled"].includes(result.status)
  ) {
    const [{ getAgentTeamRun }, { settleAgentTeamExecutionRun }] = await Promise.all([
      import("@/lib/db/agent-team-runtime"),
      import("@/lib/execution/agent-team-bridge"),
    ])
    const durableRun = await getAgentTeamRun(result.runId)
    if (durableRun) {
      await settleAgentTeamExecutionRun(
        durableRun,
        result.status as "completed" | "failed" | "cancelled"
      )
    }
  }
  if (
    team?.config.runtimeVersion === "durable-v2" &&
    result.status === "completed" &&
    result.runId &&
    stackedDeliveryOn(team.config.githubDeliveryPolicy)
  ) {
    const [{ prepareAndPublishGithubStack }, { updateAgentTeamRun }] = await Promise.all([
      import("./team/github-delivery-adapter"),
      import("@/lib/db/agent-team-runtime"),
    ])
    try {
      await prepareAndPublishGithubStack(team, result.runId, {
        resolveTeamRepo: deps.resolveTeamRepo,
        resolveOctokit: deps.resolvePrObserveOctokit,
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      await updateAgentTeamRun(result.runId, {
        status: "needs_input",
        recoveryReason: `delivery_failed:${reason}`,
        updatedAt: Date.now(),
      })
      useAgentTeamStore.getState().setTeamStatus(id, "paused")
    }
  }
  // Retrospectives are intentionally user-triggered. The generic Run Review
  // surface reads this terminal ExecutionRun and never writes the legacy
  // AgentTeam retrospective table automatically.
  // Emit a scheduler event so event-triggered tasks / forward chains can
  // react to a team finishing. Lazy import + best-effort.
  if (durableRunStatus !== "needs_input") {
    void emitTeamCompletedSchedulerEvent(id, result.status)
  }
}

/** Rebuild durable queues after renderer restart and replay only safe checkpoints. */
export async function recoverDurableAgentTeams(): Promise<
  Array<{ runId: string; status: "recovering" | "needs_input" }>
> {
  const [{ getDurableTeamCoordinator }, { getAgentTeamRun }] = await Promise.all([
    import("./team/durable-runtime"),
    import("@/lib/db/agent-team-runtime"),
  ])
  const outcomes = await getDurableTeamCoordinator().recover()
  await Promise.all(
    outcomes.map(async (outcome) => {
      const run = await getAgentTeamRun(outcome.runId)
      if (!run) return
      const team = useAgentTeamStore.getState().getTeam(run.teamId)
      if (!team || team.config.runtimeVersion !== "durable-v2") return
      if (outcome.status === "needs_input") {
        useAgentTeamStore.getState().setTeamStatus(team.id, "paused")
        return
      }
      await runManaged(
        team.id,
        undefined,
        (task) => !RESUME_SKIP_STATUSES.has(task.status),
        outcome.runId
      )
    })
  )
  return outcomes
}

export const agentTeamManager: AgentTeamManager = {
  list: () => Object.values(useAgentTeamStore.getState().teams),
  get: (id) => useAgentTeamStore.getState().teams[id],
  create: (team) => {
    useAgentTeamStore.getState().upsertTeam(team)
    return team
  },
  update: (id, patch) => {
    useAgentTeamStore.getState().updateTeam(id, patch)
  },
  delete: (id) => {
    useAgentTeamStore.getState().deleteTeam(id)
  },
  start: async (id, opts) => {
    await runManaged(id, opts)
  },
  pause: async (id) => {
    const team = useAgentTeamStore.getState().teams[id]
    if (team?.config.runtimeVersion === "durable-v2") {
      const { listAgentTeamRuns } = await import("@/lib/db/agent-team-runtime")
      const active = (await listAgentTeamRuns(id)).find((run) =>
        ["queued", "running", "pausing", "recovering"].includes(run.status)
      )
      if (active) {
        const { controlDurableRun } = await import("./team/durable-control")
        await controlDurableRun(active.id, "pause")
      }
      useAgentTeamStore.getState().setTeamStatus(id, "paused")
      return
    }
    abortTeam(id, new Error("paused"))
    useAgentTeamStore.getState().setTeamStatus(id, "paused")
    if (!team) return
    const { listAgentTeamRuns, updateAgentTeamRun } = await import("@/lib/db/agent-team-runtime")
    const active = (await listAgentTeamRuns(id)).find((run) =>
      ["queued", "running", "pausing", "recovering"].includes(run.status)
    )
    if (active) await updateAgentTeamRun(active.id, { status: "paused", updatedAt: Date.now() })
  },
  resume: async (id, opts, existingRunId) => {
    const store = useAgentTeamStore.getState()
    const team = store.teams[id]
    if (!team || team.status !== "paused") return
    if (team.config.runtimeVersion === "durable-v2") {
      const { listAgentTeamRuns } = await import("@/lib/db/agent-team-runtime")
      const active = (await listAgentTeamRuns(id)).find((run) =>
        ["paused", "pausing", "sleeping"].includes(run.status)
      )
      if (active) {
        const { controlDurableRun } = await import("./team/durable-control")
        await controlDurableRun(active.id, "resume")
        useAgentTeamStore.getState().setTeamStatus(id, "executing")
        return
      }
    }

    const teamTasks = Object.values(store.tasks).filter((t) => t.teamId === id)

    // Unstrand: tasks the aborted run left mid-flight belong to no live run
    // anymore — push them back to pending with their run-owned fields cleared
    // (same reset moveTask applies on `→ pending`).
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
    // Reset teammates stuck in run-owned statuses.
    for (const m of Object.values(store.teammates).filter((m) => m.teamId === id)) {
      if (
        m.status === "executing" ||
        m.status === "planning" ||
        m.status === "paused" ||
        m.status === "awaiting_approval"
      ) {
        store.updateTeammate(m.id, { status: "idle", currentTaskId: undefined })
      }
    }

    // Re-seed the blackboard from persisted results: shared memory is
    // in-memory only, so after an app restart the resumed run's surviving
    // tasks would read empty upstream results. `autoPublishTaskResult`
    // re-applies the PII gate; publishing over a live entry is idempotent
    // (same task → same value).
    const { autoPublishTaskResult } = await import("./team/shared-memory-orchestrator")
    for (const t of teamTasks) {
      if (t.status === "completed" && typeof t.result === "string" && t.result.length > 0) {
        const writer = t.claimedBy ? useAgentTeamStore.getState().teammates[t.claimedBy] : undefined
        autoPublishTaskResult({ id }, t, t.result, writer ?? { id: "system", name: "System" })
      }
    }

    // Nothing left to run → the team simply is complete.
    const remaining = Object.values(useAgentTeamStore.getState().tasks).filter(
      (t) => t.teamId === id && !RESUME_SKIP_STATUSES.has(t.status)
    )
    if (remaining.length === 0) {
      useAgentTeamStore.getState().setTeamStatus(id, "completed")
      void emitTeamCompletedSchedulerEvent(id, "completed")
      return
    }

    if (existingRunId) {
      // The row this resume was pressed on is `paused`. Say it is running
      // again before the lifecycle starts, or the cockpit shows a paused run
      // doing work until the terminal event lands.
      const { reopenTeamExecutionRun } = await import("@/lib/execution/agent-team-bridge")
      await reopenTeamExecutionRun(existingRunId).catch(() => undefined)
    }
    await runManaged(id, opts, (t) => !RESUME_SKIP_STATUSES.has(t.status), existingRunId)
  },
  retryChild: async (childRunId, optionalHostRef) => {
    const [{ getDurableTeamCoordinator }, { getAgentTeamChildRun }] = await Promise.all([
      import("./team/durable-runtime"),
      import("@/lib/db/agent-team-runtime"),
    ])
    const child = await getAgentTeamChildRun(childRunId)
    if (!child) throw new Error(`Unknown durable child: ${childRunId}`)
    const team = useAgentTeamStore.getState().getTeam(child.teamId)
    if (!team || team.config.runtimeVersion !== "durable-v2") {
      throw new Error("Remote child recovery requires a durable-v2 AgentTeam")
    }
    await getDurableTeamCoordinator().retryChild(childRunId, optionalHostRef)
    useAgentTeamStore.getState().updateTask(child.taskId, {
      status: "pending",
      error: undefined,
      completedAt: undefined,
    })
    await runManaged(team.id, undefined, (task) => task.id === child.taskId, child.runId)
  },
  shutdown: async (id) => {
    abortTeam(id, new Error("shutdown"))
    useAgentTeamStore.getState().setTeamStatus(id, "cancelled")
    const team = useAgentTeamStore.getState().teams[id]
    if (team?.config.runtimeVersion !== "durable-v2") return
    const { listAgentTeamRuns, updateAgentTeamRun } = await import("@/lib/db/agent-team-runtime")
    const active = (await listAgentTeamRuns(id)).find(
      (run) => !["completed", "failed", "cancelled", "terminated"].includes(run.status)
    )
    if (active) {
      await updateAgentTeamRun(active.id, {
        status: "terminated",
        completedAt: Date.now(),
        updatedAt: Date.now(),
      })
    }
  },
}

/**
 * Emit an `agent-team:completed` scheduler event when a team run reaches a
 * terminal status, so event-triggered scheduled tasks (and forward chains) can
 * react. Lazy import + best-effort, mirroring the goal/plan completion linkage.
 */
async function emitTeamCompletedSchedulerEvent(teamId: string, status: string): Promise<void> {
  try {
    const { emitSchedulerEvent } = await import("@/lib/scheduler/event-integration")
    await emitSchedulerEvent("agent-team:completed", { teamId, status }, "agent-team")
  } catch {
    // Scheduler unavailable (e.g. web-only path) — best-effort.
  }
}

// Re-export for callers that want to plug in their own runtime deps
// programmatically (e.g. from a Tauri-aware app shell).
export type { LeadPlanResult, RunTeamLifecycleDeps }

// Helpful explicit no-op for callers (e.g., tests) that may want a runtime
// shape unused-import marker; keeps eslint happy if AgentTeamTask isn't
// referenced elsewhere in this module.
export type { AgentTeamTask }
