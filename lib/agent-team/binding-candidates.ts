/**
 * Find the ONE repository and the ONE environment a Squad may be bound to.
 *
 * Replaces `resolveDurableNewTeamConfig`, which returned a `runtimeVersion:
 * "durable-v2"` config or `null`. There is no runtime to select any more
 * (ADR-0168). What a new or migrating Squad needs is candidates for the two
 * bindings the coordinator requires, resolved under the one-candidate rule
 * that `definition-contract.ts` applies: exactly one deterministic option, or
 * nothing.
 *
 * Read-only. Setup scripts run only when a Squad itself starts.
 */

import { createLocalTauriExecutionEnvironment } from "@/lib/ai/agent/execution/local-tauri-environment"
import {
  listProjectEnvironments,
  listProjectEnvironmentVersions,
} from "@/lib/db/project-environments"
import type { Project } from "@/types"
import type { SquadBindingCandidates } from "./definition-contract"

export interface BindingCandidateDeps {
  listEnvironments?: typeof listProjectEnvironments
  listVersions?: typeof listProjectEnvironmentVersions
  createEnvironment?: typeof createLocalTauriExecutionEnvironment
}

/** The workspace's primary root, when it has exactly one. */
export function projectRepositoryCandidate(project: Project | undefined): string | undefined {
  if (!project) return undefined
  if (project.rootDir) return project.rootDir
  const primaries = (project.roots ?? []).filter((root) => root.isPrimary)
  return primaries.length === 1 ? primaries[0]!.path : undefined
}

export async function resolveSquadBindingCandidates(
  project: Project | undefined,
  deps: BindingCandidateDeps = {}
): Promise<SquadBindingCandidates> {
  const repositoryPath = projectRepositoryCandidate(project)
  if (!project) return {}

  const loadEnvironments = deps.listEnvironments ?? listProjectEnvironments
  const loadVersions = deps.listVersions ?? listProjectEnvironmentVersions
  const adapter = (deps.createEnvironment ?? createLocalTauriExecutionEnvironment)()

  let enabled: Awaited<ReturnType<typeof loadEnvironments>>
  try {
    enabled = (await loadEnvironments(project.id)).filter((environment) => environment.isEnabled)
  } catch {
    return repositoryPath ? { repositoryPath } : {}
  }

  // One candidate means one ENFORCEABLE environment with a version. Several
  // enabled environments is a choice the user has to make, not a guess.
  const usable: Array<{ environmentId: string; versionId: string }> = []
  for (const environment of enabled) {
    const [latest] = await loadVersions(environment.id).catch(() => [])
    if (!latest || !adapter.preflight(latest).ok) continue
    usable.push({ environmentId: environment.id, versionId: latest.id })
  }

  return {
    ...(repositoryPath ? { repositoryPath } : {}),
    ...(usable.length === 1 ? { environment: usable[0] } : {}),
  }
}
