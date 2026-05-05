/**
 * CRUD layer for the `conversationOverrides` Dexie table (schema v18).
 *
 * Per-conversation settings that override adapter-level defaults.
 * Keyed by `conversationKey` (unique constraint `&conversationKey`).
 */

import type { ConversationOverrideRow } from "./connector-types"
import type { ConnectorMode } from "@/types/connectors/policy"
import { getDb } from "./schema"

function newId(): string {
  return "cov_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

export type ConversationOverrideInput = Omit<
  ConversationOverrideRow,
  "id" | "createdAt" | "updatedAt"
>

/**
 * Create or update the override row for a conversation key. Bumps `updatedAt`.
 */
export async function upsertByConversationKey(
  input: ConversationOverrideInput
): Promise<ConversationOverrideRow> {
  const db = getDb()
  const now = Date.now()
  const existing = await db.conversationOverrides
    .where("conversationKey")
    .equals(input.conversationKey)
    .first()

  if (existing) {
    const updated: ConversationOverrideRow = {
      ...existing,
      ...input,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: now,
    }
    await db.conversationOverrides.put(updated)
    return updated
  }

  const row: ConversationOverrideRow = {
    id: newId(),
    ...input,
    createdAt: now,
    updatedAt: now,
  }
  await db.conversationOverrides.add(row)
  return row
}

/** Return the override row for a conversation key, or undefined. */
export async function readForResolution(
  conversationKey: string
): Promise<ConversationOverrideRow | undefined> {
  return getDb().conversationOverrides.where("conversationKey").equals(conversationKey).first()
}

/** Set or clear the `pinned` flag. */
export async function setPinned(id: string, pinned: boolean): Promise<void> {
  await getDb().conversationOverrides.update(id, { pinned, updatedAt: Date.now() })
}

/** Set or clear the `archived` flag. */
export async function setArchived(id: string, archived: boolean): Promise<void> {
  await getDb().conversationOverrides.update(id, { archived, updatedAt: Date.now() })
}
