"use client"

/**
 * Resolve the newest `inbound.received` audit timestamp for a given
 * `conversationKey`. Lives next to `useAdapterHealth` because it shares the
 * same `connectorAudit` source, but it answers a narrower question — "when
 * did THIS conversation last hear from a user?" — that the adapter-wide
 * `lastActivityAt` cannot.
 *
 * The Inbox conversation header (Task P2.5) consumes this to render a
 * "last message X min ago" chip so an operator can spot stale
 * conversations at a glance without diving into the message list.
 *
 * Implementation choices:
 *   - 7-day look-back window — long enough for slow channels (weekly
 *     digest bots) without paying the full table scan cost.
 *   - Returns wall-clock ms (or `null` when the conversation has no
 *     recorded inbound in the window). The UI formats the human label.
 *   - SSR-safe: returns `null` when `window` is undefined so static
 *     export doesn't crash.
 */

import { useLiveQuery } from "dexie-react-hooks"
import { getDb } from "@/lib/db/schema"

const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

export interface UseLastInboundOptions {
  /** Override the look-back window (default 7 days). */
  windowMs?: number
  /** Override the clock for tests. */
  now?: () => number
}

/**
 * Live-queries `connectorAudit` for the newest `inbound.received` row
 * keyed to `conversationKey`. Returns `null` when no match exists or the
 * argument is empty / SSR. Re-runs reactively when audit rows land.
 */
export function useLastInboundForConversation(
  conversationKey: string | null | undefined,
  options: UseLastInboundOptions = {}
): number | null {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS
  const now = (options.now ?? Date.now)()
  const since = now - windowMs

  return (
    useLiveQuery<number | null>(() => {
      if (typeof window === "undefined" || !conversationKey) {
        return Promise.resolve(null)
      }
      return getDb()
        .connectorAudit.where("at")
        .above(since)
        .filter((row) => row.kind === "inbound.received" && row.conversationKey === conversationKey)
        .reverse()
        .first()
        .then((row) => row?.at ?? null)
    }, [conversationKey, since]) ?? null
  )
}
