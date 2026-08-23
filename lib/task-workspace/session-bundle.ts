import type { Project } from "@/types"
import type { SessionExecutionContext } from "@/types/execution-context"
import { primaryRootOf } from "@/lib/workspace/roots"
import { acquireWorkspaceBundle, getWorkspaceBundle } from "./client"
import type { WorkspaceBundle } from "./types"

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
}): Promise<SessionBundleBinding> {
  const { context, project, sessionId } = input
  if (context.location !== "managedWorktree" || context.execution?.mode === "local") {
    throw new Error("session does not request managed execution")
  }
  const primaryRoot = primaryRootOf(project)
  if (!primaryRoot) throw new Error("managed execution requires at least one Project root")

  let bundle = context.execution?.bundleId
    ? await getWorkspaceBundle(context.execution.bundleId)
    : null
  if (!bundle) {
    bundle = await acquireWorkspaceBundle({
      ownerType: "session",
      ownerRef: sessionId,
      environmentKind: context.execution?.mode === "permanent" ? "permanent" : "managed",
      base: context.execution?.base ?? { kind: "workingState" },
      roots: project.roots.map((root) => ({
        logicalRootId: root.id,
        role: root.id === primaryRoot.id ? ("primary" as const) : ("additional" as const),
        sourceRoot: root.path,
      })),
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
  const nextContext: SessionExecutionContext = {
    ...context,
    execution: {
      mode: bundle.environmentKind === "permanent" ? "permanent" : "managed",
      ...(context.execution?.environmentId
        ? { environmentId: context.execution.environmentId }
        : {}),
      bundleId: bundle.bundleId,
      base: context.execution?.base ?? { kind: "workingState" },
      roots: rootLeases,
    },
    worktreePath: primaryLease.aliasPath,
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
