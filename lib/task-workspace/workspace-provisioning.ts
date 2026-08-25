/**
 * What a managed worktree gets provisioned with, for any caller that is about
 * to acquire one.
 *
 * # Why this is not inside `session-bundle`
 *
 * Six places acquire a workspace bundle — a chat turn, an Agent Team dispatch,
 * a scheduled task, a connector auto-reply, an agent child process, and the
 * legacy chat path. Until now exactly one of them passed `provisioning`, so a
 * repository's approved `.cognia/workspace.json` reached chat worktrees and no
 * others: an Agent Team fanning five tasks out paid five cold installs while
 * the declaration sat there being honoured on one path. Putting the resolution
 * behind one function keyed by the source root is what lets all six ask.
 *
 * # Two sources, merged only here
 *
 * The repository declaration is the repository author asking, gated on the user
 * approving that file's exact content. The local set is Cognia's own suggestion
 * from a lockfile, gated on the user accepting it in the environment settings.
 * They stay apart everywhere upstream so neither can be mistaken for the other
 * — see `lib/workspace/provisioning-inference` for why that matters — and are
 * unioned at this edge.
 *
 * # Never throws
 *
 * Every caller is on the path between a person asking for something and getting
 * a worktree. A missing Dexie (CLI), an unhydrated store (headless), an
 * unreadable declaration: all of them degrade to "no provisioning", which is a
 * full checkout with a cold cache — slower, never broken.
 */

import { mergeProvisioning, provisioningFromConsent } from "@/lib/workspace/provisioning-inference"
import { loadDeclaredWorkspace } from "@/lib/workspace/repo-declared"
import type { Project } from "@/types"

import type { WorkspaceProvisioning } from "./types"

/** The workspace fields provisioning is derived from. */
export type ProvisioningProject = Pick<Project, "roots" | "workspaceProvisioning">

export interface WorkspaceProvisioningDeps {
  /** The repository's approved declaration, or null. */
  declared: (project: ProvisioningProject) => Promise<WorkspaceProvisioning | undefined>
  /** Every workspace known to this device, for the path lookup. */
  projects: () => Promise<Project[]>
}

const DEFAULT_DEPS: WorkspaceProvisioningDeps = {
  declared: async (project) => {
    const [{ useSettingsStore }, { isTauri }] = await Promise.all([
      import("@/stores/settings"),
      import("@/lib/tauri"),
    ])
    const declared = await loadDeclaredWorkspace(project, {
      trustEnabled: useSettingsStore.getState().settings?.workspaceTrust?.enabled !== false,
      onWeb: !isTauri(),
    })
    return declared?.provisioning
  },
  projects: async () => {
    // The hydrated store first: it is already in memory on every renderer path
    // and reading Dexie behind it would be a database round-trip per worktree.
    // Dexie is the fallback for the shells that have no store — the CLI, a
    // scheduled run in a headless host.
    try {
      const { useProjectStore } = await import("@/stores/project/project-store")
      const loaded = useProjectStore.getState().projects
      if (loaded.length) return loaded
    } catch {
      // No store in this shell.
    }
    const { getAllProjects } = await import("@/lib/db/projects")
    return getAllProjects()
  },
}

/**
 * Provisioning for a workspace the caller already has in hand.
 *
 * The local half is rebuilt from stored ids, so this costs nothing beyond the
 * declaration read — no directory listing, no process spawn.
 */
export async function provisioningForProject(
  project: ProvisioningProject,
  deps?: Partial<WorkspaceProvisioningDeps>
): Promise<WorkspaceProvisioning | undefined> {
  const local = provisioningFromConsent(project.workspaceProvisioning)
  try {
    const declared = await (deps?.declared ?? DEFAULT_DEPS.declared)(project)
    return mergeProvisioning(declared, local)
  } catch {
    // The declaration is what failed to read. The local acceptance is already
    // in hand and is not collateral damage.
    return local
  }
}

/**
 * Provisioning for the workspace that mounts `sourceRoot`.
 *
 * For the acquisition sites that know a directory and nothing else. Returns
 * undefined when no workspace mounts it — an adopted folder, a bare path from a
 * CLI flag — which is the same answer they had before this existed.
 */
export async function provisioningForWorkspaceRoot(
  sourceRoot: string | null | undefined,
  deps?: Partial<WorkspaceProvisioningDeps>
): Promise<WorkspaceProvisioning | undefined> {
  const root = sourceRoot?.trim()
  if (!root) return undefined
  try {
    const projects = await (deps?.projects ?? DEFAULT_DEPS.projects)()
    const { locateWorkspaceForPath } = await import("@/lib/workspace/locate-workspace")
    const project = locateWorkspaceForPath(root, projects)?.project
    if (!project) return undefined
    return await provisioningForProject(project, deps)
  } catch {
    return undefined
  }
}
