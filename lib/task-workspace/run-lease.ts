import {
  abortWorkspaceBundleTurn,
  beginWorkspaceBundleTurn,
  settleWorkspaceBundleTurn,
  type BeginTaskWorkspaceTurn,
} from "./client"
import type { ResourceChange, TaskRun, WorkspaceBundle } from "./types"

export interface TaskWorkspaceRunLease {
  run: TaskRun
  settle: (finalState?: "ready" | "failed" | "cancelled") => Promise<ResourceChange[]>
}

export interface WorkspaceBundleTurnRun {
  run: TaskRun
  workspaceId: string
  logicalRootIds: string[]
}

export interface WorkspaceBundleTurnLease extends TaskWorkspaceRunLease {
  bundleTurnId: string
  bundleId: string
  runs: WorkspaceBundleTurnRun[]
  primaryAlias: string
  additionalAliases: string[]
  abort: () => Promise<ResourceChange[]>
}

/**
 * Opens one persisted turn spanning every distinct physical workspace in a
 * Registry Bundle while keeping its logical aliases as the execution surface.
 */
export async function openWorkspaceBundleTurnLease(
  bundle: Pick<WorkspaceBundle, "bundleId" | "leases">,
  primaryLogicalRootId: string,
  input: BeginTaskWorkspaceTurn
): Promise<WorkspaceBundleTurnLease | null> {
  const lease = await beginWorkspaceBundleTurn(bundle.bundleId, {
    primaryLogicalRootId,
    run: input,
  })
  if (!lease) return null
  const primaryRun = lease.runs.find(({ logicalRootIds }) =>
    logicalRootIds.includes(primaryLogicalRootId)
  )?.run
  if (!primaryRun) {
    await abortWorkspaceBundleTurn(lease.bundleTurnId).catch(() => undefined)
    return null
  }

  let completion: Promise<ResourceChange[]> | null = null
  const settle = (finalState: "ready" | "failed" | "cancelled" = "ready") => {
    completion ??= settleWorkspaceBundleTurn(lease.bundleTurnId, finalState).then(
      (outcome) => outcome.resources
    )
    return completion
  }
  const abort = () => {
    completion ??= abortWorkspaceBundleTurn(lease.bundleTurnId).then((outcome) => outcome.resources)
    return completion
  }

  return {
    bundleTurnId: lease.bundleTurnId,
    bundleId: lease.bundleId,
    run: primaryRun,
    runs: lease.runs,
    primaryAlias: lease.primaryAlias,
    additionalAliases: lease.additionalAliases,
    settle,
    abort,
  }
}
