"use client"

/**
 * Reactive conversation assignment/status/label trail (CRM, schema v83).
 * Returns the append-only event log for one conversation, oldest → newest,
 * via the [conversationKey+at] index. Read-only; the activity log interleaves
 * these with connector-audit rows.
 */

import { useLiveQuery } from "dexie-react-hooks"
import { getDb } from "@/lib/db/schema"
import type { ConversationAssignmentEventRow } from "@/lib/db/crm-types"

/**
 * `conversationKey` is optional so callers that may not have one yet — the
 * Inbox notice area mounts on every route, conversation-bound or not — can
 * pass it straight through instead of coercing to `""` at the call site. The
 * empty-key guard below already covers both.
 */
export function useConversationAssignmentEvents(
  conversationKey: string | undefined
): ConversationAssignmentEventRow[] {
  const rows = useLiveQuery<ConversationAssignmentEventRow[]>(() => {
    if (typeof window === "undefined" || !conversationKey) return Promise.resolve([])
    return getDb()
      .conversationAssignmentEvents.where("[conversationKey+at]")
      .between([conversationKey, 0], [conversationKey, Infinity])
      .toArray()
  }, [conversationKey])

  return rows ?? []
}
