"use client"

/**
 * Store-connected wrapper around {@link SessionCostBadge}.
 *
 * The badge needs the in-memory usage totals aggregated across the active
 * session's messages, which change on every streamed token. Subscribing to the
 * whole `messages` array here — instead of in `ChatHeader` — keeps the per-token
 * re-render confined to this tiny badge: the header, composer, and footer no
 * longer re-render as tokens arrive. `useShallow` bails out of the re-render
 * whenever the summed numbers are unchanged, so even this component only
 * re-renders when a usage field actually moves.
 */

import { useMemo } from "react"
import { useShallow } from "zustand/react/shallow"

import { SessionCostBadge } from "@/components/chat/session-cost-badge"
import { useChatStore } from "@/stores/chat"
import { getLatestUsage } from "@/lib/claude/usage"
import type { UsageInfo } from "@/lib/claude/adapter"
import type { UIMessage } from "ai"

interface Props {
  sessionId: string
  /** Caller supplies the i18n-formatted tokens label so the badge stays a
   *  pure presentation component without taking a translations namespace. */
  tokensLabel: (input: string, output: string) => string
}

export function SessionCostBadgeLive({ sessionId, tokensLabel }: Props) {
  // Cheap usage signature instead of an O(n) aggregate in the selector: the
  // old selector walked every message on EVERY store set (each streamed
  // frame), even when `useShallow` then bailed the render. Usage only moves
  // when a message lands or the latest assistant usage is merged, so subscribe
  // to [length, latest usage ref] (`getLatestUsage` early-exits from the tail
  // → O(1) per set) and run the O(n) sum only when that signature changes.
  const [messageCount, latestUsage] = useChatStore(
    useShallow((s) => [s.messages.length, getLatestUsage(s.messages as UIMessage[])] as const)
  )
  const usage = useMemo(
    () => aggregateUsage(useChatStore.getState().messages),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- messageCount/latestUsage key the getState() read above
    [messageCount, latestUsage]
  )
  if (!usage) return null
  return <SessionCostBadge sessionId={sessionId} inMemoryUsage={usage} tokensLabel={tokensLabel} />
}

/**
 * Sum the per-message `metadata.usage` into a single {@link UsageInfo}. Returns
 * `null` when no message carries usage so the badge can hide entirely.
 */
export function aggregateUsage(messages: UIMessage[]): UsageInfo | null {
  const totals: UsageInfo = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    totalCostUsd: 0,
  }
  let any = false
  for (const m of messages) {
    const meta = (m as { metadata?: { usage?: UsageInfo } }).metadata
    const u = meta?.usage
    if (!u) continue
    any = true
    totals.inputTokens! += u.inputTokens ?? 0
    totals.outputTokens! += u.outputTokens ?? 0
    totals.cacheReadInputTokens! += u.cacheReadInputTokens ?? 0
    totals.cacheCreationInputTokens! += u.cacheCreationInputTokens ?? 0
    totals.totalCostUsd! += u.totalCostUsd ?? 0
  }
  return any ? totals : null
}

export default SessionCostBadgeLive
