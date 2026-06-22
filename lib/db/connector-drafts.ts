/**
 * CRUD layer for the `connectorDrafts` Dexie table (schema v18).
 *
 * Outbound message drafts awaiting human approval (manual connector mode).
 * Drafts start as "pending", and are transitioned to "approved", "rejected",
 * or "expired" (via a sweep of past-`expiresAt` rows).
 */

import type { ConnectorDraftRow } from "./connector-types"
import type { MessageSegment } from "@/types/connectors/segment"
import type { OutboundRequest } from "@/types/connectors/outbound"
import { getDb } from "./schema"
import { resolveSessionProjectId } from "./project-scope"

function newId(): string {
  return "cdr_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

export interface CreateDraftInput {
  conversationKey: string
  sessionId: string
  segments: MessageSegment[]
  sourceMessageId?: string
  expiresAt?: number
  outboundPreview?: OutboundRequest
}

export async function createDraft(input: CreateDraftInput): Promise<ConnectorDraftRow> {
  const row: ConnectorDraftRow = {
    id: newId(),
    conversationKey: input.conversationKey,
    sessionId: input.sessionId,
    // Workspace isolation (Dexie v86): a draft inherits its session's workspace.
    projectId: await resolveSessionProjectId(input.sessionId),
    segments: input.segments,
    status: "pending",
    createdAt: Date.now(),
    expiresAt: input.expiresAt,
    sourceMessageId: input.sourceMessageId,
    outboundPreview: input.outboundPreview,
  }
  await getDb().connectorDrafts.add(row)
  return row
}

/**
 * List pending drafts for a conversation, ordered by createdAt ascending (FIFO).
 */
export async function listPendingForConversation(
  conversationKey: string
): Promise<ConnectorDraftRow[]> {
  return getDb()
    .connectorDrafts.where("[conversationKey+createdAt]")
    .between([conversationKey, -Infinity], [conversationKey, Infinity])
    .filter((r) => r.status === "pending")
    .toArray()
}

/**
 * List every pending draft across all conversations, newest-first. Used by
 * the mobile draft-approval panel so the user sees one global queue.
 */
export async function listAllPendingDrafts(): Promise<ConnectorDraftRow[]> {
  const rows = await getDb().connectorDrafts.where("status").equals("pending").toArray()
  rows.sort((a, b) => b.createdAt - a.createdAt)
  return rows
}

/** Approve a draft — transitions status to "approved". */
export async function approveDraft(id: string): Promise<void> {
  await getDb().connectorDrafts.update(id, { status: "approved" })
}

/** Reject a draft — transitions status to "rejected". */
export async function rejectDraft(id: string): Promise<void> {
  await getDb().connectorDrafts.update(id, { status: "rejected" })
}

/**
 * Sweep pending drafts whose `expiresAt < now`, set their status to "expired".
 * Returns the count of rows swept.
 */
export async function sweepExpired(now = Date.now()): Promise<number> {
  const db = getDb()
  const expired = await db.connectorDrafts
    .where("status")
    .equals("pending")
    .filter((r) => r.expiresAt !== undefined && r.expiresAt < now)
    .toArray()
  if (expired.length === 0) return 0
  await db.connectorDrafts.bulkPut(expired.map((r) => ({ ...r, status: "expired" as const })))
  return expired.length
}
