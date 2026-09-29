import type { Project, ProjectCoordinatorConfig } from "@/types"
import { useProjectStore } from "@/stores/project/project-store"
import { patchCoordinatorConfig } from "./config"

/**
 * The one place project-coordinator code reads and writes a workspace row.
 * Goes through the project store so every write persists, announces the
 * update to plugins, and re-renders every surface showing the workspace.
 */

export interface ProjectAccess {
  getProject: (projectId: string) => Project | undefined
  updateCoordinator: (projectId: string, patch: Partial<ProjectCoordinatorConfig>) => Project
}

export function getProject(projectId: string): Project | undefined {
  return useProjectStore.getState().projects.find((project) => project.id === projectId)
}

/** Merge `patch` into the workspace's coordinator config; throws for an unknown workspace. */
export function updateCoordinator(
  projectId: string,
  patch: Partial<ProjectCoordinatorConfig>
): Project {
  const project = getProject(projectId)
  if (!project) throw new Error(`Workspace ${projectId} was not found`)
  useProjectStore.getState().updateProject(projectId, {
    coordinator: patchCoordinatorConfig(project.coordinator, patch),
  })
  return getProject(projectId) ?? project
}

export const projectAccess: ProjectAccess = { getProject, updateCoordinator }
