/**
 * Creating a squad, including the part that has to happen asynchronously.
 *
 * Every Squad is created on the one durable contract (ADR-0169). What varies
 * per workspace is whether the two bindings the coordinator needs can be
 * resolved at creation time: the primary repository and the environment
 * version. Resolving them needs two Dexie reads and a host preflight, and
 * `createTeam` is a synchronous Zustand action with synchronous callers, so
 * the await lives here, in front of the store.
 *
 * A Squad whose bindings cannot be resolved is still created. It is simply not
 * READY: `evaluateSquadReadiness` names the missing binding, the fleet and the
 * settings panel show it, and `startSquadRun` refuses to dispatch it until it
 * is fixed. There is no legacy runtime to fall back to, so nothing here
 * pretends otherwise.
 */

import { resolveSquadBindingCandidates } from "./binding-candidates"
import { migrateSquadConfig, type SquadBindingCandidates } from "./definition-contract"
import type { AgentTeam, CreateTeamInput } from "@/types/agent/agent-team"
import type { Project } from "@/types"

export interface CreateSquadDeps {
  createTeam: (input: CreateTeamInput) => AgentTeam
  project: Project | undefined
  resolveCandidates?: (project: Project | undefined) => Promise<SquadBindingCandidates>
}

export async function createSquad(
  input: CreateTeamInput,
  deps: CreateSquadDeps
): Promise<AgentTeam> {
  const resolve = deps.resolveCandidates ?? resolveSquadBindingCandidates
  let candidates: SquadBindingCandidates = {}
  try {
    candidates = await resolve(deps.project)
  } catch {
    // Discovery is best-effort. A failure here means "no candidate", which the
    // readiness gate reports. It must not stop a user from creating a squad.
    candidates = {}
  }
  // The caller's own bindings win, and a retired selector in the caller's
  // config is dropped rather than honoured. Inference fills only what is
  // absent, under the one-candidate rule.
  const { config } = migrateSquadConfig(input.config ?? {}, candidates)
  return deps.createTeam({ ...input, config })
}
