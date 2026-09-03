import {
  abortWorkspaceBundleTurn,
  beginWorkspaceBundleTurn,
  settleWorkspaceBundleTurn,
  type BeginTaskWorkspaceTurn,
} from "./client"
import { openWorkspaceApprovalScope } from "./user-action"
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
  // A turn's whole workspace lifecycle is `approval: "interactive"` — begin,
  // every tool event, settle. From a companion each was refused with "a current
  // device-bound approval lease is required", so no managed turn could run at
  // all. One standing approval covers the turn and is dropped the moment it
  // settles: this is the seam every caller already funnels through, so the
  // lifetime of the approval is exactly the lifetime of the working copy.
  const approval = await openWorkspaceApprovalScope()
  let lease: Awaited<ReturnType<typeof beginWorkspaceBundleTurn>>
  try {
    lease = await beginWorkspaceBundleTurn(bundle.bundleId, {
      primaryLogicalRootId,
      run: input,
    })
  } catch (error) {
    approval?.close()
    throw error
  }
  if (!lease) {
    approval?.close()
    return null
  }
  const primaryRun = lease.runs.find(({ logicalRootIds }) =>
    logicalRootIds.includes(primaryLogicalRootId)
  )?.run
  if (!primaryRun) {
    await abortWorkspaceBundleTurn(lease.bundleTurnId).catch(() => undefined)
    approval?.close()
    return null
  }

  let completion: Promise<ResourceChange[]> | null = null
  // Closed on settle AND on abort, and on the failure of either: a scope that
  // outlives its turn is a step-up token available to work nobody approved.
  const release = <T>(promise: Promise<T>): Promise<T> => promise.finally(() => approval?.close())
  const settle = (finalState: "ready" | "failed" | "cancelled" = "ready") => {
    completion ??= release(
      settleWorkspaceBundleTurn(lease.bundleTurnId, finalState).then((outcome) => outcome.resources)
    )
    return completion
  }
  const abort = () => {
    completion ??= release(
      abortWorkspaceBundleTurn(lease.bundleTurnId).then((outcome) => outcome.resources)
    )
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
