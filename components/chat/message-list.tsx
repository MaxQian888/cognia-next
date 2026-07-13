"use client"

import { ChatThinkingIndicator } from "@/components/chat/thinking-indicator"
import { Button } from "@/components/ui/button"
import type { UIMessage } from "ai"
import { ArrowDownIcon } from "lucide-react"
import { MessageRenderer } from "./message-renderer"
import {
  CompactBoundaryMarker,
  isCompactBoundaryMessage,
} from "./message-parts/compact-boundary-part"
import { SessionNoticeMarker, isSessionNoticeMessage } from "./message-parts/session-notice-part"
import { HookNoticeMarker, isHookNoticeMessage } from "./message-parts/hook-notice-part"
import { LongPress } from "@/components/interactions/long-press"
import { MessageActionSheet } from "@/components/mobile/chat/message-action-sheet"
import { selectionFeedback } from "@/lib/capacitor/haptics"
import { deleteMessage as deleteMessageOnDesktop } from "@/lib/claude/ipc"
import { getDb } from "@/lib/db/schema"
import { useChatStore } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import { ConversationTimeline } from "./minimap/conversation-timeline"
import { usePlatform } from "@/hooks/use-platform"
import { useTranslations } from "next-intl"
import { InfoIcon } from "lucide-react"
import { useCharacters } from "@/lib/data-hooks/context"
import { useStableCharacterById } from "@/hooks/data/use-stable-character-by-id"
import { useChatAutoPlayTTS } from "@/hooks/media/use-chat-auto-play-tts"
import { useCompactionToast } from "@/hooks/chat/use-compaction-toast"
import type { Character } from "@cognia/agent-config-types"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { PerfBoundary } from "@/lib/perf"

// Lists at or below this length render in normal document flow (no
// virtualization): the per-row ResizeObserver churn and the scroll-time
// remounting of heavy rows (markdown / Tool cards / mermaid) cost more than
// windowing saves when there are only a handful of messages. ~40 covers the
// overwhelming majority of sessions while keeping flow-render cost bounded;
// longer histories still take the virtualized path.
export const VIRTUALIZE_THRESHOLD = 40

// Below this many messages the conversation is short enough to scan by
// scrolling, so the right-edge timeline minimap stays unmounted. Wide-screen /
// desktop gating happens in the component (it's `hidden lg:flex`).
export const TIMELINE_THRESHOLD = 20

interface Props {
  messages: UIMessage[]
  status: "idle" | "streaming" | "awaiting_approval" | "error"
  /** Session-bound character in a 1:1 chat — drives read-aloud / auto-play voice. */
  directCharacter?: Character | null
  onCopy?: () => void
  onRegenerate?: () => void | Promise<void>
  onEditResend?: (messageId: string, newText: string) => void | Promise<void>
}

