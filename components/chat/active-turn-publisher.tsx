"use client"

/**
 * Publishes which conversation turn is at the top of the chat viewport, so the
 * artifact dock can highlight the tab that turn produced.
 *
 * Renders nothing, on purpose. `useTimelineScrollSync` sets state on every
 * scroll frame — that hook is deliberately self-contained so scrolling never
 * re-renders the message list — so the subscriber has to be a leaf. This
 * component absorbs the per-frame re-render and forwards to
 * `chatViewportStore` only when the turn actually changes, which is why the
 * dock re-renders per message rather than per frame.
 *
 * The turn set here is intentionally *unfiltered*: the minimap runs its own
 * `useTimelineScrollSync` over a possibly bookmark-filtered list, whose
 * `activeIndex` would point at the wrong turn for this purpose.
 */

import { memo, useEffect } from "react"
import type { Virtualizer } from "@tanstack/react-virtual"
import type { UIMessage } from "ai"
import { useChatViewportStore } from "@/stores/chat/chat-viewport-store"
import { useTimelineTurns } from "./minimap/use-timeline-turns"
import { useTimelineScrollSync } from "./minimap/use-timeline-scroll-sync"

interface ActiveTurnPublisherProps {
  messages: UIMessage[]
  scrollRef: React.RefObject<HTMLDivElement | null>
  virtualizer: Virtualizer<HTMLDivElement, Element> | null
  virtualize: boolean
  /** Height of the live-tail region — see `useTimelineScrollSync`. */
  getTailSize?: () => number
}

export const ActiveTurnPublisher = memo(function ActiveTurnPublisher({
  messages,
  scrollRef,
  virtualizer,
  virtualize,
  getTailSize,
}: ActiveTurnPublisherProps) {
  const turns = useTimelineTurns(messages)
  const geometry = useTimelineScrollSync({ scrollRef, virtualizer, virtualize, turns, getTailSize })
  const setActiveTurnMessageIds = useChatViewportStore((state) => state.setActiveTurnMessageIds)

  const activeTurn = geometry.activeIndex >= 0 ? turns[geometry.activeIndex] : undefined
  const activeIds = activeTurn?.messageIds

  useEffect(() => {
    setActiveTurnMessageIds(activeIds ?? [])
  }, [activeIds, setActiveTurnMessageIds])

  // Clear on unmount so a dock outliving the conversation stops highlighting.
  useEffect(() => () => setActiveTurnMessageIds([]), [setActiveTurnMessageIds])

  return null
})

export default ActiveTurnPublisher
