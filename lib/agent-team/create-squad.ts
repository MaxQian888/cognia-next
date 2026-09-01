/**
 * Creating a squad, including the part that has to happen asynchronously.
 *
 * `resolveDurableNewTeamConfig` has existed with no caller, so every squad was
 * created on the `legacy` runtime and the only route to durable-v2 was the
 * explicit migration in `components/agent/workspace/durable-operations.tsx`.
 * That is a fine escape hatch and a poor default.
 *
 * It could not simply be called from `createTeam`, which is a synchronous
 * Zustand action with several synchronous callers. Resolving the default needs
 * two Dexie reads and a host preflight. So the await lives here, in front of
 * the store, and the creation entry points call this instead.
 *
 * A squad that cannot be durable is still created. The resolver returns `null`
 * for a workspace with no root, no enabled environment, or a host policy that
 * refuses, and legacy is the honest answer in each of those cases rather than a
 * durable squad that cannot run.
 */

import { resolveDurableNewTeamConfig } from "@/lib/ai/agent/team/durable-new-team"
import type { AgentTeam, CreateTeamInput } from "@/types/agent/agent-team"
import type { Project } from "@/types"

export interface CreateSquadDeps {
  createTeam: (input: CreateTeamInput) => AgentTeam
  project: Project | undefined
  resolveDurable?: typeof resolveDurableNewTeamConfig
}

export async function createSquad(
  input: CreateTeamInput,
  deps: CreateSquadDeps
): Promise<AgentTeam> {
  const resolve = deps.resolveDurable ?? resolveDurableNewTeamConfig
  let durable: Partial<AgentTeam["config"]> | null = null
  try {
    durable = await resolve(deps.project)
  } catch {
    // Discovery is best-effort. A failure here means "no durable default
    // available", which is exactly what legacy already is, so it must not stop
    // a user from creating a squad.
    durable = null
  }
  // The caller's own config wins. A template or an explicit choice naming a
  // runtime is a decision, and a discovered default must not overrule it.
  return deps.createTeam({
    ...input,
    config: { ...(durable ?? {}), ...(input.config ?? {}) },
  })
}
