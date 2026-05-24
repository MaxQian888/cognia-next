"use client"

/**
 * On-demand "load earlier messages" hydration for a platform conversation.
 *
 * Every adapter implements `fetchHistory` (Telegram / Discord / Slack / Lark /
 * OneBot) but nothing in the runtime ever calls it — inbound history was never
 * back-filled into a session. This hook wires that consumer:
 *
 *   1. Resolve the running adapter from the bus (Tauri-only).
 *   2. Use the oldest stored message's `platformMessageId` as the `before`
 *      cursor so each call walks strictly older messages.
 *   3. Stream `adapter.fetchHistory(...)`, skip events already stored (dedup by
 *      platformMessageId), and persist the rest via the same
 *      `insertInboundMessage` projection the live route handler uses — with the
 *      event's original timestamp so back-filled rows sort before live ones.
 *
 * Crucially this does NOT run the AI pipeline: history is stored, never replied
 * to. No-op outside Tauri (the bus has no registered adapters in web mode).
 */

import { useCallback, useState } from "react"
import { getBus } from "@/lib/connectors/bus"
import { findSessionByConversationKey, insertInboundMessage } from "@/lib/connectors/runtime"
import { getDb } from "@/lib/db/schema"
import { isTauri } from "@/lib/tauri"

/** Max events pulled per hydrate() call. Adapters also cap their own pages. */
export const HISTORY_PAGE_MAX = 50

export interface HistoryHydrationResult {
  hydrating: boolean
  /** Number of messages inserted by the most recent hydrate(); null until first run. */
  lastCount: number | null
  /** Error kind from the most recent hydrate(); null on success. */
  error: "unsupported" | "failed" | null
  /** False in web mode (no running adapters) — callers render a disabled affordance. */
  canHydrate: boolean
  /** Pull a page of older history into the session. Resolves with the insert count. */
  hydrate: () => Promise<number>
}

export function useHistoryHydration(
  conversationKey: string,
  adapterId: string
): HistoryHydrationResult {
  const [hydrating, setHydrating] = useState(false)
  const [lastCount, setLastCount] = useState<number | null>(null)
  const [error, setError] = useState<"unsupported" | "failed" | null>(null)

  const canHydrate = isTauri()

  const hydrate = useCallback(async (): Promise<number> => {
    if (!isTauri()) {
      setError("unsupported")
      return 0
    }
    setHydrating(true)
    setError(null)
    try {
      const adapter = getBus()
        .listAdapters()
        .find((a) => a.id === adapterId)
      if (!adapter || typeof adapter.fetchHistory !== "function") {
        setError("unsupported")
        setLastCount(null)
        return 0
      }

      const session = await findSessionByConversationKey(conversationKey)
      if (!session) {
        setLastCount(0)
        return 0
      }

      const db = getDb()
      const existing = await db.messages.where("sessionId").equals(session.id).toArray()
      const seen = new Set<string>()
      let oldestPlatformId: string | undefined
      let oldestAt = Number.POSITIVE_INFINITY
      for (const m of existing) {
        if (typeof m.platformMessageId === "string") {
          seen.add(m.platformMessageId)
          if (m.createdAt < oldestAt) {
            oldestAt = m.createdAt
            oldestPlatformId = m.platformMessageId
          }
        }
      }

      let inserted = 0
      for await (const event of adapter.fetchHistory(conversationKey, {
        before: oldestPlatformId,
        max: HISTORY_PAGE_MAX,
      })) {
        // Only back-fill plain messages; edit/delete/system events have no
        // standalone history row to create.
        if (event.kind && event.kind !== "create") continue
        if (event.messageId && seen.has(event.messageId)) continue
        await insertInboundMessage(event, session.id, event.timestamp)
        if (event.messageId) seen.add(event.messageId)
        inserted++
      }

      setLastCount(inserted)
      return inserted
    } catch {
      setError("failed")
      setLastCount(null)
      return 0
    } finally {
      setHydrating(false)
    }
  }, [conversationKey, adapterId])

  return { hydrating, lastCount, error, canHydrate, hydrate }
}
