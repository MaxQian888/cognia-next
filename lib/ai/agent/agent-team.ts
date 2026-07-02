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
  shutdown(id: string): Promise<void>
}

/**
 * Pluggable runtime dependencies. Normally set at app startup via
 * `configureAgentTeamRuntime` (the React initializer). When that never ran
 * (headless / CLI / scheduler-triggered runs, SSR, tests), `start()` lazily
 * builds the side-effect-free defaults instead of dying — an explicit
 * `configureAgentTeamRuntime` still wins.
 */
type ConfiguredDeps = Pick<RunTeamLifecycleDeps, "runLeadPlanning" | "notifierDeps">
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
  }
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
    const deps = await ensureConfiguredDeps()
    useAgentTeamStore.getState().setTeamStatus(id, "executing")
    const result = await runTeamLifecycle(id, {
      storeReader: bindStoreReader(),
      storeWriter: bindStoreWriter(),
      runLeadPlanning: deps.runLeadPlanning,
      notifierDeps: deps.notifierDeps,
      ...(opts?.origin ? { origin: opts.origin } : {}),
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
  },
  pause: async (id) => {
    abortTeam(id, new Error("paused"))
    useAgentTeamStore.getState().setTeamStatus(id, "paused")
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