export function MessageList({
  messages,
  status,
  directCharacter,
  onCopy,
  onRegenerate,
  onEditResend,
}: Props) {
  const lastIndex = messages.length - 1
  const sessionId = useChatStore((s) => s.activeSessionId)
  const platform = usePlatform()
  const isMobile = platform === "mobile"
  const tActions = useTranslations("mobile.messageActions")
  // Long-press opens the action sheet on mobile, but there's no hover hint to
  // advertise it. Surface a one-line nudge early in the conversation; it
  // self-retires once the thread grows past a couple of messages, so it never
  // becomes persistent chrome and needs no dismissal state.
  const showLongPressHint = isMobile && messages.length > 0 && messages.length <= 2
  const [actionMessage, setActionMessage] = useState<UIMessage | null>(null)
  const [isAtBottom, setIsAtBottom] = useState(true)
  const scrollParentRef = useRef<HTMLDivElement>(null)

  // `useCharacters()` (useLiveQuery) hands back a fresh array reference on
  // every Dexie write even when the character set is unchanged. Building the
  // map with a naive `useMemo([charactersList])` would therefore rebuild it on
  // unrelated writes and bust the `MessageRenderer` memo for EVERY row. The
  // stable hook only rebuilds when the id-set actually changes.
  const charactersList = useCharacters()
  const characterById = useStableCharacterById(charactersList)

  // Auto-play the latest assistant reply aloud when the turn finishes (gated on
  // ttsEnabled + ttsAutoPlay inside the hook).
  useChatAutoPlayTTS({ messages, status, characterById, directCharacter })

  // Toast on each new compaction boundary (gated on showCompressionNotification).
  useCompactionToast(messages)

  // Right-edge conversation-timeline minimap: long conversations only,
  // desktop only, and not disabled in settings.
  const timelineEnabled = useSettingsStore((s) => s.settings?.conversationTimeline?.enabled)
  // Stick-to-bottom auto-scroll while streaming. Defaults ON (`!== false`).
  const autoScrollOnStream = useSettingsStore(
    (s) => s.settings?.composerBehavior?.autoScrollOnStream
  )

  const lastAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") return messages[i].id
    }
    return null
  }, [messages])

  // Mobile per-message delete (long-press sheet). Three-way fan-out: the
  // in-memory store slice (what the list renders), the phone's Dexie mirror,
  // and the desktop's authoritative Dexie via the `message_delete` RPC. The
  // RPC leg is best-effort — sync-down reconciles a missed delete later.
  const handleDeleteMessage = useCallback(async (message: UIMessage) => {
    const store = useChatStore.getState()
    const metaSessionId = (message.metadata as { sessionId?: unknown } | undefined)?.sessionId
    const sid =
      typeof metaSessionId === "string" ? metaSessionId : (store.activeSessionId ?? undefined)
    if (!sid) return
    const slice = store.sessions[sid]
    const current = slice?.messages ?? (sid === store.activeSessionId ? store.messages : undefined)
    if (current) {
      store.setSessionMessages(
        sid,
        current.filter((m) => m.id !== message.id)
      )
    }
    try {
      await getDb().messages.delete(message.id)
    } catch {
      // Local mirror miss (e.g. not yet persisted) — the store removal above
      // already updated the visible list.
    }
    try {
      await deleteMessageOnDesktop(sid, message.id)
    } catch {
      // Desktop unreachable / standalone mode — best-effort by design.
    }
  }, [])

  const showThinking = shouldShowThinking(messages, status)
  const totalCount = messages.length + (showThinking ? 1 : 0)
  // Short lists skip virtualization entirely (see VIRTUALIZE_THRESHOLD). The
  // virtualizer hook + measure effects below stay unconditional (Rules of
  // Hooks); the flow branch simply never attaches its measureElement ref, so
  // no ResizeObservers spin up there.
  const virtualize = totalCount > VIRTUALIZE_THRESHOLD

  // The currently-streaming row, if any: the last message must be the
  // assistant message we're appending tokens to and the status must be
  // active streaming (not awaiting_approval — that's paused, so the row's
  // height is stable and the normal measure path is fine).
  const streamingRowIndex = useMemo(() => {
    if (status !== "streaming") return -1
    const idx = messages.length - 1
    if (idx < 0) return -1
    if (messages[idx]?.role !== "assistant") return -1
    return idx
  }, [messages, status])

  // TanStack Virtual's useVirtualizer returns non-memoizable functions; the
  // React Compiler correctly skips it. Nothing to fix on our side.
  // eslint-disable-next-line react-hooks/incompatible-library
  const rowVirtualizer = useVirtualizer({
    count: totalCount,
    getScrollElement: () => scrollParentRef.current,
    estimateSize: (index) => estimateRowSize(index, streamingRowIndex, messages),
    overscan: 5,
    // For every row except the actively-streaming one, we attach
    // measureElement (via the ref below). The streaming row gets no ref so
    // its height is driven by estimateSize, which grows monotonically with
    // text length. Without this skip, every token would trigger a
    // getBoundingClientRect on the streaming row → ResizeObserver pump →
    // virtualizer re-publish → jitter.
    // Round to whole pixels. Feeding fractional getBoundingClientRect heights
    // back into the virtualizer (which positions rows via transform) lets
    // sub-pixel deltas retrigger the ResizeObserver → re-measure → re-publish
    // loop, which spins the list even when nothing is happening.
    measureElement: (el) => Math.round(el?.getBoundingClientRect().height ?? 0),
  })

  // Re-measure every row when the streaming row finalises. Stage 4 will
  // also wrap the streaming→idle setStatus in startTransition so this
  // re-measure lands at transition priority.
  useEffect(() => {
    if (status === "idle") {
      rowVirtualizer.measure()
    }
  }, [status, rowVirtualizer])

  // Switching sessions invalidates every cached row height — left over
  // measurements from the prior session leave gaps / overlaps in the
  // virtual list. It also invalidates the scroll state: a freshly opened
  // conversation starts at its latest message, and carrying the previous
  // session's `isAtBottom=false` over would disarm stick-to-bottom for the
  // whole new thread (short lists never emit a scroll event to correct it).
  useEffect(() => {
    rowVirtualizer.measure()
    const raf = requestAnimationFrame(() => {
      const el = scrollParentRef.current
      if (el) el.scrollTop = el.scrollHeight
      setIsAtBottom(true)
    })
    return () => cancelAnimationFrame(raf)
  }, [sessionId, rowVirtualizer])

  const virtualItems = rowVirtualizer.getVirtualItems()
  const totalSize = rowVirtualizer.getTotalSize()

  // Stick-to-bottom: auto-scroll when streaming and user is at the bottom.
  // Gated by the composer-behavior toggle (defaults ON via `!== false`).
  useEffect(() => {
    if (autoScrollOnStream === false) return
    if ((status === "streaming" || status === "awaiting_approval") && isAtBottom) {
      const el = scrollParentRef.current
      if (el) el.scrollTop = el.scrollHeight
    }
  }, [messages, status, isAtBottom, autoScrollOnStream])

  const handleScroll = useCallback(() => {
    const el = scrollParentRef.current
    if (!el) return
    setIsAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 32)
  }, [])

  const scrollToBottom = useCallback(() => {
    const el = scrollParentRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" })
  }, [])

  // Re-pin to the bottom when the thinking indicator grows (skeleton / tips
  // reveal or tip rotation). The stick-to-bottom effect above only reacts to
  // `messages`/`status`, so it can't see this row's internal timer growth.
  const pinToBottom = useCallback(() => {
    if (autoScrollOnStream === false) return
    if (!isAtBottom) return
    const el = scrollParentRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [autoScrollOnStream, isAtBottom])

  // Shared row body for both the virtualized and the document-flow branch so
  // the MessageRenderer props (and the mobile LongPress wrapper) stay
  // identical regardless of which path renders the row.
  const renderRow = (m: UIMessage, isStreaming: boolean) =>
    isCompactBoundaryMessage(m) ? (
      <CompactBoundaryMarker message={m} />
    ) : isSessionNoticeMessage(m) ? (
      <SessionNoticeMarker message={m} />
    ) : isHookNoticeMessage(m) ? (
      <HookNoticeMarker message={m} />
    ) : isMobile ? (
      <LongPress
        onLongPress={() => {
          void selectionFeedback()
          setActionMessage(m)
        }}
      >
        <MessageRenderer
          message={m}
          characterById={characterById}
          directCharacter={directCharacter}
          isStreaming={isStreaming}
          isLastAssistant={m.id === lastAssistantId}
          onCopy={onCopy}
          onRegenerate={onRegenerate}
          onEditResend={onEditResend}
        />
      </LongPress>
    ) : (
      <MessageRenderer
        message={m}
        characterById={characterById}
        isStreaming={isStreaming}
        isLastAssistant={m.id === lastAssistantId}
        onCopy={onCopy}
        onRegenerate={onRegenerate}
        onEditResend={onEditResend}
      />
    )

  return (
    <PerfBoundary id="chat:list">
      <div className="relative flex flex-1 flex-col overflow-hidden">
        {showLongPressHint ? (
          <div
            className="flex items-center justify-center gap-1.5 px-4 py-1.5 text-[11px] text-muted-foreground"
            data-testid="long-press-hint"
          >
            <InfoIcon className="size-3 shrink-0" aria-hidden />
            <span>{tActions("longPressHint")}</span>
          </div>
        ) : null}
        <div className="relative flex flex-1 overflow-hidden">
          <div
            ref={scrollParentRef}
            className="relative flex-1 overflow-y-auto overscroll-contain"
            role="log"
            onScroll={handleScroll}
          >
            {virtualize ? (
              <div style={{ height: totalSize, position: "relative" }}>
                {virtualItems.map((virtualItem) => {
                  const isThinkingRow = virtualItem.index === messages.length
                  if (isThinkingRow) {
                    return (
                      <div
                        key="thinking"
                        data-index={virtualItem.index}
                        ref={rowVirtualizer.measureElement}
                        style={{
                          position: "absolute",
                          top: 0,
                          left: 0,
                          width: "100%",
                          transform: `translateY(${virtualItem.start}px)`,
                          padding: "0 1rem",
                        }}
                      >
                        <ChatThinkingIndicator
                          directCharacter={directCharacter}
                          onPhaseChange={pinToBottom}
                        />
                      </div>
                    )
                  }

                  const m = messages[virtualItem.index]!
                  const isStreaming =
                    virtualItem.index === lastIndex &&
                    m.role === "assistant" &&
                    (status === "streaming" || status === "awaiting_approval")
                  const isStreamingMeasureSkip = virtualItem.index === streamingRowIndex

                  return (
                    <div
                      key={m.id}
                      data-index={virtualItem.index}
                      ref={isStreamingMeasureSkip ? undefined : rowVirtualizer.measureElement}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        transform: `translateY(${virtualItem.start}px)`,
                        padding: "0 1rem",
                      }}
                    >
                      {renderRow(m, isStreaming)}
                    </div>
                  )
                })}
              </div>
            ) : (
              // Document-flow path for short lists: intrinsic heights, no
              // absolute positioning, no measureElement ref (zero ResizeObservers),
              // no remount-on-scroll.
              <div>
                {messages.map((m, index) => {
                  const isStreaming =
                    index === lastIndex &&
                    m.role === "assistant" &&
                    (status === "streaming" || status === "awaiting_approval")
                  return (
                    <div key={m.id} data-msg-id={m.id} style={{ padding: "0 1rem" }}>
                      {renderRow(m, isStreaming)}
                    </div>
                  )
                })}
                {showThinking && (
                  <div key="thinking" style={{ padding: "0 1rem" }}>
                    <ChatThinkingIndicator
                      directCharacter={directCharacter}
                      onPhaseChange={pinToBottom}
                    />
                  </div>
                )}
              </div>
            )}

            {!isAtBottom && (
              <Button
                className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full dark:bg-background dark:hover:bg-muted"
                onClick={scrollToBottom}
                size="icon"
                type="button"
                variant="outline"
              >
                <ArrowDownIcon className="size-4" />
              </Button>
            )}
          </div>
          {!isMobile && timelineEnabled !== false && messages.length > TIMELINE_THRESHOLD && (
            <ConversationTimeline
              messages={messages}
              scrollRef={scrollParentRef}
              virtualizer={rowVirtualizer}
              virtualize={virtualize}
            />
          )}
        </div>

        {isMobile ? (
          <MessageActionSheet
            message={actionMessage}
            // Same speaker resolution as message-renderer: team sender first,
            // then the session's 1:1 character — drives the Read-aloud voice.
            character={(() => {
              const senderId = (actionMessage as { metadata?: { senderId?: string } } | null)
                ?.metadata?.senderId
              return (senderId ? characterById?.get(senderId) : null) ?? directCharacter ?? null
            })()}
            onOpenChange={(next) => {
              if (!next) setActionMessage(null)
            }}
            // Regenerate only makes sense for the last assistant reply and
            // while no turn is in flight — mirrors the hover footer's gate in
            // message-renderer (which is unreachable on touch).
            onRegenerate={
              onRegenerate &&
              actionMessage &&
              actionMessage.id === lastAssistantId &&
              (status === "idle" || status === "error")
                ? onRegenerate
                : undefined
            }
            onDelete={status === "idle" || status === "error" ? handleDeleteMessage : undefined}
            // Touch path for the hover-only pencil: user's own messages,
            // no turn in flight (mirrors message-renderer's gate).
            onEditResend={
              onEditResend &&
              actionMessage?.role === "user" &&
              (status === "idle" || status === "error")
                ? (msg, newText) => onEditResend(msg.id, newText)
                : undefined
            }
          />
        ) : null}
      </div>
    </PerfBoundary>
  )
}

