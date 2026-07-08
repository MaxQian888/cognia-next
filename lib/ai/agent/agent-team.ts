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
  resume(id: string, opts?: Parameters<AgentTeamManager["start"]>[1]): Promise<void>
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
  "runLeadPlanning" | "notifierDeps" | "resolveTeamRepo" | "resolvePrObserveOctokit" | "runPrReview"
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
  taskFilter?: RunTeamLifecycleDeps["taskFilter"]
): Promise<void> {
  const deps = await ensureConfiguredDeps()
  useAgentTeamStore.getState().setTeamStatus(id, "executing")
  const result = await runTeamLifecycle(id, {
    storeReader: bindStoreReader(),
    storeWriter: bindStoreWriter(),
    runLeadPlanning: deps.runLeadPlanning,
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
  // Optimistically mirror the terminal result onto store team.status as an
  // in-flight bridge. The authoritative source is the workflowRuns
  // subscription (`useTeamLiveStatus`), which the workspace overview and the
  // teams-list card both consume; `deriveTeamStatus` only lets this
  // optimistic write win while it's still non-terminal.
  useAgentTeamStore.getState().setTeamStatus(id, result.status)
  // Emit a scheduler event so event-triggered tasks / forward chains can
  // react to a team finishing. Lazy import + best-effort.
  void emitTeamCompletedSchedulerEvent(id, result.status)
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
    abortTeam(id, new Error("paused"))
    useAgentTeamStore.getState().setTeamStatus(id, "paused")
  },
  resume: async (id, opts) => {
    const store = useAgentTeamStore.getState()
    const team = store.teams[id]
    if (!team || team.status !== "paused") return

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

    await runManaged(id, opts, (t) => !RESUME_SKIP_STATUSES.has(t.status))
  },
  shutdown: async (id) => {
    abortTeam(id, new Error("shutdown"))
    useAgentTeamStore.getState().setTeamStatus(id, "cancelled")
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
