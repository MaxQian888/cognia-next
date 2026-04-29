/**
 * Minimal agent-team-compat stub.
 *
 * The Cognia agent-team store dispatches to a "compat" layer that runs
 * the team's teammates against the orchestrator. cognia-next has no
 * orchestrator (yet); this stub exposes a contract-compatible no-op so
 * the team store typechecks. Real dispatch will be added when the
 * orchestrator subsystem is migrated.
 */

export interface AgentTeamCompatDispatchOptions {
  teamId: string
  task?: string
  metadata?: Record<string, unknown>
}

export interface AgentTeamCompatDispatchResult {
  ok: boolean
  reason?: string
}

export async function dispatchAgentTeam(
  _options: AgentTeamCompatDispatchOptions
): Promise<AgentTeamCompatDispatchResult> {
  return { ok: false, reason: "agent-team runtime not yet migrated" }
}

export const agentTeamCompat = {
  dispatch: dispatchAgentTeam,
}

/**
 * Stub normalizer for agent-team config — returns the input unchanged.
 * The real normalizer in Cognia validates teammate IDs against the
 * registry; cognia-next has no registry yet.
 */
export function normalizeAgentTeamConfig<T>(config: T): T {
  return config
}

/**
 * Stub normalizer for agent-team task entries.
 */
export function normalizeAgentTeamTask<T>(task: T): T {
  return task
}