/**
 * Estimate a row's height for the TanStack virtualizer. Non-streaming rows
 * fall back to the default 200px until their ref-attached measureElement
 * runs; the streaming row uses a monotonically-growing projection so the
 * scroll position stays stable while tokens append (which is why we skip
 * the measureElement ref on that row — re-measuring per token causes a
 * jitter loop).
 *
 * Coefficient: 0.55px per character ≈ one line per 80 characters at the
 * chat column's typical mono+text mix. Adjust if the chat column width
 * changes materially.
 */
function estimateRowSize(index: number, streamingRowIndex: number, messages: UIMessage[]): number {
  if (index !== streamingRowIndex) return 200
  const m = messages[index]
  if (!m) return 200
  let textLen = 0
  for (const part of m.parts) {
    const p = part as { type?: string; text?: string }
    if (p.type === "text" && typeof p.text === "string") textLen += p.text.length
    else if (p.type === "reasoning" && typeof p.text === "string") textLen += p.text.length
  }
  // Monotonically non-decreasing: 200px floor + ~0.55px per char.
  return Math.max(220, 220 + textLen * 0.55)
}

/**
 * True when we should show the "Claude is thinking…" shimmer:
 * we're streaming AND the assistant hasn't produced any visible content yet.
 *
 * Intentionally excludes `awaiting_approval` since the approval dialog itself
 * is the user feedback for that state.
 */
function shouldShowThinking(
  messages: UIMessage[],
  status: "idle" | "streaming" | "awaiting_approval" | "error"
): boolean {
  if (status !== "streaming") return false
  if (messages.length === 0) return true
  const last = messages[messages.length - 1]
  if (last.role !== "assistant") return true
  // Any non-empty text or finished part means content is already visible.
  for (const part of last.parts) {
    const type = (part as { type?: string }).type
    if (!type) continue
    if (type === "text") {
      const text = (part as { text?: string }).text ?? ""
      if (text.trim().length > 0) return false
    } else if (type === "reasoning") {
      const text = (part as { text?: string }).text ?? ""
      if (text.trim().length > 0) return false
    } else if (typeof type === "string" && type.startsWith("tool-")) {
      // Tool blocks render their own visible affordance — no shimmer needed.
      return false
    } else if (type === "file") {
      return false
    }
  }
  return true
}
