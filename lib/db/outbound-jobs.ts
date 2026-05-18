/**
 * CRUD layer for the `outboundQueue` Dexie table (schema v18, extended at v41).
 *
 * Outbound delivery jobs are processed FIFO per conversation lane.
 * The runner uses `pickNextDue` to claim the oldest pending row whose
 * `nextAttemptAt <= now`, then transitions it through the lifecycle:
 * pending → sending → sent | failed | deadlettered.
 *
 * Provenance: every enqueue MUST declare a `source` (added at v41) so the
 * inbox UI can render the right badge and the audit log can drill down on
 * origin. Rows persisted before v41 backfill to `"ai-run"` via the v41
 * upgrade hook — but new rows MUST declare explicitly; the type system
 * enforces this so a workflow-pushed message never silently looks like an
 * ai-run reply.
 */

import type {
  OutboundJobRow,
  OutboundJobSource,
  OutboundJobWorkflowSource,
} from "./connector-types"
import type { OutboundRequest } from "@/types/connectors/outbound"
import { getDb } from "./schema"

function newId(): string {
  return "oqj_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

export interface EnqueueInput {
  adapterId: string
  conversationKey: string
  request: OutboundRequest
  /** Override nextAttemptAt — defaults to now (immediate). */
  nextAttemptAt?: number
  /**
   * Provenance of this enqueue. Required at schema v41+. The four legal
   * values correspond to the four paths that can produce an outbound:
   * the connector ai-loop reply (`"ai-run"`), the inbox manual composer
   * (`"manual"`), a Visual Workflow `action.connector.send` node
   * (`"workflow"`, in which case `sourceWorkflow` MUST also be set), or a
   * draft approval (`"draft-approved"`).
   */
  source: OutboundJobSource
  /**
   * Workflow back-reference. Required when `source === "workflow"`,
   * ignored otherwise.
   */
  sourceWorkflow?: OutboundJobWorkflowSource
}

export async function enqueueOutbound(input: EnqueueInput): Promise<OutboundJobRow> {
  const now = Date.now()
  const row: OutboundJobRow = {
    id: newId(),
    adapterId: input.adapterId,
    conversationKey: input.conversationKey,
    request: input.request,
    status: "pending",
    attempts: 0,
    createdAt: now,
    nextAttemptAt: input.nextAttemptAt ?? now,
    idempotencyKey: input.request.metadata.idempotencyKey,
    source: input.source,
    ...(input.source === "workflow" && input.sourceWorkflow
      ? { sourceWorkflow: input.sourceWorkflow }
      : {}),
  }
  await getDb().outboundQueue.add(row)
  return row
}

/**
 * Return the oldest actionable row with `nextAttemptAt <= now`, or undefined
 * if nothing is due. Picks both "pending" (first attempt) and "failed"
 * (scheduled retry) rows. Does not mutate the row — caller must call
 * `markSending`.
 */
export async function pickNextDue(): Promise<OutboundJobRow | undefined> {
  const now = Date.now()
  const candidates = await getDb()
    .outboundQueue.filter(
      (r) => (r.status === "pending" || r.status === "failed") && r.nextAttemptAt <= now
    )
    .toArray()
  if (candidates.length === 0) return undefined
  return candidates.sort((a, b) => a.createdAt - b.createdAt)[0]
}

/**
 * Return all pending rows for a conversation, ordered by createdAt (FIFO).
 */
export async function listPendingForConversation(
  conversationKey: string
): Promise<OutboundJobRow[]> {
  return getDb()
    .outboundQueue.where("[conversationKey+createdAt]")
    .between([conversationKey, -Infinity], [conversationKey, Infinity])
    .filter((r) => r.status === "pending")
    .toArray()
}

/** Transition a job to "sending" and increment attempts. */
export async function markSending(jobId: string): Promise<void> {
  const row = await getDb().outboundQueue.get(jobId)
  await getDb().outboundQueue.update(jobId, {
    status: "sending",
    attempts: (row?.attempts ?? 0) + 1,
  })
}

/** Transition a job to "sent". */
export async function markSent(jobId: string, _platformMessageId: string): Promise<void> {
  await getDb().outboundQueue.update(jobId, { status: "sent" })
}

/** Transition a job to "failed" with error info and next retry time. */
export async function markFailed(
  jobId: string,
  errorCode: string,
  message: string,
  nextAttemptAt: number
): Promise<void> {
  await getDb().outboundQueue.update(jobId, {
    status: "failed",
    lastErrorCode: errorCode,
    lastError: message,
    nextAttemptAt,
  })
}

/** Transition a job to "deadlettered" — no more retries. */
export async function markDeadlettered(
  jobId: string,
  errorCode: string,
  message: string
): Promise<void> {
  await getDb().outboundQueue.update(jobId, {
    status: "deadlettered",
    lastErrorCode: errorCode,
    lastError: message,
  })
}
