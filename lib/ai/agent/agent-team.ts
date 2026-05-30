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
  start(id: string, opts?: { ultracode?: boolean }): Promise<void>
  pause(id: string): Promise<void>
  shutdown(id: string): Promise<void>
}

/**
 * Pluggable runtime dependencies. Set at app startup via
 * `configureAgentTeamRuntime`. `null` means start() throws a clear error
 * rather than running with no planning support.
 */
let configuredDeps: Pick<RunTeamLifecycleDeps, "runLeadPlanning" | "notifierDeps"> | null = null

export function configureAgentTeamRuntime(
  deps: Pick<RunTeamLifecycleDeps, "runLeadPlanning" | "notifierDeps">
): void {
  configuredDeps = deps
}

export function __resetAgentTeamRuntimeForTesting(): void {
  configuredDeps = null
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
    if (!configuredDeps) {
      throw new Error(
        "Agent-team runtime is not configured — call configureAgentTeamRuntime(deps) at app startup."
      )
    }
    useAgentTeamStore.getState().setTeamStatus(id, "executing")
    const result = await runTeamLifecycle(id, {
      storeReader: bindStoreReader(),
      storeWriter: bindStoreWriter(),
      runLeadPlanning: configuredDeps.runLeadPlanning,
      notifierDeps: configuredDeps.notifierDeps,
      // Manual "Run with ultracode" forces orchestration; an explicit normal
      // run turns it off. Omitted → the team's autoMode decides.
      ...(opts?.ultracode === true
        ? { ultracodeOverride: "force" as const }
        : opts?.ultracode === false
          ? { ultracodeOverride: "off" as const }
          : {}),
    })
    // Mirror the terminal result onto the store team.status so the workspace
    // page (which currently reads from the store) sees the new state. Long-term
    // the UI should subscribe to workflowRuns directly (PR 5).
    useAgentTeamStore.getState().setTeamStatus(id, result.status)
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
export type { LeadPlanResult, RunTeamLifecycleDeps }

// Helpful explicit no-op for callers (e.g., tests) that may want a runtime
// shape unused-import marker; keeps eslint happy if AgentTeamTask isn't
// referenced elsewhere in this module.
export type { AgentTeamTask }
