/**
 * IM conversation ↔ ChatSession binding lookups (control-plane multi-session).
 *
 * Historically the connector runtime kept exactly one ChatSession per IM
 * conversation and found it with a full-table scan
 * (`findSessionByConversationKey`). The control-plane completion adds
 * multi-session support (`/new` / `/switch` / `/sessions`), which needs to
 * enumerate every session bound to a conversation and track which one is
 * active. Both are O(log n) now that `sessions.platformConversationKey` is
 * indexed (Dexie v85).
 *
 * These helpers live in their own module (rather than `runtime.ts`) so the
 * command dispatcher can reuse them without importing the heavy runtime
 * install path — avoiding an import cycle (runtime → session-bindings, never
 * the reverse). `runtime.ts` re-exports `findSessionByConversationKey` so
 * existing importers (`scheduled-outbound.ts`, `use-history-hydration.ts`)
 * keep working unchanged.
 */

import type { ChatSession } from "@/lib/claude/types"
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { ConversationOverrideRow } from "@/lib/db/connector-types"
import { getDb } from "@/lib/db/schema"

/**
 * Find a ChatSession bound to the given IM conversation. Uses the v85
 * `platformConversationKey` index; falls back to the legacy full-scan match
 * on `platformBinding.conversationKey` for any row the backfill missed (e.g.
 * a session written between the index add and the upgrade in the same tick).
 * Returns the most-recently-updated match when several exist.
 */
export async function findSessionByConversationKey(
  conversationKey: string
): Promise<ChatSession | undefined> {
  const db = getDb()
  const indexed = await db.sessions
    .where("platformConversationKey")
    .equals(conversationKey)
    .toArray()
  if (indexed.length > 0) {
    return indexed.sort((a, b) => b.updatedAt - a.updatedAt)[0]
  }
  // Legacy fallback: rows that pre-date v85 and weren't reached by the
  // backfill (defensive — the upgrade hook normally covers them).
  const all = await db.sessions.toArray()
  return all
    .filter((s) => s.platformBinding?.conversationKey === conversationKey)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]
}

/**
 * List every ChatSession bound to the given IM conversation, newest first.
 * Powers `/sessions` and `/switch` resolution.
 */
export async function listSessionsByConversationKey(
  conversationKey: string
): Promise<ChatSession[]> {
  const db = getDb()
  const indexed = await db.sessions
    .where("platformConversationKey")
    .equals(conversationKey)
    .toArray()
  if (indexed.length > 0) {
    return indexed.sort((a, b) => b.updatedAt - a.updatedAt)
  }
  const all = await db.sessions.toArray()
  return all
    .filter((s) => s.platformBinding?.conversationKey === conversationKey)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * Resolve the active ChatSession for a conversation: the one pointed to by
 * `override.activeSessionId` (set by `/new` / `/switch`) when it still exists
 * and is bound to this conversation, otherwise the most-recently-updated bound
 * session, otherwise `undefined` (caller creates one). Never creates a row.
 */
export async function findActiveSessionForConversation(
  conversationKey: string,
  override?: Pick<ConversationOverrideRow, "activeSessionId"> | undefined
): Promise<ChatSession | undefined> {
  const bound = await listSessionsByConversationKey(conversationKey)
  if (override?.activeSessionId) {
    const active = bound.find((s) => s.id === override.activeSessionId)
    if (active) return active
  }
  return bound[0]
}

/**
 * Create a ChatSession bound to the given platform conversation. Sets both
 * `platformBinding` and the denormalized `platformConversationKey` index
 * column (v85) so multi-session enumeration finds it.
 */
export async function createPlatformSession(
  event: NormalizedInboundEvent,
  characterId: string | undefined
): Promise<ChatSession> {
  const now = Date.now()
  const session: ChatSession = {
    id: crypto.randomUUID(),
    title: event.channel.name ?? event.sender.displayName ?? event.conversationKey,
    kind: "direct",
    characterId,
    platformBinding: {
      platform: event.platform,
      adapterId: event.adapterId,
      conversationKey: event.conversationKey,
      conversationRef: event.conversationRef,
    },
    platformConversationKey: event.conversationKey,
    createdAt: now,
    updatedAt: now,
  }
  await getDb().sessions.add(session)
  return session
}
