"use client"

import { useEffect, useMemo, useRef } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import type { UIMessage } from "ai"

import { PerfBoundary } from "@/lib/perf"
import { estimateMessageHeight } from "@/lib/chat/row-height-estimate"
import { MessageRenderer } from "./message-renderer"

const VIRTUALIZE_THRESHOLD = 40
const BOTTOM_SLOP_PX = 80

export type TranscriptRenderStatus =
  | "loading"
  | "idle"
  | "streaming"
  | "awaiting_approval"
  | "error"

export interface TranscriptMessageListProps {
  messages: UIMessage[]
  status: TranscriptRenderStatus
  sessionId: string
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
}: TranscriptMessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const pinnedToBottomRef = useRef(true)
  const virtualize = messages.length > VIRTUALIZE_THRESHOLD
  const streamingRowIndex =
    status === "streaming" && messages.at(-1)?.role === "assistant" ? messages.length - 1 : -1

  const lastAssistantId = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === "assistant") return messages[index]!.id
    }
    return null
  }, [messages])

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual returns non-memoizable functions by design
  const rowVirtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => estimateMessageHeight(messages[index]!),
    overscan: 5,
    measureElement: (element) => Math.round(element?.getBoundingClientRect().height ?? 0),
  })

  useEffect(() => {
    rowVirtualizer.measure()
    pinnedToBottomRef.current = true
    const frame = requestAnimationFrame(() => {
      const element = scrollRef.current
      if (element) element.scrollTop = element.scrollHeight
    })
    return () => cancelAnimationFrame(frame)
  }, [rowVirtualizer, sessionId])

  useEffect(() => {
    if (status !== "streaming" || !pinnedToBottomRef.current) return
    const frame = requestAnimationFrame(() => {
      const element = scrollRef.current
      if (element) element.scrollTop = element.scrollHeight
    })
    return () => cancelAnimationFrame(frame)
  }, [messages, status])

  useEffect(() => {
    const content = contentRef.current
    if (!content || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(() => {
      if (status !== "streaming" || !pinnedToBottomRef.current) return
      const element = scrollRef.current
      if (element) element.scrollTop = element.scrollHeight
    })
    observer.observe(content)
    return () => observer.disconnect()
  }, [status])

  const renderMessage = (message: UIMessage, index: number) => (
    <MessageRenderer
      message={message}
      isStreaming={index === streamingRowIndex}
      isLastAssistant={message.id === lastAssistantId}
    />
  )

  const virtualItems = rowVirtualizer.getVirtualItems()

  return (
    <PerfBoundary id="chat:read-only-transcript">
      <div
        ref={scrollRef}
        role="log"
        aria-busy={status === "streaming"}
        data-session-id={sessionId}
        className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain"
        onScroll={(event) => {
          const element = event.currentTarget
          pinnedToBottomRef.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_SLOP_PX
        }}
      >
        <div
          ref={contentRef}
          className="mx-auto w-full max-w-[52rem] py-5 sm:py-7"
          data-slot="conversation-reading-column"
        >
          {virtualize ? (
            <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}>
              {virtualItems.map((virtualItem) => {
                const message = messages[virtualItem.index]
                if (!message) return null
                return (
                  <div
                    key={message.id}
                    ref={
                      virtualItem.index === streamingRowIndex
                        ? undefined
                        : rowVirtualizer.measureElement
                    }
                    data-index={virtualItem.index}
                    data-msg-id={message.id}
                    className="px-3 sm:px-5"
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      transform: `translateY(${virtualItem.start}px)`,
                    }}
                  >
                    {renderMessage(message, virtualItem.index)}
                  </div>
                )
              })}
            </div>
          ) : (
            messages.map((message, index) => (
              <div key={message.id} data-msg-id={message.id} className="px-3 sm:px-5">
                {renderMessage(message, index)}
              </div>
            ))
          )}
        </div>
      </div>
    </PerfBoundary>
  )
}
