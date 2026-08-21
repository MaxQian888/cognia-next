"use client"

import { ChatThinkingIndicator } from "@/components/chat/thinking-indicator"
import type { UIMessage } from "ai"
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
import { deleteStoredMessage } from "@/lib/db/messages"
import { useChatStore } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import { ConversationTimeline } from "./minimap/conversation-timeline"
import { shouldMountTimeline } from "./minimap/timeline-visibility"
import { ActiveTurnPublisher } from "./active-turn-publisher"
import { useChatViewportStore, type JumpToMessage } from "@/stores/chat/chat-viewport-store"
import { MessageSearchBar } from "./message-search-bar"
import type { MessageSearchHit } from "@/lib/chat/message-search"
import { findMessageAnchor } from "@/lib/chat/message-anchor"
import { FALLBACK_ROW_PX, estimateMessageHeight } from "@/lib/chat/row-height-estimate"
import {
  VIRTUALIZE_THRESHOLD,
  shouldVirtualize,
  transcriptTextLength,
} from "@/lib/chat/virtualization-threshold"
import { useJumpFlash } from "@/hooks/chat/use-jump-flash"
import { useJumpHistory } from "@/hooks/chat/use-jump-history"
import { JumpFlash } from "./jump-flash"
import { ConversationJumpPill, resolveJumpPillMode } from "./conversation-jump-pill"
import { MessageSelectionToolbar } from "./message-selection-toolbar"
import { useAppShortcut } from "@/hooks/shortcuts/use-app-shortcut"
import { usePlatform } from "@/hooks/use-platform"
import { useElementWidth } from "@/hooks/use-element-width"
import { useTranslations } from "next-intl"
import { InfoIcon } from "lucide-react"
import { toast } from "sonner"
import { useCharacters } from "@/lib/data-hooks/context"
import { useStableCharacterById } from "@/hooks/data/use-stable-character-by-id"
import { useChatAutoPlayTTS } from "@/hooks/media/use-chat-auto-play-tts"
import { useCompactionToast } from "@/hooks/chat/use-compaction-toast"
import { useMessageDisplay } from "@/hooks/chat/use-message-display"
import { useStickToBottom } from "@/hooks/chat/use-stick-to-bottom"
import { useIsomorphicLayoutEffect } from "@/hooks/use-isomorphic-layout-effect"
import { densitySurfaceProps } from "@/lib/appearance/density-applier"
import type { MessageDisplayPreferences } from "@/types/appearance"
import type { Character } from "@cognia/agent-config-types"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { cn } from "@/lib/utils"
import { useVirtualizer } from "@tanstack/react-virtual"
import { PerfBoundary } from "@/lib/perf"
import type { RewindFilesResult } from "@/lib/claude/ipc"

// Lists at or below this length render in normal document flow (no
// virtualization): the per-row ResizeObserver churn and the scroll-time
// remounting of heavy rows (markdown / Tool cards / mermaid) cost more than
// windowing saves when there are only a handful of messages. ~40 covers the
// overwhelming majority of sessions while keeping flow-render cost bounded;
// longer histories still take the virtualized path. ADR-0127 §3 adds a second,
// independent trigger — total part text > 256 KB — so a short session made of
// huge fences virtualizes too; both live in `lib/chat/virtualization-threshold`.
export { VIRTUALIZE_THRESHOLD }

// Below this many messages the conversation is short enough to scan by
// scrolling, so the right-edge timeline minimap stays unmounted. Mounting is
// also gated on the measured PANE width (see `shouldMountTimeline`) so a
// CSS-hidden timeline cannot retain thousands of off-screen nodes.
//
// 8 messages is ~4 user turns — the point where the first turn has usually
// scrolled out of view, so anchors start earning their keep. This was 20,
// which combined with the old `lg` breakpoint meant most users never saw the
// rail at all and had no way to learn it existed.
export const TIMELINE_THRESHOLD = 8

// How long after a jump the list stops reading scroll events as the user's own.
// Covers the smooth scroll plus the virtualizer's re-target passes, which are
// what make a jump emit scroll events for several frames after the call.
const PROGRAMMATIC_SCROLL_MS = 700

