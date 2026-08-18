/**
 * In-flight conversation-override mutation registry (ADR-0131, Slice 2.1).
 *
 * A thin client applies an override mutation OPTIMISTICALLY to its local
 * Dexie mirror and ships the authoritative write to the host through the
 * durable `mobileOutboundQueue`. Until the host has applied it, a companion
 * `sync_pull` of `conversationOverrides` would hand back the PRE-mutation row
 * and clobber the optimistic write — the user flips the mode, the pill flips
 * back, then flips again a second later. The sync handler
 * (`lib/sync/handlers/conversation-overrides.ts`) therefore skips rows whose
 * conversation key has a pending mutation.
 *
 * Two sources are consulted:
 *   - an in-memory refcount, held from "about to enqueue" through "optimistic
 *     write done" (covers the window before the queue row is persisted); and
 *   - the durable queue itself: any `conversation_overrides_update` row that
 *     is still `pending` / `sending` / `failed` for the active scope. This
 *     survives a reload — the memory marker does not, the queue row does.
 */

import { getDb } from "@/lib/db/schema"
import type { MobileOutboundJobRow } from "@/lib/db/mobile-outbound-types"
import { conversationKeyOfMutation } from "./override-mutation"

const inMemory = new Map<string, number>()

/** Hold an in-flight marker for `conversationKey`; returns the release function. */
export function markPendingOverrideMutation(conversationKey: string): () => void {
  inMemory.set(conversationKey, (inMemory.get(conversationKey) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const next = (inMemory.get(conversationKey) ?? 1) - 1
    if (next <= 0) inMemory.delete(conversationKey)
    else inMemory.set(conversationKey, next)
  }
}

/** Synchronous check of the in-memory marker only. */
export function hasPendingOverrideMutation(conversationKey: string): boolean {
  return inMemory.has(conversationKey)
}

const IN_FLIGHT_STATUSES: ReadonlySet<MobileOutboundJobRow["status"]> = new Set([
  "pending",
  "sending",
  "failed",
])

/**
 * Every conversation key with an in-flight override mutation — the union of
 * the memory markers and the durable queue's unfinished
 * `conversation_overrides_update` rows. Never throws: a Dexie failure
 * degrades to the memory markers so the sync handler still runs.
 */
export async function pendingOverrideConversationKeys(): Promise<Set<string>> {
  const keys = new Set(inMemory.keys())
  try {
    const rows = await getDb()
      .mobileOutboundQueue.where("status")
      .anyOf(Array.from(IN_FLIGHT_STATUSES))
      .filter((row) => row.command === "conversation_overrides_update")
      .toArray()
    for (const row of rows) {
      const key = conversationKeyOfMutation(row.payload.mutation)
      if (key) keys.add(key)
      // Legacy `{ input }` payload shape (pre-ADR-0131 callers).
      const input = row.payload.input as { conversationKey?: unknown } | undefined
      if (typeof input?.conversationKey === "string") keys.add(input.conversationKey)
    }
  } catch {
    // Degrade to the memory markers — see doc.
  }
  return keys
}

/** Test-only reset of the memory markers. */
export function __resetPendingOverridesForTests(): void {
  inMemory.clear()
}
