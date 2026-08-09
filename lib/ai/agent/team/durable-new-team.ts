import { createLocalTauriExecutionEnvironment } from "../execution/local-tauri-environment"
import {
  listProjectEnvironments,
  listProjectEnvironmentVersions,
} from "@/lib/db/project-environments"
import type { AgentTeamConfig } from "@/types/agent/agent-team"
import type { Project } from "@/types"

export interface DurableNewTeamDependencies {
  listEnvironments?: typeof listProjectEnvironments
  listVersions?: typeof listProjectEnvironmentVersions
  createEnvironment?: typeof createLocalTauriExecutionEnvironment
}

/**
 * Resolve the durable-v2 defaults for a newly-created team. Capability
 * discovery is read-only: setup scripts run only when the team itself starts.
 * A missing root, immutable version, or enforceable host policy deliberately
 * falls back to legacy rather than creating a durable team that cannot run.
 */
export async function resolveDurableNewTeamConfig(
  project: Project | undefined,
  dependencies: DurableNewTeamDependencies = {}
): Promise<Partial<AgentTeamConfig> | null> {
  const repositoryPath = project?.rootDir ?? project?.roots?.find((root) => root.isPrimary)?.path
  if (!project || !repositoryPath) return null

  const loadEnvironments = dependencies.listEnvironments ?? listProjectEnvironments
  const loadVersions = dependencies.listVersions ?? listProjectEnvironmentVersions
  const createEnvironment = dependencies.createEnvironment ?? createLocalTauriExecutionEnvironment
  const environments = (await loadEnvironments(project.id)).filter(
    (environment) => environment.isEnabled
  )
  const adapter = createEnvironment()

  for (const environment of environments) {
    const [latest] = await loadVersions(environment.id)
    if (!latest || !adapter.preflight(latest).ok) continue
    return {
      runtimeVersion: "durable-v2",
      writeMode: "single-writer",
      repositories: [{ id: "primary", role: "primary", path: repositoryPath, writable: true }],
      environmentRef: { environmentId: environment.id, versionId: latest.id },
    }
  }
  return null
}
