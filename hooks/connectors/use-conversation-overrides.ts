"use client"

/**
 * Conversation-override hook (im-refactored-crayon).
 *
 * Two arities:
 *   - `useConversationOverride(key)` — single row for one conversation; the
 *     Inbox header gear + adapter Conversations tab both read this.
 *   - `useConversationOverrides(adapterId?)` — list, optionally scoped to a
 *     single adapter. Settings ConversationsTab uses this for its grid.
 *
 * The row is the source of truth for `mode`, `allowComputerUse`,
 * `providerOverride`, `modelOverride`, `pinned`, `archived`, plus the
 * `trigger` partial that carries quiet hours / muted / cooldownMs.
 */

import { useLiveQuery } from "dexie-react-hooks"
import { getDb } from "@/lib/db/schema"
import type { ConversationOverrideRow } from "@/lib/db/connector-types"

export function useConversationOverride(
  conversationKey: string | null | undefined
): ConversationOverrideRow | undefined {
  return useLiveQuery<ConversationOverrideRow | undefined>(() => {
    if (typeof window === "undefined" || !conversationKey) {
      return Promise.resolve(undefined)
    }
    return getDb().conversationOverrides.where("conversationKey").equals(conversationKey).first()
  }, [conversationKey])
}

export function useConversationOverrides(adapterId?: string | null): ConversationOverrideRow[] {
  const list = useLiveQuery<ConversationOverrideRow[]>(() => {
    if (typeof window === "undefined") return Promise.resolve([])
    return getDb().conversationOverrides.orderBy("updatedAt").reverse().toArray()
  }, [])
  if (!list) return []
  if (!adapterId) return list
  // `conversationKey` is `${platform}:${adapterId}:${chatId}` — filter by
  // the middle segment so the per-adapter tab only sees its own rows.
  const prefix = `:${adapterId}:`
  return list.filter((row) => row.conversationKey.includes(prefix))
}
