"use client"

import { useCallback, useEffect, useMemo, useRef } from "react"
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
import type { RewindFilesResult } from "@/lib/claude/ipc"
import type { ResolvedMessageDisplayOptions } from "@/lib/chat/message-display"

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
    onRewindFiles?: (
      sessionId: string,
      checkpointId: string,
      dryRun: boolean
    ) => Promise<RewindFilesResult>
    projectRoot?: string | null
    /** Mutations are exposed only for rows present in the caller's writable window. */
    mutableMessageIds?: ReadonlySet<string>
    messageDisplay?: ResolvedMessageDisplayOptions
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
      onRewindFiles={adapters?.onRewindFiles}
      projectRoot={adapters?.projectRoot}
      messageDisplay={adapters?.messageDisplay}
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
  const getItemKey = useCallback(
    (index: number) => `${props.sessionId}:${props.items[index]?.itemKey ?? "active-live-turn"}`,
    [props.items, props.sessionId]
  )
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual exposes imperative measurement methods
  const virtualizer = useVirtualizer({
    count: rowCount,
    getItemKey,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 280,
    overscan: 4,
    measureElement: (element) => Math.round(element?.getBoundingClientRect().height ?? 0),
  })
  useEffect(() => {
    if (typeof virtualizer.measure === "function") virtualizer.measure()
  }, [props.renderAdapters?.messageDisplay, virtualizer])
  const newestCompletedItemKey = [...props.items]
    .reverse()
    .find((item) => item.kind === "completed-turn")?.itemKey

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
                  key={virtualItem.key}
                  ref={virtualizer.measureElement}
                  data-index={virtualItem.index}
                  className="absolute left-0 top-0 w-full"
                  style={{ transform: `translateY(${virtualItem.start}px)` }}
                >
                  {isLive ? (
                    renderMessages(
                      props.liveMessages,
                      props.liveStatus === "streaming",
                      props.renderAdapters,
                      true
                    )
                  ) : item ? (
                    <TranscriptTimelineRow
                      item={item}
                      sessionId={props.sessionId}
                      expanded={
                        item.kind === "completed-turn" && props.expandedTurnKeys.has(item.turnKey)
                      }
                      detail={
                        item.kind === "completed-turn" && props.expandedTurnKeys.has(item.turnKey)
                          ? props.getDetail(item.turnKey)
                          : undefined
                      }
                      adapters={props.renderAdapters}
                      allowRegenerate={
                        item.itemKey === newestCompletedItemKey && props.liveMessages.length === 0
                      }
                      labels={props.labels}
                      onExpand={props.onExpand}
                      onCollapse={props.onCollapse}
                    />
                  ) : null}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </PerfBoundary>
  )
}

/** Keep canonical message identities stable while adjacent rows stream or scroll. */
function TranscriptTimelineRow({
  item,
  sessionId,
  expanded,
  detail,
  adapters,
  allowRegenerate,
  labels,
  onExpand,
  onCollapse,
}: {
  item: TranscriptTimelineItem
  sessionId: string
  expanded: boolean
  detail?: SessionTurnMessagesPage
  adapters: TranscriptTimelineSurfaceProps["renderAdapters"]
  allowRegenerate: boolean
  labels: TranscriptTimelineLabels
  onExpand: TranscriptTimelineSurfaceProps["onExpand"]
  onCollapse: TranscriptTimelineSurfaceProps["onCollapse"]
}) {
  const messages = useMemo(() => {
    if (item.kind === "active-turn") return item.messages.map(fullMessage)
    if (item.kind === "system") return [previewMessage(item.message, sessionId)]
    return (
      detail?.messages.map(fullMessage) ??
      collapsedMessages(item).map((message) => previewMessage(message, sessionId))
    )
  }, [item, detail, sessionId])

  if (item.kind !== "completed-turn") {
    return renderMessages(messages, item.kind === "active-turn", adapters)
  }
  return (
    <div data-turn-key={item.turnKey}>
      {renderMessages(messages, false, adapters, allowRegenerate)}
      {expanded && !detail ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">{labels.loading}</p>
      ) : null}
      {item.collapsed.exists || detail ? (
        <div className="px-3 pb-3 sm:px-5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() =>
              expanded
                ? onCollapse(item.turnKey)
                : onExpand(item.turnKey, item.revision, item.detailRevision)
            }
          >
            {expanded ? labels.collapse : labels.expand}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