interface Props {
  messages: UIMessage[]
  status: "idle" | "streaming" | "awaiting_approval" | "error"
  /**
   * The session THIS pane is bound to — which in split view is not necessarily
   * the focused one. Only used to decide whether this instance owns the chat
   * keyboard shortcuts; everything else still keys off the active session.
   */
  paneSessionId?: string | null
  /** Session-bound character in a 1:1 chat — drives read-aloud / auto-play voice. */
  directCharacter?: Character | null
  onCopy?: () => void
  onRegenerate?: () => void | Promise<void>
  onEditResend?: (messageId: string, newText: string) => void | Promise<void>
  onRewindFiles?: (
    sessionId: string,
    checkpointId: string,
    dryRun: boolean
  ) => Promise<RewindFilesResult>
  /** Root used to resolve project-relative links inside rendered messages. */
  projectRoot?: string | null
  /** Per-session presentation preference; omitted sessions inherit global settings. */
  messageDisplayOverride?: MessageDisplayPreferences
}

export function MessageList({
  messages,
  status,
  paneSessionId,
  directCharacter,
  onCopy,
  onRegenerate,
  onEditResend,
  onRewindFiles,
  projectRoot,
  messageDisplayOverride,
}: Props) {
  const lastIndex = messages.length - 1
  const sessionId = useChatStore((s) => s.activeSessionId)
  // The conversation a selection here belongs to. Prefer the messages' own
  // session over the focused one so a split pane opens asides on ITS thread;
  // an aside cannot own an aside, so the toolbar stays out of one.
  const messageSessionId = (messages[0] as { metadata?: { sessionId?: string } } | undefined)
    ?.metadata?.sessionId
  const selectionSessionId = messageSessionId ?? sessionId
  const supportsSelectionAside =
    Boolean(selectionSessionId) && !selectionSessionId!.startsWith("resource-workbench:")

  // Split view mounts one MessageList per pane, and the shortcut runtime keys
  // its registry by id (last mount wins) — so without this gate the split pane
  // would silently swallow Ctrl+F and the anchor chords from the focused one.
  // It also keeps `when: chat.hasMessages` honest: that key is derived from the
  // ACTIVE projection, so only the active pane may rely on it.
  const ownsShortcuts = paneSessionId == null || paneSessionId === sessionId
  const platform = usePlatform()
  const isMobile = platform === "mobile"
  // Pane width, not viewport width: this list is hosted at 56% of the window in
  // the Inbox detail pane and at ~50% in split view, and the timeline is
  // positioned against the pane. See `timeline-visibility.ts`.
  const paneRef = useRef<HTMLDivElement | null>(null)
  const paneWidth = useElementWidth(paneRef)
  const tActions = useTranslations("mobile.messageActions")
  const tJump = useTranslations("chat.jump")
  // Long-press opens the action sheet on mobile, but there's no hover hint to
  // advertise it. Surface a one-line nudge early in the conversation; it
  // self-retires once the thread grows past a couple of messages, so it never
  // becomes persistent chrome and needs no dismissal state.
  const showLongPressHint = isMobile && messages.length > 0 && messages.length <= 2
  const [actionMessage, setActionMessage] = useState<UIMessage | null>(null)
  const messageDisplay = useMessageDisplay(messageDisplayOverride)
  // ADR-0127: the message list is the `chat` density surface (see
  // `densitySurfaceProps`); the reading column and row rhythm read the
  // `--density-*` tokens the surface resolves.
  const density = useSettingsStore((s) => s.settings?.density)
  const scrollParentRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

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

  // ADR-0138 — the single owner of this list's `scrollTop`. Every pin runs in
  // the layout phase (or from a ResizeObserver, which is already pre-paint), so
  // a growth and its scroll correction land in the same frame instead of the
  // browser painting the jump and the next frame undoing it.
  const {
    atBottom: isAtBottom,
    handleScroll: trackScrollPosition,
    pinNow,
    resetToBottom,
  } = useStickToBottom({
    scrollRef: scrollParentRef,
    contentRef,
    enabled: autoScrollOnStream !== false,
    active: status === "streaming" || status === "awaiting_approval",
    pinKey: messages,
  })

  const lastAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") return messages[i].id
    }
    return null
  }, [messages])

  // Signature-pinned array ref for the timeline minimap. `deriveTimelineTurns`
  // only reads user-message text/metadata and the message COUNT (replyCount),
  // none of which move on a streamed text delta — so pin the ref on
  // [length, last user message's metadata] and let the memo'd
  // `ConversationTimeline` skip every streaming frame instead of re-deriving
  // O(n) turns per frame. The metadata term catches the async `minimapLabel`
  // patch (which rewrites the last user message without changing the length).
  const lastUserMetadata = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        return (messages[i] as { metadata?: Record<string, unknown> }).metadata
      }
    }
    return undefined
  }, [messages])
  const timelineMessages = useMemo(
    () => messages,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- length + last-user metadata are the only inputs the timeline derive reads that can change
    [messages.length, lastUserMetadata]
  )

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
      await deleteStoredMessage(message.id)
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

  const thinking = thinkingMode(messages, status)
  const showThinking = thinking !== null
  const totalCount = messages.length + (showThinking ? 1 : 0)
  // Short, light lists skip virtualization entirely (count OR total-text
  // trigger — see `lib/chat/virtualization-threshold`). The virtualizer hook +
  // measure effects below stay unconditional (Rules of Hooks); the flow branch
  // simply never attaches its measureElement ref, so no ResizeObservers spin
  // up there. Text length is memoized on the array identity: mid-stream the
  // array is replaced once per coalesced frame, and the sum is O(parts).
  const textLength = useMemo(() => transcriptTextLength(messages), [messages])
  const virtualize = shouldVirtualize({ rowCount: totalCount, textLength })

  // ── The live tail (ADR-0138) ────────────────────────────────────────────
  // The row currently being streamed into. It is the one row whose height
  // changes many times per second, and windowing has nothing to offer it: it is
  // always on screen, and it is always last, so no row below it can shift.
  //
  // It used to sit inside the virtual list with `measureElement` deliberately
  // withheld (measuring per token pumps the observer), which meant its slot was
  // sized by a `220 + chars × 0.55` projection while the real text grew in
  // ~22px line steps. Everything downstream of `getTotalSize()` — including the
  // `scrollHeight` the auto-scroll pins against — therefore tracked a number
  // that was never the rendered height, and the gap under the caret breathed.
  //
  // So it leaves the virtual list entirely and renders in normal document flow
  // beneath it, together with the thinking indicator. Real height, real
  // `scrollHeight`, no projection. When the turn seals it rejoins the virtual
  // list: the row mounts carrying `measureElement`, which measures during the
  // same commit, and since it is the last row nothing below it can be pushed —
  // so the handoff needs no seeded measurement, only the re-pin below.
  const liveTailIndex =
    (status === "streaming" || status === "awaiting_approval") &&
    lastIndex >= 0 &&
    messages[lastIndex]?.role === "assistant"
      ? lastIndex
      : -1
  const hasLiveTail = liveTailIndex >= 0
  const liveTailMessage = hasLiveTail ? messages[liveTailIndex] : null
  /** Rows the virtualizer owns — everything except the live tail. */
  const virtualCount = messages.length - (hasLiveTail ? 1 : 0)
  // The tail region's rendered height. Read on demand (never on the render
  // path) by the minimap, whose geometry is normalised against the scroller's
  // full extent and would otherwise under-report by exactly this box.
  const liveTailRef = useRef<HTMLDivElement | null>(null)
  const getTailSize = useCallback(() => liveTailRef.current?.offsetHeight ?? 0, [])

  // TanStack Virtual's useVirtualizer returns non-memoizable functions; the
  // React Compiler correctly skips it. Nothing to fix on our side.
  // eslint-disable-next-line react-hooks/incompatible-library
  const rowVirtualizer = useVirtualizer({
    count: virtualCount,
    getScrollElement: () => scrollParentRef.current,
    estimateSize: (index) => estimateRowSize(index, messages),
    overscan: 5,
    // Round to whole pixels. Feeding fractional getBoundingClientRect heights
    // back into the virtualizer (which positions rows via transform) lets
    // sub-pixel deltas retrigger the ResizeObserver → re-measure → re-publish
    // loop, which spins the list even when nothing is happening.
    measureElement: (el) => Math.round(el?.getBoundingClientRect().height ?? 0),
  })

  // Hand the live tail back to the virtual list when the turn seals.
  //
  // No blanket `rowVirtualizer.measure()` here any more: that threw away every
  // row's measurement to fix one row's projection, and the live tail no longer
  // HAS a projection — it rejoins carrying `measureElement`, which measures it
  // during this very commit. All that is left to do is re-pin, in the layout
  // phase, so a reader parked at the foot never sees the total size settle.
  useIsomorphicLayoutEffect(() => {
    if (hasLiveTail) return
    pinNow()
  }, [hasLiveTail, pinNow])

  // Switching sessions invalidates every cached row height — left over
  // measurements from the prior session leave gaps / overlaps in the
  // virtual list. It also invalidates the scroll state: a freshly opened
  // conversation starts at its latest message, and carrying the previous
  // session's `atBottom=false` over would disarm stick-to-bottom for the
  // whole new thread (short lists never emit a scroll event to correct it).
  useIsomorphicLayoutEffect(() => {
    rowVirtualizer.measure()
    resetToBottom()
  }, [sessionId, rowVirtualizer, resetToBottom])

  // Layout and disclosure changes can alter every row's geometry at once.
  // Drop cached measurements without moving a reader who is inspecting older
  // content; the existing resize-follow logic only re-pins when already at the
  // bottom.
  useEffect(() => {
    rowVirtualizer.measure()
  }, [messageDisplay, rowVirtualizer])

  const virtualItems = rowVirtualizer.getVirtualItems()
  const totalSize = rowVirtualizer.getTotalSize()

  // ── The one floating offer at the foot of the pane ──────────────────────
  const {
    canReturn,
    remember: rememberReturn,
    takeReturn,
    forget: forgetReturn,
  } = useJumpHistory(sessionId)
  // A jump's own scrolling is indistinguishable from the user's at the event
  // level, so it is fenced off by time instead. Overshooting the settle just
  // keeps the offer a moment longer than needed; undershooting drops it, which
  // is the safe direction (the offer disappears, nothing goes wrong).
  const programmaticScrollUntilRef = useRef(0)

  const handleScroll = useCallback(() => {
    trackScrollPosition()
    // Scrolling by hand IS choosing a new place to be, which retires the offer
    // to go back to the old one. Guarded inside the hook so this costs no
    // re-render on the frames where nothing is on offer.
    if (Date.now() < programmaticScrollUntilRef.current) return
    forgetReturn()
  }, [forgetReturn, trackScrollPosition])

  // New replies that landed while the user was reading further up. Reset the
  // moment they return to the bottom — they have seen them.
  const [newSinceScrollUp, setNewSinceScrollUp] = useState(0)
  const unreadBaselineRef = useRef<number | null>(null)
  useEffect(() => {
    if (isAtBottom) {
      unreadBaselineRef.current = null
      setNewSinceScrollUp((prev) => (prev === 0 ? prev : 0))
      return
    }
    if (unreadBaselineRef.current == null) {
      unreadBaselineRef.current = messages.length
      return
    }
    const next = Math.max(0, messages.length - unreadBaselineRef.current)
    setNewSinceScrollUp((prev) => (prev === next ? prev : next))
  }, [isAtBottom, messages.length])

  const scrollToBottom = useCallback(() => {
    const el = scrollParentRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" })
  }, [])

  const returnToPreviousPosition = useCallback(() => {
    const offset = takeReturn()
    if (offset == null) return
    scrollParentRef.current?.scrollTo({ top: offset, behavior: "smooth" })
  }, [takeReturn])

  // One-shot "you landed here" mark. Distinct from the find bar's `activeHitId`
  // ring, which persists until the user steps to the next match — both can be
  // on the same row.
  const { flashId, flashNonce, holdMs: flashHoldMs, flash } = useJumpFlash()

  // ── Jump to a message ───────────────────────────────────────────────────
  // The list owns this because jumping needs the scroll container and the
  // virtualizer. It had been written twice — once here for the find bar, once
  // in the timeline minimap — and exposed nowhere, so "go to the message that
  // produced this artifact" had nothing to call. One implementation now, and
  // it is published on `chatViewportStore` for surfaces outside the list.
  //
  // No landing-position correction loop here on purpose: `virtual-core`
  // (3.17.6, pulled in by react-virtual 3.14.8) already runs its own
  // `scheduleScrollReconcile` rAF loop that re-targets every frame until the
  // offset is stable. A second corrector would read the library's in-flight
  // scroll as drift and fight it.
  const jumpToMessage = useCallback<JumpToMessage>(
    (messageId, index, opts) => {
      const align = opts?.align ?? "center"
      const resolvedIndex = index ?? messages.findIndex((message) => message.id === messageId)
      const from = scrollParentRef.current?.scrollTop ?? 0

      // Everything the jump then does emits scroll events. `handleScroll` reads
      // those as the user choosing a new place and drops the return offer we
      // are about to make, so suppress that for the settle window.
      const arriveFrom = () => {
        programmaticScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_MS
        rememberReturn(from)
        flash(messageId)
      }

      // `resolvedIndex < virtualCount` matters: the live tail is a real DOM row
      // BELOW the virtual container, not row `virtualCount` inside it, so
      // asking the virtualizer to scroll to it would land on empty space. It
      // carries `data-msg-id` like every other row, so the anchor path below
      // handles it — and a search hit on the streaming reply is exactly the
      // case that reaches here.
      if (virtualize && resolvedIndex >= 0 && resolvedIndex < virtualCount) {
        arriveFrom()
        rowVirtualizer.scrollToIndex(resolvedIndex, { align })
        return true
      }
      // Document-flow lists, the live tail, and the virtualized case where the
      // id resolved to no row at all (compacted away / another session's).
      const node = findMessageAnchor(scrollParentRef.current, messageId)
      if (!node) return false
      arriveFrom()
      node.scrollIntoView({ behavior: "smooth", block: align })
      return true
    },
    [messages, virtualize, virtualCount, rowVirtualizer, flash, rememberReturn]
  )

  // Only the primary list publishes: the dock hosts its own per-resource chat
  // pane, and letting that register would point every jump at the wrong list.
  const registerJumpToMessage = useChatViewportStore((s) => s.registerJumpToMessage)
  useEffect(() => {
    if (!ownsShortcuts) return
    registerJumpToMessage(jumpToMessage)
    return () => registerJumpToMessage(null)
  }, [jumpToMessage, ownsShortcuts, registerJumpToMessage])

  // ── Find-in-conversation ────────────────────────────────────────────────
  const [searchOpen, setSearchOpen] = useState(false)
  const [activeHitId, setActiveHitId] = useState<string | null>(null)

  // A search hit is a point of interest, not a reading start — centre it.
  // A hit comes from the rendered set so it normally resolves, but the index
  // can go stale between the search and the click (a streaming turn, a
  // compaction) — and the store's contract is that callers surface `false`.
  const jumpToHit = useCallback(
    (hit: MessageSearchHit) => {
      const landed = jumpToMessage(hit.id, hit.index, { align: "center" })
      if (!landed) toast.error(tJump("notFound"))
      return landed
    },
    [jumpToMessage, tJump]
  )

  const closeSearch = useCallback(() => {
    setSearchOpen(false)
    setActiveHitId(null)
  }, [])

  // Toggle rather than re-open: pressing the chord while the bar is up should
  // dismiss it, matching every other find bar.
  useAppShortcut("chat.search.toggle", () => setSearchOpen((v) => !v), {
    enabled: ownsShortcuts,
    preventDefault: true,
    allowInEditable: true,
    editorSelectors: [".monaco-editor"],
  })

  // An unfocused pane must not keep a find bar open behind the user's back.
  useEffect(() => {
    if (!ownsShortcuts) {
      setSearchOpen(false)
      setActiveHitId(null)
    }
  }, [ownsShortcuts])

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
          onRewindFiles={onRewindFiles}
          projectRoot={projectRoot}
          messageDisplay={messageDisplay}
        />
      </LongPress>
    ) : (
      <MessageRenderer
        message={m}
        characterById={characterById}
        directCharacter={directCharacter}
        isStreaming={isStreaming}
        isLastAssistant={m.id === lastAssistantId}
        onCopy={onCopy}
        onRegenerate={onRegenerate}
        onEditResend={onEditResend}
        onRewindFiles={onRewindFiles}
        projectRoot={projectRoot}
        messageDisplay={messageDisplay}
      />
    )

  return (
    <PerfBoundary id="chat:list">
      {/* `@container/message-list` scopes the timeline's CSS gate to this pane.
          Safe as a container: the box is already `position: relative`, its
          inline size comes from the parent's stretch rather than its content,
          and every overlay inside it portals to `body`. */}
      <div
        ref={paneRef}
        className="@container/message-list relative flex flex-1 flex-col overflow-hidden"
        {...densitySurfaceProps("chat", density)}
      >
        {searchOpen ? (
          <div data-computer-use-pip-obstacle>
            <MessageSearchBar
              messages={messages}
              onJump={jumpToHit}
              onActiveHitChange={setActiveHitId}
              onClose={closeSearch}
            />
          </div>
        ) : null}
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
          {/* The message lane. The timeline rail is a sibling of THIS, not of
              the scroller, so the jump pill centres over the reading column
              rather than over the column plus a 256px expanded panel. */}
          <div className="relative flex min-w-0 flex-1">
            <div
              ref={scrollParentRef}
              className="relative flex-1 overflow-y-auto overscroll-contain"
              role="log"
              onScroll={handleScroll}
            >
              <div
                ref={contentRef}
                className="mx-auto w-full max-w-[52rem] py-[calc(1.25rem*var(--density-spacing,1))] sm:py-[calc(1.75rem*var(--density-spacing,1))]"
                data-slot="conversation-reading-column"
              >
                {virtualize ? (
                  <div style={{ height: totalSize, position: "relative" }}>
                    {virtualItems.map((virtualItem) => {
                      const m = messages[virtualItem.index]!
                      return (
                        <div
                          key={m.id}
                          data-index={virtualItem.index}
                          // Same anchor attribute the document-flow branch emits.
                          // Without it, every DOM-path jump (and the timeline's
                          // own fallback) silently resolved to nothing as soon as
                          // the list crossed VIRTUALIZE_THRESHOLD.
                          data-msg-id={m.id}
                          data-search-hit={m.id === activeHitId ? "" : undefined}
                          ref={rowVirtualizer.measureElement}
                          className={cn(
                            "px-3 sm:px-5",
                            m.id === activeHitId &&
                              "rounded-md ring-2 ring-primary/60 ring-offset-2 ring-offset-background"
                          )}
                          style={{
                            position: "absolute",
                            top: 0,
                            left: 0,
                            width: "100%",
                            transform: `translateY(${virtualItem.start}px)`,
                          }}
                        >
                          {m.id === flashId && (
                            <JumpFlash nonce={flashNonce} holdMs={flashHoldMs} />
                          )}
                          {renderRow(m, false)}
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
                      // The live tail is already in document flow here, so this
                      // branch renders it in place; only the virtualized branch
                      // lifts it into the tail region below.
                      return (
                        <div
                          key={m.id}
                          data-msg-id={m.id}
                          data-search-hit={m.id === activeHitId ? "" : undefined}
                          className={cn(
                            // `relative` so the landing mark can overlay this row.
                            // The virtualized branch is already a containing block
                            // via its inline `position: absolute`.
                            "relative px-3 sm:px-5",
                            m.id === activeHitId &&
                              "rounded-md ring-2 ring-primary/60 ring-offset-2 ring-offset-background"
                          )}
                        >
                          {m.id === flashId && (
                            <JumpFlash nonce={flashNonce} holdMs={flashHoldMs} />
                          )}
                          {renderRow(m, index === liveTailIndex)}
                        </div>
                      )
                    })}
                  </div>
                )}
                {/* ── The live tail (ADR-0138) ──────────────────────────────
                    Real document flow, always: the row being streamed into
                    (virtualized lists only — in flow mode it is already above)
                    plus the thinking indicator. One place owns the foot of the
                    transcript in both modes, and neither element is ever sized
                    by a projection. */}
                <div ref={liveTailRef} data-slot="conversation-live-tail">
                  {virtualize && liveTailMessage ? (
                    <div
                      key={liveTailMessage.id}
                      data-msg-id={liveTailMessage.id}
                      data-search-hit={liveTailMessage.id === activeHitId ? "" : undefined}
                      className={cn(
                        "relative px-3 sm:px-5",
                        liveTailMessage.id === activeHitId &&
                          "rounded-md ring-2 ring-primary/60 ring-offset-2 ring-offset-background"
                      )}
                    >
                      {liveTailMessage.id === flashId && (
                        <JumpFlash nonce={flashNonce} holdMs={flashHoldMs} />
                      )}
                      {renderRow(liveTailMessage, true)}
                    </div>
                  ) : null}
                  {showThinking ? (
                    <div className="px-3 sm:px-5">
                      <ChatThinkingIndicator
                        directCharacter={directCharacter}
                        compact={thinking === "compact"}
                      />
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
            {/* Selecting text in the transcript and asking about THAT. Scoped
                to `contentRef` so a selection that runs into the composer or
                the timeline rail is not treated as a question about a message.
                Self-hides with no selection. */}
            {supportsSelectionAside && (
              <MessageSelectionToolbar sessionId={selectionSessionId!} containerRef={contentRef} />
            )}
            {/* Outside the scroller on purpose — see ConversationJumpPill. */}
            <ConversationJumpPill
              mode={resolveJumpPillMode({
                atBottom: isAtBottom,
                canReturn,
                newMessageCount: newSinceScrollUp,
              })}
              newMessageCount={newSinceScrollUp}
              onReturn={returnToPreviousPosition}
              onToBottom={scrollToBottom}
            />
          </div>
          {/* Renders nothing — it exists to absorb the per-frame scroll sync
              and publish only the turn changes. Unconditional (unlike the
              minimap): the artifact dock's tab highlight is not a desktop-only
              or long-conversation-only feature. */}
          {ownsShortcuts && (
            <ActiveTurnPublisher
              messages={timelineMessages}
              scrollRef={scrollParentRef}
              virtualizer={rowVirtualizer}
              virtualize={virtualize}
              getTailSize={getTailSize}
            />
          )}
          {shouldMountTimeline({
            paneWidth,
            isMobile,
            enabled: timelineEnabled,
            messageCount: messages.length,
            threshold: TIMELINE_THRESHOLD,
          }) && (
            <ConversationTimeline
              messages={timelineMessages}
              scrollRef={scrollParentRef}
              virtualizer={rowVirtualizer}
              virtualize={virtualize}
              getTailSize={getTailSize}
              shortcutsEnabled={ownsShortcuts}
            />
          )}
        </div>

        {isMobile ? (
          <MessageActionSheet
            message={actionMessage}
            messageMotion={messageDisplay.motion}
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
 * Estimate a row's height for the TanStack virtualizer.
 *
 * Rows are estimated from their content (`estimateMessageHeight`, memoized per
 * parts array) until their ref-attached measureElement runs. They used to take
 * a flat 200px, which is roughly right for prose and badly wrong for anything
 * carrying images, diagrams or a long fence — the shortfall shows up as the
 * scroll position lurching as each row scrolls in and corrects itself.
 *
 * Every virtual row is now a SETTLED message: the row being streamed into left
 * the virtual list for the live-tail region (ADR-0138), which is what let the
 * old `220 + chars × 0.55` monotonic projection — and the measure skip it
 * existed to compensate for — be deleted outright.
 */
function estimateRowSize(index: number, messages: UIMessage[]): number {
  const m = messages[index]
  if (!m) return FALLBACK_ROW_PX
  return estimateMessageHeight(m)
}

/**
 * How to render the thinking indicator for the current turn, or `null` to hide
 * it. We show it for the WHOLE streaming turn — an agentic turn is mostly tool
 * calls, and going static the moment the first tool block lands left minutes of
 * a live run with no sign of life (the run bar's timer is a thin, easily-missed
 * strip). Claude Code keeps its spinner up for the entire turn; so do we.
 *
 *   "full"     nothing visible from the assistant yet → pulse + label + dots,
 *              then the skeleton placeholder and tips as the wait grows.
 *   "compact"  content is already on screen (text / tool block / file) and the
 *              turn is still running → same live label, no skeleton.
 *
 * Intentionally excludes `awaiting_approval` since the approval dialog itself
 * is the user feedback for that state.
 */
export function thinkingMode(
  messages: UIMessage[],
  status: "idle" | "streaming" | "awaiting_approval" | "error"
): "full" | "compact" | null {
  if (status !== "streaming") return null
  if (messages.length === 0) return "full"
  const last = messages[messages.length - 1]
  if (last.role !== "assistant") return "full"
  // Any non-empty text or finished part means content is already visible.
  for (const part of last.parts) {
    const type = (part as { type?: string }).type
    if (!type) continue
    if (type === "text") {
      const text = (part as { text?: string }).text ?? ""
      if (text.trim().length > 0) return "compact"
    } else if (type === "reasoning") {
      const text = (part as { text?: string }).text ?? ""
      if (text.trim().length > 0) return "compact"
    } else if (typeof type === "string" && type.startsWith("tool-")) {
      return "compact"
    } else if (type === "file") {
      return "compact"
    }
  }
  return "full"
}
