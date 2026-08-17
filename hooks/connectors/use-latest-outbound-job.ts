"use client"

/**
 * Resolve the NEWEST `outboundQueue` row for a conversation — the job whose
 * delivery status the Inbox conversation header surfaces (ADR-0009 §3A.2:
 * "delivery status pill"). Sibling of `useLastInboundForConversation`: that
 * hook answers "when did we last hear from the user?", this one answers
 * "did our last reply actually go out?".
 *
 * Implementation choices:
 *   - Uses the `[conversationKey+createdAt]` compound index and takes the
 *     last entry, so it is O(log n) regardless of queue size — no table scan
 *     and no per-row liveQuery fan-out (which is why the pill is mounted
 *     once in the header, not per conversation row).
 *   - Returns the full row (or `null`) — the pill needs status, lastError,
 *     source and id for the retry action.
 *   - SSR-safe: `null` when `window` is undefined so static export does not
 *     touch Dexie.
 */

import { useLiveQuery } from "dexie-react-hooks"
import { getDb } from "@/lib/db/schema"
import type { OutboundJobRow } from "@/lib/db/connector-types"

/**
 * Live-queries `outboundQueue` for the most recently created job keyed to
 * `conversationKey`. Returns `null` when the conversation has no outbound
 * job, when the key is empty, or during SSR. Re-runs reactively as the
 * outbound runner mutates rows.
 */
export function useLatestOutboundJob(
  conversationKey: string | null | undefined
): OutboundJobRow | null {
  return (
    useLiveQuery<OutboundJobRow | null>(() => {
      if (typeof window === "undefined" || !conversationKey) {
        return Promise.resolve(null)
      }
      return getDb()
        .outboundQueue.where("[conversationKey+createdAt]")
        .between([conversationKey, -Infinity], [conversationKey, Infinity], true, true)
        .last()
        .then((row) => row ?? null)
    }, [conversationKey]) ?? null
  )
}
