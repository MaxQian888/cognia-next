import { isTauri } from "@/lib/tauri"
import { isPathWithinRoot } from "@/lib/files/permissions"
import { allRootPaths, rootsFromLegacy } from "@/lib/workspace/roots"
import type { Project } from "@/types"
import type { SessionExecutionContext } from "@/types/execution-context"
import {
  ensureSubjectPortLease,
  ensureWorkspacePortLease,
  releaseSubjectPortLeases,
  resolveWorkspacePortLeaseEnsure,
} from "./client"
import type { WorkspacePortLease } from "./types"
import { runWorkspaceUserAction } from "./user-action"

export interface ExecutionPortLeaseInput {
  cwd?: string
  project?: Pick<Project, "id" | "roots" | "rootDir" | "additionalDirs"> | null
  projectId?: string | null
  sessionId?: string | null
  executionContext?: SessionExecutionContext | null
  workspaceId?: string
  namespace?: string
}

/** Register frontend-owned subjects at an execution boundary; the host owns allocation. */
export async function ensureExecutionPortLease(
  input: ExecutionPortLeaseInput
): Promise<WorkspacePortLease | null> {
  if (!isTauri()) return null
  const { cwd, namespace, executionContext: context } = input
  if (input.workspaceId) {
    const workspaceId = input.workspaceId
    return runWorkspaceUserAction("task_workspace_port_lease_ensure", () =>
      ensureWorkspacePortLease(workspaceId, namespace)
    )
  }
  if (!cwd) return null

  // The portable managed binding is not a registry id. Only execution.roots
  // carries registry ids; desktop session folders use their session subject.
  const registryRoot = context?.execution?.roots
    .filter((root) => root.workspaceId && isPathWithinRoot(cwd, root.aliasPath))
    .sort((left, right) => right.aliasPath.length - left.aliasPath.length)[0]
  const localRoot = context?.managedWorkspace?.localRoot
  if (registryRoot?.workspaceId) {
    const workspaceId = registryRoot.workspaceId
    await runWorkspaceUserAction("task_workspace_port_lease_ensure", () =>
      ensureWorkspacePortLease(workspaceId, namespace)
    )
  } else if (
    input.sessionId &&
    context?.workspaceBinding?.kind === "managed" &&
    context.managedWorkspace?.availability === "available" &&
    localRoot &&
    isPathWithinRoot(cwd, localRoot)
  ) {
    const sessionId = input.sessionId
    await runWorkspaceUserAction("task_workspace_port_lease_subject_ensure", () =>
      ensureSubjectPortLease({
        kind: "desktop-session",
        key: sessionId,
        root: localRoot,
        namespace,
      })
    )
  } else {
    // Setup execution can arrive with only a cwd. Let the host identify a
    // registry worktree before considering the enclosing project checkout.
    const resolved = await runWorkspaceUserAction("task_workspace_port_lease_resolve_ensure", () =>
      resolveWorkspacePortLeaseEnsure(cwd, undefined, namespace)
    )
    if (resolved?.registryWorkspaceId || resolved?.subjectKind === "registry") return resolved

    let project = input.project
    if (project === undefined && input.projectId) {
      const { useProjectStore } = await import("@/stores/project/project-store")
      project = useProjectStore.getState().projects.find((item) => item.id === input.projectId)
      if (!project) {
        const { getAllProjects } = await import("@/lib/db/projects")
        project = (await getAllProjects()).find((item) => item.id === input.projectId)
      }
    }
    if (!project) return resolved
    const roots = project.roots ?? rootsFromLegacy(project.rootDir, project.additionalDirs)
    const root = allRootPaths({ roots })
      .filter((path) => isPathWithinRoot(cwd, path))
      .sort((left, right) => right.length - left.length)[0]
    if (!root) return resolved
    const projectId = project.id
    await runWorkspaceUserAction("task_workspace_port_lease_subject_ensure", () =>
      ensureSubjectPortLease({ kind: "project-root", key: projectId, root, namespace })
    )
  }
  // Canonical paths and registry precedence are resolved by the service,
  // including aliases, nested roots and legacy contexts without registry ids.
  return runWorkspaceUserAction("task_workspace_port_lease_resolve_ensure", () =>
    resolveWorkspacePortLeaseEnsure(cwd, undefined, namespace)
  )
}

/** Archive retains the subject; only permanent project deletion calls this. */
export async function releaseProjectPortLeases(
  projectId: string,
  namespace?: string,
  project?: ExecutionPortLeaseInput["project"]
): Promise<void> {
  if (!isTauri()) return
  // Only the project's explicit roots may release host-derived subjects.
  // A discovered ancestor checkout can also serve unrelated subdirectory projects.
  const roots = new Set(
    project
      ? allRootPaths({
          roots: project.roots ?? rootsFromLegacy(project.rootDir, project.additionalDirs),
        })
      : []
  )
  for (const root of roots) {
    await runWorkspaceUserAction("task_workspace_port_lease_subject_release", () =>
      releaseSubjectPortLeases({ kind: "project-root", key: `root:${root}`, namespace })
    )
  }
  await runWorkspaceUserAction("task_workspace_port_lease_subject_release", () =>
    releaseSubjectPortLeases({ kind: "project-root", key: projectId, namespace })
  )
}
