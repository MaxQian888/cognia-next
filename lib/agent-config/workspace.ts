/**
 * The workspace an agent configuration call reads (ADR-0238).
 *
 * Callers name a workspace explicitly. `undefined` means "the active one", the
 * same default the Prompt Center starts from; `null` means account-only, where
 * no repository file or workspace record is in scope.
 */

import type { PromptResourceContext } from "@/lib/prompts/resources"
import { allRootPaths } from "@/lib/workspace/roots"
import { useProjectStore } from "@/stores/project/project-store"

export interface AgentConfigWorkspace {
  /** `null` when no workspace is in scope. */
  id: string | null
  /** Workspace roots, primary first. Empty without a workspace. */
  roots: string[]
  /** What the Prompt Center adapters read. */
  promptContext: PromptResourceContext
}

/** Thrown for a workspace id that does not exist, so a typo never reads account-only. */
export class AgentConfigWorkspaceError extends Error {
  readonly code = "agent_config_unknown_workspace"
  constructor(readonly workspaceId: string) {
    super(`unknown workspace: ${workspaceId}`)
    this.name = "AgentConfigWorkspaceError"
  }
}

export function resolveAgentConfigWorkspace(
  workspaceId: string | null | undefined
): AgentConfigWorkspace {
  const state = useProjectStore.getState()
  const id = workspaceId === undefined ? state.activeProjectId : workspaceId
  if (!id) return { id: null, roots: [], promptContext: {} }
  const project = state.projects.find((candidate) => candidate.id === id)
  if (!project) throw new AgentConfigWorkspaceError(id)
  const roots = allRootPaths(project)
  return {
    id,
    roots,
    promptContext: {
      workspace: {
        id: project.id,
        name: project.name,
        roots,
        ...(project.customInstructions ? { customInstructions: project.customInstructions } : {}),
      },
    },
  }
}
