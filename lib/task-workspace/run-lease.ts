import { abortBundleTurnIfUndriven, releaseOpenBundleTurn } from "./abandoned-turns"
import {
  abortWorkspaceBundleTurn,
  beginWorkspaceBundleTurn,
  getWorkspaceBundleTurn,
  isWorkspaceBusyRefusal,
  settleWorkspaceBundleTurn,
  type BeginTaskWorkspaceTurn,
} from "./client"
import {
  bindApprovalScopeToTurn,
  closeApprovalScopeForTurn,
  openWorkspaceApprovalScope,
} from "./user-action"
import type {
  ResourceChange,
  TaskRun,
  WorkspaceBundle,
  WorkspaceBundleTurnLease as HostWorkspaceBundleTurnLease,
} from "./types"

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
    // Reconciled while the approval scope is still open: the abort it may
    // issue is an interactive workspace command like the begin itself.
    await reconcileUnansweredBegin(bundle.bundleId, primaryLogicalRootId, input, error).catch(
      () => undefined
    )
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

/**
 * The host's refusal to reuse a turn id for a different request. Definitive:
 * the turn under that id belongs to someone else and must never be cleaned up.
 */
const TURN_IDENTITY_CONFLICT = /bundleTurnId is already owned by another workspace bundle/i

/** Backoff between attempts to read back a turn whose begin answer was lost. */
const RECONCILE_READ_RETRY_DELAYS_MS = [250, 1000] as const

let waitBeforeReconcileRead = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/** Test seam, so a suite does not wait out the real backoff. */
export function __setReconcileReadWaitForTests(next: (ms: number) => Promise<void>): () => void {
  const previous = waitBeforeReconcileRead
  waitBeforeReconcileRead = next
  return () => {
    waitBeforeReconcileRead = previous
  }
}

/**
 * End a turn whose begin may have committed even though its answer was lost.
 *
 * A begin that fails in transport (a dropped companion request, a brain that
 * restarted mid-call) says nothing about the host: it may well have opened the
 * turn and be holding the conversation's working copy for it. The client never
 * learned the turn existed, so nothing would settle it, and the host's own
 * init recovery only runs when the host restarts. Every later turn in that
 * conversation was refused with `pipeline workspace is already active`.
 *
 * The host keys a bundle turn by the caller's `turnId`, so that id is enough to
 * find it, but not to own it: the same id can name another task's live turn,
 * which is exactly what the host's identity-conflict refusal reports. So a turn
 * is aborted only when all of these hold:
 *
 *   - the begin failed for a reason other than a busy or identity refusal;
 *   - the host reports the turn open, and it is this request by the host's own
 *     reuse rule ({@link isThisBeginRequest});
 *   - no document of this browser claims to drive it.
 *
 * A turn that cannot be read back is left alone; the host's restart recovery
 * remains its backstop. Cleaning up something whose owner cannot be proven is
 * how a live run gets killed.
 */
async function reconcileUnansweredBegin(
  bundleId: string,
  primaryLogicalRootId: string,
  input: BeginTaskWorkspaceTurn,
  error: unknown
): Promise<void> {
  const turnId = input.turnId?.trim()
  if (!turnId || isWorkspaceBusyRefusal(error)) return
  const message = error instanceof Error ? error.message : String(error)
  if (TURN_IDENTITY_CONFLICT.test(message)) return
  const turn = await readTurnBack(turnId)
  if (!turn || turn.settledAt !== null) return
  if (!(await isThisBeginRequest(turn, bundleId, primaryLogicalRootId, input, turnId))) return
  await abortBundleTurnIfUndriven(turnId)
}

async function readTurnBack(turnId: string): Promise<HostWorkspaceBundleTurnLease | null> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await getWorkspaceBundleTurn(turnId)
    } catch {
      const delay = RECONCILE_READ_RETRY_DELAYS_MS[attempt]
      if (delay === undefined) return null
      await waitBeforeReconcileRead(delay)
    }
  }
}

/**
 * Whether the host would answer this begin with `turn` — the rule
 * `begin_workspace_bundle_turn` uses to return an existing turn instead of
 * refusing: same bundle, same primary root, and every run's task and run ids
 * are this request's, scoped to that run's workspace. The fields the host
 * copies from the request verbatim are compared too.
 */
async function isThisBeginRequest(
  turn: HostWorkspaceBundleTurnLease,
  bundleId: string,
  primaryLogicalRootId: string,
  input: BeginTaskWorkspaceTurn,
  turnId: string
): Promise<boolean> {
  if (turn.bundleTurnId !== turnId || turn.bundleId !== bundleId) return false
  if (turn.primaryLogicalRootId !== primaryLogicalRootId || turn.runs.length === 0) return false
  for (const { workspaceId, run } of turn.runs) {
    const suffix = await workspaceRunSuffix(workspaceId)
    if (!suffix) return false
    if (run.taskId !== scopedRunId(input.taskId, suffix)) return false
    if (run.runId !== scopedRunId(input.runId, suffix)) return false
    if (run.turnId !== turnId) return false
    if (run.agentId !== input.agentId || run.agentKind !== input.agentKind) return false
    if ((run.executionRunId ?? undefined) !== input.executionRunId) return false
    if ((run.attemptId ?? undefined) !== input.attemptId) return false
  }
  return true
}

/** `storage_key(workspace_id)[..12]`: the first 12 hex digits of its SHA-256. */
async function workspaceRunSuffix(workspaceId: string): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) return null
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(workspaceId))
  return Array.from(new Uint8Array(digest).slice(0, 6), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
}

/** Mirrors the host's `scoped_run_id`: the id, byte-capped to fit 128 with `:suffix`. */
function scopedRunId(base: string, suffix: string): string {
  const keep = Math.max(0, 128 - 1 - suffix.length)
  const bytes = new TextEncoder().encode(base)
  let prefix = base
  if (bytes.length > keep) {
    try {
      prefix = new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(0, keep))
    } catch {
      // The host falls back to the whole id when the cut splits a character.
      prefix = base
    }
  }
  return `${prefix}:${suffix}`
}
