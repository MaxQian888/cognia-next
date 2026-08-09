"use client"

import { useRef } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import type { UIMessage } from "ai"
import type {
  Character,
  SessionTurnMessagesPage,
  TranscriptMessage,
  TranscriptMessagePreview,
  TranscriptTimelineItem,
} from "@cognia/agent-config-types"

import { Button } from "@/components/ui/button"
import { PerfBoundary } from "@/lib/perf"
import type { TranscriptRenderStatus } from "./transcript-message-list"
import { MessageRenderer } from "./message-renderer"

export interface TranscriptTimelineLabels {
  expand: string
  collapse: string
  loadOlder: string
  loading: string
  retry: string
}

export interface TranscriptTimelineSurfaceProps {
  sessionId: string
  items: TranscriptTimelineItem[]
  expandedTurnKeys: ReadonlySet<string>
  getDetail: (turnKey: string) => SessionTurnMessagesPage | undefined
  onExpand: (turnKey: string, revision: number, detailRevision: number) => void
  onCollapse: (turnKey: string) => void
  onLoadOlder: () => void
  onRetry: () => void
  hasMore: boolean
  loading: boolean
  loadingOlder: boolean
  error: unknown | null
  liveMessages: UIMessage[]
  liveStatus: TranscriptRenderStatus
  labels: TranscriptTimelineLabels
  renderAdapters?: {
    characterById?: Map<string, Character>
    directCharacter?: Character | null
    onCopy?: () => void
    onRegenerate?: () => void | Promise<void>
    onEditResend?: (messageId: string, newText: string) => void | Promise<void>
    projectRoot?: string | null
    /** Mutations are exposed only for rows present in the caller's writable window. */
    mutableMessageIds?: ReadonlySet<string>
  }
}

function previewMessage(preview: TranscriptMessagePreview, sessionId: string): UIMessage {
  const parts: UIMessage["parts"] = []
  if (preview.text) parts.push({ type: "text", text: preview.text })
  for (const media of preview.media ?? []) {
    parts.push({
      type: "file",
      url: media.ref,
      mediaType: media.mediaType ?? "application/octet-stream",
      ...(media.filename ? { filename: media.filename } : {}),
    })
  }
  return {
    id: preview.id,
    role: preview.role,
    parts,
    metadata: { sessionId, createdAt: preview.createdAt },
  }
}

function fullMessage(message: TranscriptMessage): UIMessage {
  return {
    id: message.id,
    role: message.role,
    parts: message.parts,
    metadata: {
      ...(message.metadata ?? {}),
      sessionId: message.sessionId,
      createdAt: message.createdAt,
      ...(message.turnKey ? { turnKey: message.turnKey } : {}),
    },
  }
}

function renderMessages(
  messages: UIMessage[],
  streaming = false,
  adapters?: TranscriptTimelineSurfaceProps["renderAdapters"],
  allowRegenerate = false
) {
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant")?.id
  return messages.map((message, index) => (
    <MessageRenderer
      key={message.id}
      message={message}
      isStreaming={streaming && index === messages.length - 1 && message.role === "assistant"}
      isLastAssistant={message.id === lastAssistant}
      characterById={adapters?.characterById}
      directCharacter={adapters?.directCharacter}
      onCopy={adapters?.onCopy}
      onRegenerate={
        allowRegenerate &&
        (!adapters?.mutableMessageIds || adapters.mutableMessageIds.has(message.id))
          ? adapters?.onRegenerate
          : undefined
      }
      onEditResend={
        !adapters?.mutableMessageIds || adapters.mutableMessageIds.has(message.id)
          ? adapters?.onEditResend
          : undefined
      }
      projectRoot={adapters?.projectRoot}
    />
  ))
}

function collapsedMessages(item: Extract<TranscriptTimelineItem, { kind: "completed-turn" }>) {
  const previews = [...item.userMessages]
  if (item.finalResponse) previews.push(item.finalResponse)
  if (item.visibleResult && item.visibleResult.id !== item.finalResponse?.id) {
    previews.push(item.visibleResult)
  }
  return previews
}

export function TranscriptTimelineSurface(props: TranscriptTimelineSurfaceProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const rowCount = props.items.length + (props.liveMessages.length > 0 ? 1 : 0)
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual exposes imperative measurement methods
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 280,
    overscan: 4,
    measureElement: (element) => Math.round(element?.getBoundingClientRect().height ?? 0),
  })
  const newestCompletedItemKey = [...props.items]
    .reverse()
    .find((item) => item.kind === "completed-turn")?.itemKey

  const renderItem = (item: TranscriptTimelineItem) => {
    if (item.kind === "active-turn") {
      return renderMessages(item.messages.map(fullMessage), true, props.renderAdapters)
    }
    if (item.kind === "system") {
      return renderMessages(
        [previewMessage(item.message, props.sessionId)],
        false,
        props.renderAdapters
      )
    }

    const expanded = props.expandedTurnKeys.has(item.turnKey)
    const detail = expanded ? props.getDetail(item.turnKey) : undefined
    const messages =
      detail?.messages.map(fullMessage) ??
      collapsedMessages(item).map((message) => previewMessage(message, props.sessionId))
    return (
      <div data-turn-key={item.turnKey}>
        {renderMessages(
          messages,
          false,
          props.renderAdapters,
          item.itemKey === newestCompletedItemKey && props.liveMessages.length === 0
        )}
        {expanded && !detail ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">{props.labels.loading}</p>
        ) : null}
        {item.collapsed.exists || detail ? (
          <div className="px-3 pb-3 sm:px-5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() =>
                expanded
                  ? props.onCollapse(item.turnKey)
                  : props.onExpand(item.turnKey, item.revision, item.detailRevision)
              }
            >
              {expanded ? props.labels.collapse : props.labels.expand}
            </Button>
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <PerfBoundary id="chat:transcript-timeline">
      <div
        ref={scrollRef}
        role="log"
        aria-busy={props.loading || props.liveStatus === "streaming"}
        data-session-id={props.sessionId}
        className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        <div className="mx-auto w-full max-w-[52rem] py-5 sm:py-7">
          {props.error ? (
            <div className="px-3 pb-3 sm:px-5">
              <Button type="button" variant="outline" size="sm" onClick={props.onRetry}>
                {props.labels.retry}
              </Button>
            </div>
          ) : null}
          {props.hasMore ? (
            <div className="px-3 pb-3 sm:px-5">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={props.loadingOlder}
                onClick={props.onLoadOlder}
              >
                {props.loadingOlder ? props.labels.loading : props.labels.loadOlder}
              </Button>
            </div>
          ) : null}
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((virtualItem) => {
              const item = props.items[virtualItem.index]
              const isLive = virtualItem.index === props.items.length
              return (
                <div
                  key={isLive ? "active-live-turn" : item?.itemKey}
                  ref={virtualizer.measureElement}
                  data-index={virtualItem.index}
                  className="absolute left-0 top-0 w-full"
                  style={{ transform: `translateY(${virtualItem.start}px)` }}
                >
                  {isLive
                    ? renderMessages(
                        props.liveMessages,
                        props.liveStatus === "streaming",
                        props.renderAdapters,
                        true
                      )
                    : item
                      ? renderItem(item)
                      : null}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </PerfBoundary>
  )
}
