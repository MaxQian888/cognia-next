"use client"

/**
 * Live-query the cross-conversation pending-draft queue.
 *
 * `usePendingDrafts()` returns every `ConnectorDraftRow` in status "pending"
 * (newest-first, as `listAllPendingDrafts` orders them); `usePendingDraftsQuery()`
 * is the same read with `undefined` while it loads — the data source for the
 * desktop Draft Approval Center.
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

const NO_DRAFTS: ConnectorDraftRow[] = []

/**
 * The queue with its loading state intact: `undefined` until the first read
 * resolves. Surfaces that show an empty state (the Draft Center, the triage
 * pane's drafts section) need it, or they announce "no drafts" for the beat
 * before the real queue arrives.
 */
export function usePendingDraftsQuery(): ConnectorDraftRow[] | undefined {
  return useLiveQuery<ConnectorDraftRow[]>(
    () => (typeof window === "undefined" ? Promise.resolve([]) : listAllPendingDrafts()),
    []
  )
}

/** The queue, `[]` while loading — for badges and counts, where loading reads as zero. */
export function usePendingDrafts(): ConnectorDraftRow[] {
  return usePendingDraftsQuery() ?? NO_DRAFTS
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
