"use client"

/**
 * Live-query the system-event "activity" for a conversation from
 * `connectorAudit` — message edits / deletes, member changes, read receipts,
 * quiet-hour / muted deferrals, help & welcome cards, IM goal start/block, and
 * Computer-Use toggles. Shares the `connectorAudit` source + look-back pattern
 * with `useLastInboundForConversation`, but answers "what non-message events
 * happened in THIS conversation?" so the Inbox can render an activity log
 * without touching the shared ChatPane.
 */

import { useLiveQuery } from "dexie-react-hooks"
import { getDb } from "@/lib/db/schema"
import type { AuditEntry, AuditKind } from "@/types/connectors/audit"

/** Curated audit kinds surfaced in the conversation activity log. */
export const ACTIVITY_KINDS: ReadonlySet<AuditKind> = new Set<AuditKind>([
  "inbound.edited",
  "inbound.deleted",
  "inbound.read_indicator",
  "inbound.member_added",
  "inbound.member_removed",
  "inbound.deferred_quiet_hours",
  "inbound.deferred_muted",
  "inbound.help_served",
  "inbound.welcome_sent",
  "goal.started.im",
  "goal.blocked.im",
  "override.computer_use_changed",
])

export function isActivityKind(kind: AuditKind): boolean {
  return ACTIVITY_KINDS.has(kind)
}

const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_LIMIT = 50

export interface UseConversationActivityOptions {
  windowMs?: number
  limit?: number
  now?: () => number
}

export function useConversationActivity(
  conversationKey: string | null | undefined,
  options: UseConversationActivityOptions = {}
): AuditEntry[] {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS
  const limit = options.limit ?? DEFAULT_LIMIT
  const now = (options.now ?? Date.now)()
  const since = now - windowMs

  return (
    useLiveQuery<AuditEntry[]>(() => {
      if (typeof window === "undefined" || !conversationKey) {
        return Promise.resolve([])
      }
      return getDb()
        .connectorAudit.where("at")
        .above(since)
        .filter((row) => row.conversationKey === conversationKey && isActivityKind(row.kind))
        .reverse()
        .limit(limit)
        .toArray()
    }, [conversationKey, since, limit]) ?? []
  )
}
