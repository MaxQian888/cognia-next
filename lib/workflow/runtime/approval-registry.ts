/**
 * Pending human-approval registry for `action.approval.request` (ADR 0061 P2).
 *
 * The executor registers a pending entry and awaits the wake bus; responders
 * — a desktop notification action, or a paired device via the
 * `workflow_approval_respond` companion RPC (which round-trips into this
 * same webview process, so the in-process wake bus suffices) — call
 * {@link respondToApproval} to release it.
 *
 * The registry is deliberately in-memory: the durable source of truth is
 * the run's event log (`step.long_running.checkpoint` with key
 * `approval-request`), which the executor re-reads on crash-resume to
 * re-register without re-notifying. A response that arrives while the
 * webview is down simply fails its RPC and the phone retries — approvals
 * are only resolvable against a live orchestrator.
 */

import { emitWake } from "./wake-bus"

export interface PendingApproval {
  /** Deterministic id (`apr_<runId>_<stepId>`) — stable across crash-resume. */
  approvalId: string
  runId: string
  workflowId: string
  stepId: string
  title: string
  message?: string
  requestedAt: number
  /** Absent = wait until the run's wall-clock timeout. */
  timeoutAt?: number
}

export type ApprovalDecision = "approved" | "rejected"

export interface ApprovalResponse {
  decision: ApprovalDecision
  /** Who resolved it: `"desktop"`, `device:<deviceId>`, or `"timeout"`. */
  respondedBy: string
}

export function approvalId(runId: string, stepId: string): string {
  return `apr_${runId}_${stepId}`
}

export function approvalWakeKey(runId: string, stepId: string): string {
  return `approval:${runId}:${stepId}`
}

const pending = new Map<string, PendingApproval>()
const listeners = new Set<() => void>()

function notifyListeners(): void {
  for (const fn of listeners) {
    try {
      fn()
    } catch (err) {
      console.warn("approval registry listener threw:", err)
    }
  }
}

/** Register a pending approval (executor-side). Idempotent per approvalId. */
export function registerPendingApproval(entry: PendingApproval): void {
  pending.set(entry.approvalId, entry)
  notifyListeners()
}

/** Drop a pending approval (resolution, timeout, abort). */
export function removePendingApproval(id: string): void {
  if (pending.delete(id)) notifyListeners()
}

export function getPendingApproval(id: string): PendingApproval | undefined {
  return pending.get(id)
}

/** All pending approvals, oldest first — the RPC / UI projection. */
export function listPendingApprovals(): PendingApproval[] {
  return [...pending.values()].sort((a, b) => a.requestedAt - b.requestedAt)
}

/** Subscribe to registry mutations (UI reactivity). Returns unsubscribe. */
export function subscribePendingApprovals(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export type RespondResult = { ok: true } | { ok: false; reason: "not-found" }

/**
 * Resolve a pending approval. `false`/not-found means the approval already
 * resolved, timed out, or the run isn't live in this process — callers
 * (RPC arm, notification action) surface that as "no longer pending".
 */
export function respondToApproval(id: string, response: ApprovalResponse): RespondResult {
  const entry = pending.get(id)
  if (!entry) return { ok: false, reason: "not-found" }
  // The executor owns removal (its finally block) — but emitWake resolving
  // means the executor is live and will clean up synchronously after us.
  const woke = emitWake(approvalWakeKey(entry.runId, entry.stepId), {
    source: "approval",
    data: response,
  })
  if (!woke) {
    // Stale entry without a live waiter (should not happen — the executor
    // registers and subscribes in the same tick). Drop it defensively.
    removePendingApproval(id)
    return { ok: false, reason: "not-found" }
  }
  return { ok: true }
}

/** Test-only — wipe the registry. */
export function __resetApprovalRegistryForTesting(): void {
  pending.clear()
  listeners.clear()
}
