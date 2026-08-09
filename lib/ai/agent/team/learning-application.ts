import {
  getProjectEnvironmentVersion,
  createProjectEnvironmentVersion,
} from "@/lib/db/project-environments"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import type { AgentTeamLearningProposal } from "@/types/agent/agent-team-runtime"
import type { ProjectEnvironment, ProjectEnvironmentPolicy } from "@/types/project-environment"
import { publishEntry } from "./shared-memory-orchestrator"

function parseEnvironmentPatch(after: string): Partial<ProjectEnvironment> & {
  policy?: ProjectEnvironmentPolicy
} {
  try {
    const value = JSON.parse(after) as unknown
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error()
    return value as Partial<ProjectEnvironment> & { policy?: ProjectEnvironmentPolicy }
  } catch {
    throw new Error("Environment learning proposals must contain a JSON object")
  }
}

/** Apply one already-approved proposal through versioned, PII-gated product stores. */
export async function applyApprovedLearningProposal(
  teamId: string,
  proposal: AgentTeamLearningProposal
): Promise<void> {
  if (proposal.status !== "approved") throw new Error("Learning proposal requires approval")
  const store = useAgentTeamStore.getState()
  const team = store.teams[teamId]
  if (!team) throw new Error(`Unknown AgentTeam: ${teamId}`)

  if (proposal.kind === "prompt" || proposal.kind === "decomposition") {
    store.updateTeam(teamId, {
      config: { ...team.config, defaultSystemPrompt: proposal.after },
    })
    return
  }

  if (proposal.kind === "memory_useful" || proposal.kind === "memory_misleading") {
    publishEntry({
      teamId,
      key: `retrospective:${proposal.id}`,
      value: proposal.after,
      writer: { id: "lead", name: "Lead" },
      tags: [proposal.kind, "retrospective-approved"],
    })
    return
  }

  const ref = team.config.environmentRef
  if (!ref) throw new Error("Environment proposal requires a selected environment version")
  const current = await getProjectEnvironmentVersion(ref.versionId)
  if (!current || current.environmentId !== ref.environmentId) {
    throw new Error("Selected environment version is unavailable")
  }
  const patch = parseEnvironmentPatch(proposal.after)
  const environment: ProjectEnvironment = {
    id: current.environmentId,
    projectId: current.projectId,
    name: patch.name ?? current.name,
    isEnabled: true,
    setupScript: patch.setupScript ?? current.setupScript,
    actions: patch.actions ?? current.actions,
    variables: patch.variables ?? current.variables,
    keyringReferences: patch.keyringReferences ?? current.keyringReferences,
    createdAt: current.createdAt,
    updatedAt: Date.now(),
  }
  const version = await createProjectEnvironmentVersion(environment, patch.policy ?? current.policy)
  store.updateTeam(teamId, {
    config: {
      ...team.config,
      environmentRef: { environmentId: version.environmentId, versionId: version.id },
    },
  })
}
