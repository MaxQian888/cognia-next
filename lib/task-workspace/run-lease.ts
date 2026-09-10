import { releaseOpenBundleTurn } from "./abandoned-turns"
import {
  abortWorkspaceBundleTurn,
  beginWorkspaceBundleTurn,
  settleWorkspaceBundleTurn,
  type BeginTaskWorkspaceTurn,
} from "./client"
import {
  bindApprovalScopeToTurn,
  closeApprovalScopeForTurn,
  openWorkspaceApprovalScope,
} from "./user-action"
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
  // The scope belongs to the turn from here on, not to this lease object. A
  // chat turn settles from the status edge, which never sees the lease, so
  // binding by turn id is what lets that path close the scope instead of
  // leaving a step-up token alive for its full 15-minute TTL. Bound before the
  // first failure exit below, so even those close it.
  bindApprovalScopeToTurn(lease.bundleTurnId, approval)
  const primaryRun = lease.runs.find(({ logicalRootIds }) =>
    logicalRootIds.includes(primaryLogicalRootId)
  )?.run
  if (!primaryRun) {
    await abortWorkspaceBundleTurn(lease.bundleTurnId).catch(() => undefined)
    closeApprovalScopeForTurn(lease.bundleTurnId)
    return null
  }

  let completion: Promise<ResourceChange[]> | null = null
  // Closed on settle AND on abort, and on the failure of either: a scope that
  // outlives its turn is a step-up token available to work nobody approved.
  // `closeApprovalScopeForTurn` is idempotent, so a settle path that already
  // closed it costs nothing here.
  //
  // A settle that FAILS also hands the turn to the reclaim path. Every caller
  // that settles through this lease rather than through `settleTaskWorkspaceTurn`
  // — the scheduler, the connector AI loop, agent execution, the team registry
  // controller — never reaches `forgetOpenBundleTurn`, so without this the
  // document keeps claiming a turn it can no longer end, answers its own later
  // poll with "I do", and that conversation is refused for good. The rejection
  // is rethrown: this hands the turn on, it does not absorb the failure.
  const release = <T>(promise: Promise<T>): Promise<T> =>
    promise
      .catch((error: unknown) => {
        releaseOpenBundleTurn(lease.bundleTurnId)
        throw error
      })
      .finally(() => closeApprovalScopeForTurn(lease.bundleTurnId))
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
