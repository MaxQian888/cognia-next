/** Durable approval projection shared by authored approval nodes and risk gates. */

import type { WorkflowWaitpoint } from "@/types/workflow/waitpoint"
import {
  createWorkflowWaitpoint,
  decideWorkflowWaitpoint,
  getWorkflowWaitpoint,
  listPendingWorkflowWaitpoints,
  subscribeWorkflowWaitpointChanges,
} from "@/lib/db/workflow-waitpoints"
import { getDb } from "@/lib/db/schema"

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
  kind?: "approval" | "risk_gate"
}

export type ApprovalDecision = "approved" | "rejected"

export interface ApprovalResponse {
  decision: ApprovalDecision
  respondedBy: string
}

export function approvalId(runId: string, stepId: string): string {
  return `apr_${runId}_${stepId}`
}

/** Retained as the stable public key used by existing companion clients. */
export function approvalWakeKey(runId: string, stepId: string): string {
  return `approval:${runId}:${stepId}`
}

function toPendingApproval(waitpoint: WorkflowWaitpoint): PendingApproval {
  return {
    approvalId: waitpoint.id,
    runId: waitpoint.runId,
    workflowId: waitpoint.workflowId,
    stepId: waitpoint.stepId,
    title: waitpoint.title ?? "Approval required",
    ...(waitpoint.message ? { message: waitpoint.message } : {}),
    requestedAt: waitpoint.createdAt,
    ...(waitpoint.expiresAt !== undefined ? { timeoutAt: waitpoint.expiresAt } : {}),
    kind: waitpoint.kind === "risk_gate" ? "risk_gate" : "approval",
  }
}

export async function registerPendingApproval(entry: PendingApproval): Promise<PendingApproval> {
  const stored = await createWorkflowWaitpoint({
    id: entry.approvalId,
    kind: entry.kind ?? "approval",
    status: "pending",
    runId: entry.runId,
    workflowId: entry.workflowId,
    stepId: entry.stepId,
    key: approvalWakeKey(entry.runId, entry.stepId),
    title: entry.title,
    ...(entry.message ? { message: entry.message } : {}),
    createdAt: entry.requestedAt,
    notBefore: entry.requestedAt,
    ...(entry.timeoutAt !== undefined ? { expiresAt: entry.timeoutAt } : {}),
    updatedAt: entry.requestedAt,
  })
  return toPendingApproval(stored)
}

export async function getPendingApproval(id: string): Promise<PendingApproval | undefined> {
  const row = await getWorkflowWaitpoint(id)
  return row?.status === "pending" ? toPendingApproval(row) : undefined
}

export async function listPendingApprovals(): Promise<PendingApproval[]> {
  const rows = [
    ...(await listPendingWorkflowWaitpoints("approval")),
    ...(await listPendingWorkflowWaitpoints("risk_gate")),
  ]
  return rows
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    .map(toPendingApproval)
}

export function subscribePendingApprovals(fn: () => void): () => void {
  return subscribeWorkflowWaitpointChanges((waitpoint) => {
    if (waitpoint.kind === "approval" || waitpoint.kind === "risk_gate") fn()
  })
}

export type RespondResult = { ok: true } | { ok: false; reason: "not-found" | "already-decided" }

/** Transactional first-writer-wins decision; works even without a live waiter. */
export async function respondToApproval(
  id: string,
  response: ApprovalResponse
): Promise<RespondResult> {
  const result = await decideWorkflowWaitpoint(id, {
    outcome: response.decision,
    respondedBy: response.respondedBy,
    resolvedAt: Date.now(),
  })
  return result.ok ? { ok: true } : result
}

/** Test-only — wipe durable approval rows and local listeners. */
export async function __resetApprovalRegistryForTesting(): Promise<void> {
  await getDb().workflowWaitpoints.clear()
}
