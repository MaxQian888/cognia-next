"use client"

import { useCallback, useMemo, useRef } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import type { UIMessage } from "ai"

import { PerfBoundary } from "@/lib/perf"
import { estimateMessageHeight } from "@/lib/chat/row-height-estimate"
import { shouldVirtualizeMessages } from "@/lib/chat/virtualization-threshold"
import { MessageRenderer } from "./message-renderer"
import { useMessageDisplay } from "@/hooks/chat/use-message-display"
import { useStickToBottom } from "@/hooks/chat/use-stick-to-bottom"
import { useIsomorphicLayoutEffect } from "@/hooks/use-isomorphic-layout-effect"
import type { ResolvedMessageDisplayOptions } from "@/lib/chat/message-display"

const BOTTOM_SLOP_PX = 80

export type TranscriptRenderStatus =
  "loading" | "idle" | "streaming" | "awaiting_approval" | "error"

export interface TranscriptMessageListProps {
  messages: UIMessage[]
  status: TranscriptRenderStatus
  sessionId: string
  messageDisplay?: ResolvedMessageDisplayOptions
}

/**
 * Read-only transcript lane shared by remote and observer surfaces.
 *
 * It deliberately owns no active-chat actions, TTS, search shortcuts, or
 * minimap state. Rich message semantics stay centralized in MessageRenderer,
 * while this wrapper contributes only row virtualization and stream pinning.
 */
export function TranscriptMessageList({
  messages,
  status,
  sessionId,
  messageDisplay: providedMessageDisplay,
}: TranscriptMessageListProps) {
  const fallbackMessageDisplay = useMessageDisplay()
  const messageDisplay = providedMessageDisplay ?? fallbackMessageDisplay
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  // ADR-0127 §3: count OR total-text trigger, shared with the live list.
  const virtualize = shouldVirtualizeMessages(messages)
  const active = status === "streaming" || status === "awaiting_approval"
  const streamingRowIndex =
    active && messages.at(-1)?.role === "assistant" ? messages.length - 1 : -1
  const liveTail = streamingRowIndex >= 0 ? messages[streamingRowIndex] : undefined
  const { handleScroll, handleContentClick, resetToBottom, pinNow } = useStickToBottom({
    scrollRef,
    contentRef,
    enabled: true,
    active,
    pinKey: messages,
    thresholdPx: BOTTOM_SLOP_PX,
  })
  const getItemKey = useCallback(
    (index: number) => `${sessionId}:${messages[index]?.id ?? index}`,
    [messages, sessionId]
  )

  const lastAssistantId = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === "assistant") return messages[index]!.id
    }
    return null
  }, [messages])

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual returns non-memoizable functions by design
  const rowVirtualizer = useVirtualizer({
    count: messages.length - (liveTail ? 1 : 0),
    getItemKey,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => estimateMessageHeight(messages[index]!),
    overscan: 5,
    measureElement: (element) => Math.round(element?.getBoundingClientRect().height ?? 0),
  })

  const hasMessages = messages.length > 0
  useIsomorphicLayoutEffect(() => {
    rowVirtualizer.measure()
    resetToBottom()
  }, [rowVirtualizer, sessionId, hasMessages, resetToBottom])

  useIsomorphicLayoutEffect(() => {
    rowVirtualizer.measure()
  }, [messageDisplay, rowVirtualizer])

  // Return the completed tail to measured rows without moving a reader who
  // scrolled up. The active tail itself uses its real document-flow height.
  useIsomorphicLayoutEffect(() => {
    pinNow()
  }, [streamingRowIndex, pinNow])

  const renderMessage = (message: UIMessage, index: number) => (
    <MessageRenderer
      message={message}
      isStreaming={index === streamingRowIndex}
      isLastAssistant={message.id === lastAssistantId}
      messageDisplay={messageDisplay}
    />
  )

  const virtualItems = rowVirtualizer.getVirtualItems()
  // Keep an index sentinel on flow rows: a retained DOM node may still have
  // a queued virtualizer measurement from before streaming/threshold changes.
  const rows = virtualize
    ? virtualItems.map((item) => ({ index: item.index, start: item.start, live: false }))
    : messages.map((_, index) => ({ index, start: 0, live: true }))
  if (virtualize && liveTail) rows.push({ index: streamingRowIndex, start: 0, live: true })

  return (
    <PerfBoundary id="chat:read-only-transcript">
      <div
        ref={scrollRef}
        role="log"
        aria-busy={status === "streaming"}
        data-session-id={sessionId}
        className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain"
        onScroll={handleScroll}
      >
        <div
          ref={contentRef}
          onClickCapture={handleContentClick}
          className="mx-auto w-full max-w-[52rem] py-5 sm:py-7"
          data-slot="conversation-reading-column"
        >
          <div
            style={{
              paddingTop: virtualize ? rowVirtualizer.getTotalSize() : undefined,
              position: "relative",
            }}
          >
            {rows.map((row) => {
              const message = messages[row.index]
              if (!message) return null
              return (
                <div
                  key={message.id}
                  ref={row.live ? undefined : rowVirtualizer.measureElement}
                  data-index={row.live ? -1 : row.index}
                  data-msg-id={message.id}
                  className="px-3 sm:px-5"
                  style={
                    row.live
                      ? undefined
                      : {
                          position: "absolute",
                          top: 0,
                          left: 0,
                          width: "100%",
                          transform: `translateY(${row.start}px)`,
                        }
                  }
                >
                  {renderMessage(message, row.index)}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </PerfBoundary>
  )
}
