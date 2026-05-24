"use client"

import { useTranslations } from "next-intl"
import { messagesToMarkdown } from "@/components/ai-elements/conversation"
import { Shimmer } from "@/components/ai-elements/shimmer"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import type { UIMessage } from "ai"
import { ArrowDownIcon, DownloadIcon, Trash2Icon } from "lucide-react"
import { MessageRenderer } from "./message-renderer"
import { LongPress } from "@/components/interactions/long-press"
import { MessageActionSheet } from "@/components/mobile/chat/message-action-sheet"
import { useChatStore } from "@/stores/chat"
import { usePlatform } from "@/hooks/use-platform"
import { useCharacters, useClearMessages } from "@/lib/data-hooks/context"
import { useStableCharacterById } from "@/hooks/data/use-stable-character-by-id"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { toast } from "sonner"
import { downloadBlob } from "@/lib/files/download"
import { loggers } from "@/lib/logging"
import { PerfBoundary } from "@/lib/perf"

interface Props {
  messages: UIMessage[]
  status: "idle" | "streaming" | "awaiting_approval" | "error"
  onCopy?: () => void
  onRegenerate?: () => void | Promise<void>
  onEditResend?: (messageId: string, newText: string) => void | Promise<void>
}

export function MessageList({ messages, status, onCopy, onRegenerate, onEditResend }: Props) {
  const t = useTranslations("chat.list")
  const lastIndex = messages.length - 1
  const sessionId = useChatStore((s) => s.activeSessionId)
  const clearMessages = useClearMessages()
  const platform = usePlatform()
  const isMobile = platform === "mobile"
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

  const handleExport = useCallback(() => {
    if (messages.length === 0) {
      toast.info(t("nothingToExport"))
      return
    }
    const md = messagesToMarkdown(messages)
    const blob = new Blob([md], { type: "text/markdown" })
    const ts = new Date().toISOString().replaceAll(/[:.]/g, "-")
    downloadBlob(blob, `cognia-chat-${ts}.md`)
    toast.success(t("exported"))
  }, [messages, t])

  const handleClear = useCallback(async () => {
    if (!sessionId) return
    try {
      await clearMessages(sessionId)
      useChatStore.getState().replaceMessages([])
      toast.success(t("cleared"))
    } catch (err) {
      loggers.chat.error("clear messages failed", err, { sessionId })
      toast.error(err instanceof Error ? err.message : t("cleared"))
    }
  }, [sessionId, t, clearMessages])

  const lastAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") return messages[i].id
    }
    return null
  }, [messages])

  const showThinking = shouldShowThinking(messages, status)
  const totalCount = messages.length + (showThinking ? 1 : 0)

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
  // virtual list.
  useEffect(() => {
    rowVirtualizer.measure()
  }, [sessionId, rowVirtualizer])

  const virtualItems = rowVirtualizer.getVirtualItems()
  const totalSize = rowVirtualizer.getTotalSize()

  // Stick-to-bottom: auto-scroll when streaming and user is at the bottom.
  useEffect(() => {
    if ((status === "streaming" || status === "awaiting_approval") && isAtBottom) {
      const el = scrollParentRef.current
      if (el) el.scrollTop = el.scrollHeight
    }
  }, [messages, status, isAtBottom])

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

  return (
    <PerfBoundary id="chat:list">
      <div className="relative flex flex-1 flex-col overflow-hidden">
        {messages.length > 0 && (
          <div className="flex items-center justify-end gap-1 border-b bg-background/40 px-3 py-1.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleExport}
              className="h-7 gap-1.5 text-xs"
            >
              <DownloadIcon className="size-3.5" />
              {t("export")}
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1.5 text-xs text-destructive hover:text-destructive"
                >
                  <Trash2Icon className="size-3.5" />
                  {t("clear")}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t("clearTitle")}</AlertDialogTitle>
                  <AlertDialogDescription>{t("clearDescription")}</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t("clearCancel")}</AlertDialogCancel>
                  <AlertDialogAction onClick={() => void handleClear()}>
                    {t("clearAction")}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        )}

        <div
          ref={scrollParentRef}
          className="relative flex-1 overflow-y-auto"
          role="log"
          onScroll={handleScroll}
        >
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
                    <Shimmer as="p" className="px-1 py-2 text-sm">
                      {t("thinking")}
                    </Shimmer>
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
                  {isMobile ? (
                    <LongPress onLongPress={() => setActionMessage(m)}>
                      <MessageRenderer
                        message={m}
                        characterById={characterById}
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
                  )}
                </div>
              )
            })}
          </div>

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

        {isMobile ? (
          <MessageActionSheet
            message={actionMessage}
            onOpenChange={(next) => {
              if (!next) setActionMessage(null)
            }}
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
