import type { Project } from "@/types"
import type { SessionExecutionContext } from "@/types/execution-context"
import { primaryRootOf } from "@/lib/workspace/roots"
import type { WorkspaceProvisioning } from "./types"
import { acquireWorkspaceBundle, getWorkspaceBundle } from "./client"
import { runWorkspaceUserAction } from "./user-action"
import type { WorkspaceBundle } from "./types"
import { resolvePullRequestWorkspaceBase } from "./pull-request-base"
import { provisioningForProject } from "./workspace-provisioning"

export interface SessionBundleBinding {
  context: SessionExecutionContext
  bundle: WorkspaceBundle
  primaryAlias: string
  additionalAliases: string[]
  primaryLogicalRootId: string
}

/** The single logical root of a session-scoped managed workspace, if it has one. */
export const MANAGED_WORKSPACE_ROOT_ID = "primary"

/**
 * The roots a `managed`-bound context mounts, or undefined when the context is
 * bound to a Project instead.
 *
 * Throws rather than answering undefined when the binding IS managed but this
 * device has not materialized the directory: falling through to the Project
 * would produce "managed execution requires at least one Project root", which
 * names the wrong object and points at a setup step that would not help. The
 * real repair is to materialize or rebind the managed workspace, and only a
 * shell with a local filesystem can do that.
 */
function managedWorkspaceRoots(
  context: SessionExecutionContext
): { id: string; path: string }[] | undefined {
  if (context.workspaceBinding?.kind !== "managed") return undefined
  const managed = context.managedWorkspace
  if (managed?.availability !== "available" || !managed.localRoot) {
    throw new Error("managed workspace is not available on this device")
  }
  return [{ id: MANAGED_WORKSPACE_ROOT_ID, path: managed.localRoot }]
}

/** Acquire or validate the canonical physical environment for a managed chat. */
export async function ensureSessionExecutionBundle(input: {
  sessionId: string
  context: SessionExecutionContext
  project: Pick<Project, "id" | "roots" | "workspaceProvisioning">
  /**
   * Test seam. Production resolves it from the repository's approved
   * `.cognia/workspace.json` plus what this device accepted — see
   * `provisioningForProject`.
   */
  loadProvisioning?: (
    project: Pick<Project, "roots" | "workspaceProvisioning">
  ) => Promise<WorkspaceProvisioning | undefined>
}): Promise<SessionBundleBinding> {
  const { context, project, sessionId } = input
  if (context.location !== "managedWorktree" || context.execution?.mode === "local") {
    throw new Error("session does not request managed execution")
  }
  // Two different things arrive here wearing the same `managedWorktree`
  // location. A `project` binding runs the managed contract over the
  // workspace's own roots. A `managed` binding is a chat whose workspace has no
  // directory to bind to at all (`createManagedWorkspaceContext`), so the
  // Project it is attributed to is rootless BY CONSTRUCTION and asking it for a
  // root is asking the wrong object. Its physical environment is the managed
  // directory this device materialized, and that directory is the one root the
  // bundle mounts.
  const managedRoots = managedWorkspaceRoots(context)
  const roots: readonly { id: string; path: string }[] = managedRoots ?? project.roots
  const primaryRoot = managedRoots ? managedRoots[0] : primaryRootOf(project)
  if (!primaryRoot) throw new Error("managed execution requires at least one Project root")
  const requestedBase = context.execution?.base ?? { kind: "workingState" as const }
  const resolvedBase = await resolvePullRequestWorkspaceBase(primaryRoot.path, requestedBase)

  let bundle = context.execution?.bundleId
    ? await getWorkspaceBundle(context.execution.bundleId)
    : null
  if (!bundle) {
    // Sparse checkout, cache links and gitignored includes, applied by the
    // native provisioner as part of CREATING the worktree — a half-provisioned
    // tree handed to an agent is worse than none, so it cannot be a later
    // touch-up. Non-empty only for a repository whose declaration the user
    // approved on this device, or for suggestions they accepted themselves.
    const provisioning = await (input.loadProvisioning ?? provisioningForProject)(project)
    // `task_workspace_bundle_acquire` is `approval: "interactive"`. This is the
    // one call that happens before the turn lease exists, so it carries its own
    // one-shot approval rather than the turn scope opened in `run-lease.ts`.
    bundle = await runWorkspaceUserAction("task_workspace_bundle_acquire", () =>
      acquireWorkspaceBundle({
        ownerType: "session",
        ownerRef: sessionId,
        projectId: project.id,
        environmentKind: context.execution?.mode === "permanent" ? "permanent" : "managed",
        base: resolvedBase,
        roots: roots.map((root) => ({
          logicalRootId: root.id,
          role: root.id === primaryRoot.id ? ("primary" as const) : ("additional" as const),
          sourceRoot: root.path,
        })),
        ...(provisioning ? { provisioning } : {}),
      })
    )
  }
  if (bundle.state !== "active") {
    throw new Error(`workspace bundle is not active: ${bundle.bundleId}`)
  }
  if (bundle.environmentKind === "imported") {
    throw new Error("imported environments must be adopted before execution")
  }
  if (bundle.ownerType === "session" && bundle.ownerRef !== sessionId) {
    throw new Error("workspace bundle is owned by another session")
  }

  const leasesByRoot = new Map(bundle.leases.map((lease) => [lease.logicalRootId, lease]))
  const missingRoot = roots.find((root) => !leasesByRoot.has(root.id))
  if (missingRoot) {
    throw new Error(`workspace bundle is missing Project root: ${missingRoot.id}`)
  }
  const projectRootIds = new Set(roots.map((root) => root.id))
  const staleLease = bundle.leases.find((lease) => !projectRootIds.has(lease.logicalRootId))
  if (staleLease) {
    throw new Error(`workspace bundle contains stale Project root: ${staleLease.logicalRootId}`)
  }
  const primaryLease = leasesByRoot.get(primaryRoot.id)
  if (!primaryLease) throw new Error("workspace bundle has no primary root lease")
  const rootLeases = roots.map((root) => {
    const lease = leasesByRoot.get(root.id)!
    return {
      logicalRootId: root.id,
      role: root.id === primaryRoot.id ? ("primary" as const) : ("additional" as const),
      aliasPath: lease.aliasPath,
      workspaceId: lease.workspaceId,
    }
  })
  const now = Date.now()
  const {
    worktreePath: _legacyWorktreePath,
    branch: _legacyBranch,
    baseRef: _legacyBaseRef,
    ...canonicalContext
  } = context
  const nextContext: SessionExecutionContext = {
    ...canonicalContext,
    execution: {
      mode: bundle.environmentKind === "permanent" ? "permanent" : "managed",
      ...(context.execution?.environmentId
        ? { environmentId: context.execution.environmentId }
        : {}),
      bundleId: bundle.bundleId,
      base: resolvedBase,
      roots: rootLeases,
    },
    lifecycle: {
      state: "active",
      createdAt: context.lifecycle?.createdAt ?? bundle.createdAt,
      updatedAt: now,
      pinned: bundle.pinned,
    },
  }

  return {
    context: nextContext,
    bundle,
    primaryAlias: primaryLease.aliasPath,
    additionalAliases: rootLeases
      .filter((lease) => lease.role === "additional")
      .map((lease) => lease.aliasPath),
    primaryLogicalRootId: primaryRoot.id,
  }
}
