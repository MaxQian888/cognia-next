"use client"

/**
 * Live-query the cross-conversation pending-draft queue.
 *
 * `usePendingDrafts()` returns every `ConnectorDraftRow` in status "pending"
 * (newest-first, as `listAllPendingDrafts` orders them) — the data source for
 * the desktop Draft Approval Center.
 *
 * `usePendingDraftCounts()` derives a `conversationKey → count` map so list
 * rows and the sidebar entry can show a pending-draft badge without each row
 * opening its own subscriber.
 *
 * `usePendingDraftsForConversation()` narrows to one conversation. It filters
 * the shared subscription rather than opening a second live query — the draft
 * banner used to run its own duplicate `connectorDrafts` scan right next to
 * these.
 */

import { useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { listAllPendingDrafts } from "@/lib/db/connector-drafts"
import type { ConnectorDraftRow } from "@/lib/db/connector-types"

export function usePendingDrafts(): ConnectorDraftRow[] {
  return (
    useLiveQuery<ConnectorDraftRow[]>(
      () => (typeof window === "undefined" ? Promise.resolve([]) : listAllPendingDrafts()),
      []
    ) ?? []
  )
}

export function usePendingDraftCounts(): Map<string, number> {
  const drafts = usePendingDrafts()
  return useMemo(() => {
    const map = new Map<string, number>()
    for (const draft of drafts) {
      map.set(draft.conversationKey, (map.get(draft.conversationKey) ?? 0) + 1)
    }
    return map
  }, [drafts])
}

/**
 * Pending drafts for one conversation, newest-first. Returns an empty array
 * for an absent `conversationKey` so callers on the non-conversation Inbox
 * routes can mount unconditionally.
 */
export function usePendingDraftsForConversation(
  conversationKey: string | undefined
): ConnectorDraftRow[] {
  const drafts = usePendingDrafts()
  return useMemo(
    () => (conversationKey ? drafts.filter((d) => d.conversationKey === conversationKey) : []),
    [drafts, conversationKey]
  )
}
