/**
 * The persistence rules of a durable Agent Team run (ADR-0217).
 *
 * Every {@link TeamRunStore} implementation applies these inside its own
 * atomic section, so the rules have one definition no matter which database
 * holds the rows: control-state compare-and-set, the dispatch lease, the
 * monotonic trajectory, checkpoint and steering bookkeeping, and recovery
 * ordering.
 */

import type {
  AgentTeamChildRun,
  AgentTeamCheckpoint,
  AgentTeamDecision,
  AgentTeamEvidence,
  AgentTeamRunRecord,
  AgentTeamRunStatus,
  AgentTeamSteeringReceipt,
  AgentTeamSteeringStatus,
  AgentTeamTrajectoryEvent,
} from "./records"

/** Default lifetime of a dispatch lease. */
export const DEFAULT_DISPATCH_LEASE_TTL_MS = 60_000

/** Run statuses process loss can interrupt; only these need checkpoint recovery. */
const INTERRUPTED_EXECUTION_STATUSES = new Set<AgentTeamRunStatus>([
  "running",
  "pausing",
  "recovering",
])

export function assertRunBoundary(run: AgentTeamRunRecord): void {
  if (!run.id || !run.teamId || !run.objective.trim()) {
    throw new Error("Durable AgentTeam run requires id, teamId, and objective")
  }
  if (!Number.isInteger(run.decisionVersion) || run.decisionVersion < 0) {
    throw new Error("Durable AgentTeam run decisionVersion must be a non-negative integer")
  }
}

export function assertChildBoundary(child: AgentTeamChildRun): void {
  if (!child.id || !child.runId || !child.teammateId || !child.taskId || !child.repositoryId) {
    throw new Error("Durable AgentTeam child requires run, teammate, task, and repository")
  }
}

/** The control state a compare-and-set update expects to find unchanged. */
export type ControlState = { status: string; updatedAt: number }

export function matchesControlState(
  record: ControlState | undefined,
  expected: ControlState
): record is ControlState {
  return !!record && record.status === expected.status && record.updatedAt === expected.updatedAt
}

/**
 * Runs to recover after process loss: interrupted execution only (queued runs
 * keep their queue position; pause, sleep and input gates are deliberate
 * operator states), highest priority first, then queue order.
 */
export function selectRecoveryCandidates<R extends AgentTeamRunRecord>(runs: readonly R[]): R[] {
  return runs
    .filter((run) => INTERRUPTED_EXECUTION_STATUSES.has(run.status))
    .sort(
      (a, b) =>
        b.priority - a.priority ||
        (a.queueEnteredAt ?? a.createdAt) - (b.queueEnteredAt ?? b.createdAt)
    )
}

/** Newest child of one teammate on one task. */
export function latestChildFor(
  children: readonly AgentTeamChildRun[],
  taskId: string,
  teammateId: string
): AgentTeamChildRun | undefined {
  return children
    .filter((row) => row.taskId === taskId && row.teammateId === teammateId)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]
}

export interface ClaimDispatchLeaseInput {
  childRunId: string
  leaseId: string
  hostRef: string
  now: number
  ttlMs?: number
  executionFingerprint?: string
}

/**
 * The patch that claims a child as the remote dispatch lease authority, or
 * `undefined` while a different, unexpired lease holds it. Re-claiming with
 * the same lease id is an idempotent replay.
 */
export function dispatchLeaseClaimPatch(
  child: AgentTeamChildRun,
  input: ClaimDispatchLeaseInput
): Partial<AgentTeamChildRun> | undefined {
  const heldByOther =
    child.dispatchLeaseId !== undefined &&
    child.dispatchLeaseId !== input.leaseId &&
    (child.dispatchLeaseExpiresAt ?? 0) > input.now
  if (heldByOther) return undefined
  return {
    dispatchLeaseId: input.leaseId,
    dispatchLeaseExpiresAt: input.now + (input.ttlMs ?? DEFAULT_DISPATCH_LEASE_TTL_MS),
    hostRef: input.hostRef,
    waitingReason: undefined,
    ...(input.executionFingerprint ? { executionFingerprint: input.executionFingerprint } : {}),
    updatedAt: input.now,
  }
}

/** The renewal patch, or `undefined` when the caller no longer holds the lease. */
export function dispatchLeaseRenewPatch(
  child: AgentTeamChildRun | undefined,
  expectedLeaseId: string,
  now: number,
  ttlMs = DEFAULT_DISPATCH_LEASE_TTL_MS
): Partial<AgentTeamChildRun> | undefined {
  if (!child || child.dispatchLeaseId !== expectedLeaseId) return undefined
  return { dispatchLeaseExpiresAt: now + ttlMs, updatedAt: now }
}

