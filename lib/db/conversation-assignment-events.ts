/**
 * CRUD for the `conversationAssignmentEvents` table (schema v83) — the
 * append-only status / assignment / label trail rendered in the conversation
 * activity log. Capped per-conversation so a long-lived conversation can't
 * grow the table without bound (mirrors the connector-audit ring buffer).
 */

import type { AssignmentEventKind, ConversationAssignmentEventRow } from "./crm-types"
import { getDb } from "./schema"

/** Keep at most this many trail entries per conversation (oldest evicted). */
export const MAX_ASSIGNMENT_EVENTS_PER_CONVERSATION = 200

function newId(): string {
  return "cae_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

export interface AppendAssignmentEventInput {
  conversationKey: string
  kind: AssignmentEventKind
  at?: number
  fields?: Record<string, unknown>
}

/** Append one trail entry and prune the conversation's oldest beyond the cap. */
export async function appendAssignmentEvent(
  input: AppendAssignmentEventInput
): Promise<ConversationAssignmentEventRow> {
  const db = getDb()
  const row: ConversationAssignmentEventRow = {
    id: newId(),
    conversationKey: input.conversationKey,
    kind: input.kind,
    at: input.at ?? Date.now(),
    ...(input.fields ? { fields: input.fields } : {}),
  }
  await db.conversationAssignmentEvents.add(row)
  await pruneOldest(input.conversationKey)
  return row
}

/** List a conversation's trail, oldest → newest (via the [conversationKey+at] index). */
export async function listAssignmentEvents(
  conversationKey: string
): Promise<ConversationAssignmentEventRow[]> {
  return getDb()
    .conversationAssignmentEvents.where("[conversationKey+at]")
    .between([conversationKey, 0], [conversationKey, Infinity])
    .toArray()
}

async function pruneOldest(conversationKey: string): Promise<void> {
  const db = getDb()
  const all = await listAssignmentEvents(conversationKey)
  if (all.length <= MAX_ASSIGNMENT_EVENTS_PER_CONVERSATION) return
  const excess = all.slice(0, all.length - MAX_ASSIGNMENT_EVENTS_PER_CONVERSATION)
  await db.conversationAssignmentEvents.bulkDelete(excess.map((e) => e.id))
}
