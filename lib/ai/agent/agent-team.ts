/**
 * Real `agentTeamManager` facade over the Zustand `agent-team-store`.
 *
 * Was previously a no-op stub. Now `list/get/create/update/delete` proxy
 * the store's CRUD; `start/pause/shutdown` drive the runtime via
 * `agent-team-runtime`'s `runTeamLifecycle` + `abortTeam`.
 *
 * The runtime needs a `runTeammateTask` dependency (which talks to the
 * Tauri sidecar in production). To keep this module testable and free
 * of side effects on import, the dep is injected via
 * `configureAgentTeamRuntime` at app startup. Until that's called,
 * `start()` throws "runtime not configured". `pause`/`shutdown` work
 * regardless because they only abort an existing AbortController.
 */

import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import type { AgentTeam } from "@/types/agent/agent-team"
import {
  abortTeam,
  runTeamLifecycle,
  type AgentTeamRuntimeDeps,
  type AgentTeamStoreLike,
  type LeadPlanResult,
  type TeammateTaskResult,
} from "./agent-team-runtime"

export type AgentTeamConfig = AgentTeam
export type AgentTeamTask = unknown
export type AgentTeammate = unknown

export interface AgentTeamManager {
  list(): AgentTeam[]
  get(id: string): AgentTeam | undefined
  create(config: AgentTeamConfig): AgentTeam
  update(id: string, patch: Partial<AgentTeamConfig>): void
  delete(id: string): void
  start(id: string): Promise<void>
  pause(id: string): Promise<void>
  shutdown(id: string): Promise<void>
}

/**
 * Pluggable runtime dependencies. Set at app startup via
 * `configureAgentTeamRuntime`. `null` means start() will throw a clear
 * error rather than running with a no-op runner.
 */
let configuredDeps: Pick<AgentTeamRuntimeDeps, "runTeammateTask" | "runLeadPlanning"> | null = null

export function configureAgentTeamRuntime(
  deps: Pick<AgentTeamRuntimeDeps, "runTeammateTask" | "runLeadPlanning">
): void {
  configuredDeps = deps
}

export function __resetAgentTeamRuntimeForTesting(): void {
  configuredDeps = null
}

/**
 * Bind the Zustand store to the runtime's `AgentTeamStoreLike` shape.
 * Each call re-reads `getState()` so the result reflects current state.
 */
function bindStore(): AgentTeamStoreLike {
  const get = () => useAgentTeamStore.getState()
  return {
    getTeam: (id) => get().getTeam(id),
    getTeammate: (id) => get().getTeammate(id),
    getTeammates: (teamId) => get().getTeammates(teamId),
    getTeamTasks: (teamId) => get().getTeamTasks(teamId),
    setTeamStatus: (teamId, status) => get().setTeamStatus(teamId, status),
    updateTeam: (teamId, updates) => get().updateTeam(teamId, updates),
    setTeammateStatus: (id, status) => get().setTeammateStatus(id, status),
    updateTeammate: (id, updates) => get().updateTeammate(id, updates),
    setTaskStatus: (id, status, result, error) => get().setTaskStatus(id, status, result, error),
    assignTask: (id, teammateId) => get().assignTask(id, teammateId),
    upsertExecutionReport: (teamId, report) => get().upsertExecutionReport(teamId, report),
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
  start: async (id) => {
    if (!configuredDeps) {
      throw new Error(
        "Agent-team runtime is not configured — call configureAgentTeamRuntime(deps) at app startup."
      )
    }
    await runTeamLifecycle(id, {
      store: bindStore(),
      runTeammateTask: configuredDeps.runTeammateTask,
      runLeadPlanning: configuredDeps.runLeadPlanning,
    })
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

// Re-export for callers that want to plug in their own runtime deps
// programmatically (e.g. from a Tauri-aware app shell).
export type { TeammateTaskResult, LeadPlanResult, AgentTeamRuntimeDeps }