/** The release patch, or `undefined` when the caller no longer holds the lease. */
export function dispatchLeaseSettlePatch(
  child: AgentTeamChildRun | undefined,
  expectedLeaseId: string,
  now: number
): Partial<AgentTeamChildRun> | undefined {
  if (!child || child.dispatchLeaseId !== expectedLeaseId) return undefined
  return { dispatchLeaseId: undefined, dispatchLeaseExpiresAt: undefined, updatedAt: now }
}

/** Whether a remote event may advance the child: it must follow the last one seen. */
export function canAdvanceRemoteEvent(
  child: AgentTeamChildRun | undefined,
  expectedPreviousEventId: string | undefined
): child is AgentTeamChildRun {
  return !!child && child.lastRemoteEventId === expectedPreviousEventId
}

export type AppendTrajectoryInput = Omit<AgentTeamTrajectoryEvent, "id" | "sequence">

/** The next event of a run's trajectory: sequence = last + 1, id `${runId}:${sequence}`. */
export function nextTrajectoryEvent(
  lastSequence: number | undefined,
  input: AppendTrajectoryInput,
  contentHash?: string
): AgentTeamTrajectoryEvent {
  const sequence = (lastSequence ?? 0) + 1
  return {
    ...input,
    ...(contentHash ? { contentHash } : {}),
    id: `${input.runId}:${sequence}`,
    sequence,
  }
}

/** The child patch that records an appended trajectory event. */
export function trajectoryChildPatch(event: AgentTeamTrajectoryEvent): Partial<AgentTeamChildRun> {
  return { lastTrajectorySequence: event.sequence, updatedAt: event.createdAt }
}

export type MarkCheckpointInput = Omit<AgentTeamCheckpoint, "id">

/** The child patch that records a checkpoint. */
export function checkpointChildPatch(checkpoint: AgentTeamCheckpoint): Partial<AgentTeamChildRun> {
  return {
    lastCheckpointId: checkpoint.id,
    lastTrajectorySequence: checkpoint.trajectorySequence,
    updatedAt: checkpoint.createdAt,
  }
}

/** The child patch for a newly queued steering message. */
export function steeringQueuedChildPatch(
  child: AgentTeamChildRun,
  receipt: AgentTeamSteeringReceipt
): Partial<AgentTeamChildRun> {
  return {
    pendingSteeringCount: (child.pendingSteeringCount ?? 0) + 1,
    updatedAt: receipt.updatedAt,
  }
}

/** The receipt patch for a steering status change. */
export function steeringReceiptPatch(
  status: AgentTeamSteeringStatus,
  at: number,
  reason?: string
): Partial<AgentTeamSteeringReceipt> {
  return {
    status,
    updatedAt: at,
    ...(reason ? { reason } : {}),
    ...(status === "delivered" ? { deliveredAt: at } : {}),
    ...(status === "applied" ? { appliedAt: at } : {}),
  }
}

/** The child patch when a steering message leaves the pending set, if it did. */
export function steeringResolvedChildPatch(
  child: AgentTeamChildRun,
  status: AgentTeamSteeringStatus,
  at: number
): Partial<AgentTeamChildRun> | undefined {
  if (status !== "applied" && status !== "rejected") return undefined
  return {
    pendingSteeringCount: Math.max(0, (child.pendingSteeringCount ?? 1) - 1),
    updatedAt: at,
  }
}

/** Steering a child still has to act on, oldest first. */
export function pendingSteering(
  receipts: readonly AgentTeamSteeringReceipt[]
): AgentTeamSteeringReceipt[] {
  return receipts
    .filter((row) => row.status === "queued" || row.status === "delivered")
    .sort((a, b) => a.createdAt - b.createdAt)
}

/** A user constraint is immutable from the moment it is recorded. */
export function assertDecisionBoundary(decision: AgentTeamDecision): void {
  if (decision.status === "constraint" && !decision.immutable) {
    throw new Error("User constraints must be immutable")
  }
}

/** Decisions in version order, ties by creation time. */
export function sortDecisions(decisions: readonly AgentTeamDecision[]): AgentTeamDecision[] {
  return [...decisions].sort((a, b) => a.version - b.version || a.createdAt - b.createdAt)
}

/** Narrows an evidence listing; every given field must match. */
export interface EvidenceScope {
  childRunId?: string
  taskId?: string
  attempt?: number
}

export function evidenceInScope(
  item: AgentTeamEvidence,
  runId: string,
  scope: EvidenceScope = {}
): boolean {
  return (
    item.runId === runId &&
    (scope.childRunId === undefined || item.childRunId === scope.childRunId) &&
    (scope.taskId === undefined || item.taskId === scope.taskId) &&
    (scope.attempt === undefined || item.attempt === scope.attempt)
  )
}
