import type { Project } from "@/types"
import type { SessionExecutionContext } from "@/types/execution-context"
import { primaryRootOf } from "@/lib/workspace/roots"
import { loadDeclaredWorkspace } from "@/lib/workspace/repo-declared"
import type { WorkspaceProvisioning } from "./types"
import { acquireWorkspaceBundle, getWorkspaceBundle } from "./client"
import type { WorkspaceBundle } from "./types"
import { resolvePullRequestWorkspaceBase } from "./pull-request-base"

export interface SessionBundleBinding {
  context: SessionExecutionContext
  bundle: WorkspaceBundle
  primaryAlias: string
  additionalAliases: string[]
  primaryLogicalRootId: string
}

/** Acquire or validate the canonical physical environment for a managed chat. */
export async function ensureSessionExecutionBundle(input: {
  sessionId: string
  context: SessionExecutionContext
  project: Pick<Project, "id" | "roots">
  /**
   * Test seam. Production resolves it from the repository's approved
   * `.cognia/workspace.json` — see `loadSessionProvisioning`.
   */
  loadProvisioning?: (project: Pick<Project, "roots">) => Promise<WorkspaceProvisioning | undefined>
}): Promise<SessionBundleBinding> {
  const { context, project, sessionId } = input
  if (context.location !== "managedWorktree" || context.execution?.mode === "local") {
    throw new Error("session does not request managed execution")
  }
  const primaryRoot = primaryRootOf(project)
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
    // touch-up. Only ever non-empty for a repository whose declaration the user
    // approved on this device.
    const provisioning = await (input.loadProvisioning ?? loadSessionProvisioning)(project)
    bundle = await acquireWorkspaceBundle({
      ownerType: "session",
      ownerRef: sessionId,
      projectId: project.id,
      environmentKind: context.execution?.mode === "permanent" ? "permanent" : "managed",
      base: resolvedBase,
      roots: project.roots.map((root) => ({
        logicalRootId: root.id,
        role: root.id === primaryRoot.id ? ("primary" as const) : ("additional" as const),
        sourceRoot: root.path,
      })),
      ...(provisioning ? { provisioning } : {}),
    })
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
  const missingRoot = project.roots.find((root) => !leasesByRoot.has(root.id))
  if (missingRoot) {
    throw new Error(`workspace bundle is missing Project root: ${missingRoot.id}`)
  }
  const projectRootIds = new Set(project.roots.map((root) => root.id))
  const staleLease = bundle.leases.find((lease) => !projectRootIds.has(lease.logicalRootId))
  if (staleLease) {
    throw new Error(`workspace bundle contains stale Project root: ${staleLease.logicalRootId}`)
  }
  const primaryLease = leasesByRoot.get(primaryRoot.id)
  if (!primaryLease) throw new Error("workspace bundle has no primary root lease")
  const rootLeases = project.roots.map((root) => {
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

/**
 * The approved repository declaration's provisioning, or undefined.
 *
 * Never throws: failing to read a preference must not stop a conversation from
 * getting a worktree. The cost of the miss is a full checkout with no cache
 * link, which is exactly what happened before any of this existed.
 */
async function loadSessionProvisioning(
  project: Pick<Project, "roots">
): Promise<WorkspaceProvisioning | undefined> {
  try {
    const [{ useSettingsStore }, { isTauri }] = await Promise.all([
      import("@/stores/settings"),
      import("@/lib/tauri"),
    ])
    const declared = await loadDeclaredWorkspace(project, {
      trustEnabled: useSettingsStore.getState().settings?.workspaceTrust?.enabled !== false,
      onWeb: !isTauri(),
    })
    return declared?.provisioning
  } catch {
    return undefined
  }
}
