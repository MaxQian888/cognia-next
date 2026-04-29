/**
 * Minimal agent-team manager stub.
 *
 * Cognia exposes an `agentTeamManager` plus `AgentTeamConfig` /
 * `AgentTeamTask` types from this module. cognia-next has not migrated
 * the runtime; we re-export the canonical types from `types/agent/agent-team`
 * and ship a manager facade that yields no teams.
 */

import type { AgentTeam } from "@/types/agent/agent-team"

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

export const agentTeamManager: AgentTeamManager = {
  list: () => [],
  get: () => undefined,
  create: (config) => config as AgentTeam,
  update: () => undefined,
  delete: () => undefined,
  start: async () => undefined,
  pause: async () => undefined,
  shutdown: async () => undefined,
}
