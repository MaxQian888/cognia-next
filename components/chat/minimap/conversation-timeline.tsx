"use client"

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { UIMessage } from "ai"
import { useVirtualizer, type Virtualizer } from "@tanstack/react-virtual"
import { useTranslations } from "next-intl"
import { BookmarkIcon, ChevronLeftIcon, ChevronRightIcon, ListTreeIcon } from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useSettingsStore } from "@/stores/settings"
import { useChatStore } from "@/stores/chat"
import { useChatViewportStore } from "@/stores/chat/chat-viewport-store"
import { useAppShortcut } from "@/hooks/shortcuts/use-app-shortcut"
import { findMessageAnchor } from "@/lib/chat/message-anchor"
import { useTimelineTurns, type TimelineTurn } from "./use-timeline-turns"
import { useTimelineScrollSync } from "./use-timeline-scroll-sync"
import { formatTurnTime } from "./format-turn-time"
import { dateHeaderAtOrBefore, turnDateHeaders } from "./timeline-date-groups"
import { buildTimelineMarkers } from "./timeline-markers"
import { MotionReveal } from "@/components/chat/motion/motion-reveal"

interface Props {
  messages: UIMessage[]
  scrollRef: React.RefObject<HTMLDivElement | null>
  virtualizer: Virtualizer<HTMLDivElement, Element>
  virtualize: boolean
  /**
   * Whether this instance owns the anchor chords. False for a split view's
   * unfocused pane — shortcut ids are global and the runtime keeps only the
   * last registration per id, so two timelines would fight over them.
   */
  shortcutsEnabled?: boolean
}

/** Half the scrub card's height, in px — used to clamp it inside the rail. */
const SCRUB_CARD_HALF = 22
const MAX_COLLAPSED_MARKERS = 128
const EXPANDED_VIRTUALIZE_THRESHOLD = 40
const EXPANDED_ROW_ESTIMATE = 48

/**
 * Pick the turn whose rail position is nearest the pointer fraction `frac`
 * (both in `[0,1]`). Uses the measured `positions` when they cover every turn;
 * before the scroll-sync hook has measured (or in a DOM-less test) it falls
 * back to an even distribution by turn index so scrubbing still resolves a turn.
 */
export function nearestTurnIndex(frac: number, positions: number[], count: number): number {
  if (count <= 0) return -1
  const f = !Number.isFinite(frac) ? 0 : frac < 0 ? 0 : frac > 1 ? 1 : frac
  if (positions.length === count) {
    let low = 0
    let high = count - 1
    while (low < high) {
      const middle = Math.floor((low + high) / 2)
      if ((positions[middle] ?? 0) < f) low = middle + 1
      else high = middle
    }
    const right = low
    const left = Math.max(0, right - 1)
    return Math.abs((positions[left] ?? 0) - f) <= Math.abs((positions[right] ?? 0) - f)
      ? left
      : right
  }
  return count === 1 ? 0 : Math.round(f * (count - 1))
}

interface ScrubState {
  index: number
  /** Clamped pointer offset from the rail top, in px. */
  y: number
}

/**
 * Scroll offset for a thumb dragged so its TOP sits `thumbTop` px down the
 * rail. The rail maps `[0, railHeight]` onto `[0, totalSize]` — the same
 * mapping `useTimelineScrollSync` uses to place the thumb — so dragging is
 * exactly the inverse of rendering and the thumb tracks the pointer 1:1.
 *
 * `maxScrollTop` clamps the result: the last viewport-height of content cannot
 * be scrolled past, so without it the bottom of the rail would map to an
 * offset the container silently refuses, and the thumb would stick.
 */
export function scrollTopForThumb(params: {
  thumbTop: number
  railHeight: number
  totalSize: number
  maxScrollTop: number
}): number {
  const { thumbTop, railHeight, totalSize, maxScrollTop } = params
  if (railHeight <= 0 || totalSize <= 0) return 0
  const fraction = thumbTop / railHeight
  const clampedFraction = fraction < 0 ? 0 : fraction > 1 ? 1 : fraction
  const target = clampedFraction * totalSize
  const ceiling = maxScrollTop < 0 ? 0 : maxScrollTop
  return target > ceiling ? ceiling : target
}

/**
 * Right-edge, timeline-style conversation minimap. Collapsed it's a thin rail
 * with proportional turn markers and a viewport slider; hovering the rail body
 * shows a lightweight scrub card (time + summary of the nearest user input) and
 * clicking jumps to it — so users can locate their own inputs in a long
 * conversation by time without opening the full panel. A top grip button opens
 * the expanded sidebar (vertical timeline of user turns with previews and
 * click-to-jump). Desktop / wide-screen only (`lg`); mounting + threshold
 * gating live in the parent. Memoised + self-contained scroll sync so it
 * doesn't re-render the message list.
 */
export const ConversationTimeline = memo(function ConversationTimeline({
  messages,
  scrollRef,
  virtualizer,
  virtualize,
  shortcutsEnabled = true,
}: Props) {
  const t = useTranslations("chat.timeline")
  const tJump = useTranslations("chat.jump")
  const allTurns = useTimelineTurns(messages)

  // Bookmarks are starred per message from the message action bar; the rail
  // reuses that set rather than keeping its own.
  const bookmarkedIds = useChatStore((s) => s.bookmarkedIds)
  const bookmarkedSet = useMemo(() => new Set(bookmarkedIds), [bookmarkedIds])
  // A turn is bookmarked when any message in it is — starring an assistant
  // reply must light up the turn it belongs to, not vanish.
  const isTurnBookmarked = useCallback(
    (turn: TimelineTurn) => turn.messageIds.some((id) => bookmarkedSet.has(id)),
    [bookmarkedSet]
  )
  /**
   * The starred message inside a turn, when it is not the user's question.
   *
   * Starring an assistant reply is how you mark an *answer* worth returning to,
   * but the panel only ever showed — and only ever jumped to — the question that
   * opened the turn, so the one thing you bookmarked was the one thing the
   * bookmark could not take you to.
   */
  const starredReplyId = useCallback(
    (turn: TimelineTurn) =>
      turn.messageIds.find((id) => id !== turn.id && bookmarkedSet.has(id)) ?? null,
    [bookmarkedSet]
  )
  const [onlyBookmarked, setOnlyBookmarked] = useState(false)
  const turns = useMemo(
    () => (onlyBookmarked ? allTurns.filter(isTurnBookmarked) : allTurns),
    [onlyBookmarked, allTurns, isTurnBookmarked]
  )

  const geom = useTimelineScrollSync({ scrollRef, virtualizer, virtualize, turns })
  const bookmarkedIndices = useMemo(() => {
    const indices = new Set<number>()
    for (let index = 0; index < turns.length; index++) {
      const turn = turns[index]
      if (turn && isTurnBookmarked(turn)) indices.add(index)
    }
    return indices
  }, [turns, isTurnBookmarked])
  const railMarkers = useMemo(
    () =>
      buildTimelineMarkers({
        count: turns.length,
        positions: geom.positions,
        activeIndex: geom.activeIndex,
        bookmarkedIndices,
        maxMarkers: MAX_COLLAPSED_MARKERS,
      }),
    [turns.length, geom.positions, geom.activeIndex, bookmarkedIndices]
  )

  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const expanded = settings?.conversationTimeline?.expanded ?? false
  const [scrub, setScrub] = useState<ScrubState | null>(null)
  const expandedScrollRef = useRef<HTMLDivElement>(null)
  const virtualizeExpanded = expanded && turns.length > EXPANDED_VIRTUALIZE_THRESHOLD
  const expandedVirtualizer = useVirtualizer({
    count: virtualizeExpanded ? turns.length : 0,
    getScrollElement: () => expandedScrollRef.current,
    estimateSize: () => EXPANDED_ROW_ESTIMATE,
    getItemKey: (index) => turns[index]?.id ?? index,
    overscan: 5,
    initialRect: { width: 256, height: 600 },
  })
  const measuredExpandedItems = expandedVirtualizer.getVirtualItems()
  // The scroll element does not exist during SSR/the first client render. Keep
  // that initial frame useful and bounded; the virtualizer replaces this small
  // window as soon as it observes the real panel.
  const expandedItems =
    virtualizeExpanded && measuredExpandedItems.length === 0
      ? Array.from({ length: Math.min(20, turns.length) }, (_, index) => ({
          key: turns[index]?.id ?? index,
          index,
          start: index * EXPANDED_ROW_ESTIMATE,
        }))
      : measuredExpandedItems

  const yesterdayLabel = t("yesterday")
  const todayLabel = t("today")

  // Sparse: only the turns that OPEN a calendar day. A hundred rows of bare
  // clock times give no sense of when anything happened in a conversation
  // resumed across days.
  const dateHeaders = useMemo(
    () => turnDateHeaders(turns, { todayLabel, yesterdayLabel }),
    [turns, todayLabel, yesterdayLabel]
  )

  // The day of the topmost visible row, pinned above the virtualized list —
  // see the header markup below for why the inline ones cannot stick there.
  const topVisibleIndex = expandedItems[0]?.index
  const pinnedDateHeader =
    virtualizeExpanded && topVisibleIndex != null
      ? dateHeaderAtOrBefore(dateHeaders, topVisibleIndex)
      : null

  // Opening the panel on turn 1 of 200 is useless — the one thing you know is
  // where you currently are, and that is what the panel should show you. Runs
  // on open (and on a re-open) rather than continuously, so it never fights the
  // user scrolling the panel by hand.
  // Mirrored into refs so the effect can depend on `expanded` ALONE. Listing
  // the virtualizer or the active index as deps would re-run the scroll on
  // every scroll frame, yanking the panel back while the user reads it.
  const activeIndexRef = useRef(geom.activeIndex)
  activeIndexRef.current = geom.activeIndex
  const expandedVirtualizerRef = useRef(expandedVirtualizer)
  expandedVirtualizerRef.current = expandedVirtualizer
  const virtualizeExpandedRef = useRef(virtualizeExpanded)
  virtualizeExpandedRef.current = virtualizeExpanded
  const centredOnOpenRef = useRef(false)
  useEffect(() => {
    if (!expanded) {
      centredOnOpenRef.current = false
      return
    }
    // Once per opening. `geom.activeIndex` is a dep only so that a panel
    // mounted already-open gets a second chance: the scroll geometry is
    // measured in a rAF, so on that first frame there is no active turn yet.
    // The ref is what keeps this from re-firing on every later scroll.
    if (centredOnOpenRef.current) return
    const index = activeIndexRef.current
    if (index < 0) return
    centredOnOpenRef.current = true
    if (virtualizeExpandedRef.current) {
      expandedVirtualizerRef.current?.scrollToIndex(index, { align: "center" })
      return
    }
    // Short panels render in document flow, where the virtualizer has no rows.
    expandedScrollRef.current
      ?.querySelector<HTMLElement>(`[data-turn-index="${index}"]`)
      ?.scrollIntoView({ block: "center" })
  }, [expanded, geom.activeIndex])

  const setPinned = useCallback(
    (next: boolean) => {
      // The filter toggle only exists in the expanded panel, so a filter left on
      // while collapsing would strand the user at an empty rail with no way to
      // clear it. Collapsing drops the filter.
      if (!next) setOnlyBookmarked(false)
      void save({
        conversationTimeline: { ...(settings?.conversationTimeline ?? {}), expanded: next },
      })
    },
    [save, settings?.conversationTimeline]
  )

  // The list owns the one jump implementation and publishes it; this used to
  // be a second, near-identical copy. Falls back to its own local scroll only
  // when no list has registered (e.g. rendered standalone in a story/test).
  const jumpToMessage = useChatViewportStore((s) => s.jumpToMessage)
  /**
   * Go to `turn`, or to `messageId` within it when the caller has a more
   * specific target (a starred reply). The index fast-path only holds for the
   * turn's own anchor message, so an override falls back to lookup by id.
   */
  const jumpTo = useCallback(
    (turn: TimelineTurn, messageId?: string) => {
      const targetId = messageId ?? turn.id
      const index = messageId ? undefined : turn.index
      // `start`, not `center`: a timeline anchor is the user's own question,
      // and the point of going there is to read the reply that follows it. The
      // shared jump used to force `center` for every caller, which parked the
      // question mid-screen under the tail of the *previous* turn.
      if (jumpToMessage) {
        // `jumpToMessage` returns false for a row it cannot reach. The starred
        // reply branch passes `index: undefined` — exactly the case that has to
        // resolve by id and can therefore miss — so swallowing this made the
        // rail look inert on precisely the rows it was added for.
        if (!jumpToMessage(targetId, index, { align: "start" })) {
          toast.error(tJump("notFound"))
        }
        return
      }
      if (virtualize && virtualizer && index != null) {
        virtualizer.scrollToIndex(index, { align: "start" })
        return
      }
      const anchor = findMessageAnchor(scrollRef.current, targetId)
      if (!anchor) {
        toast.error(tJump("notFound"))
        return
      }
      anchor.scrollIntoView({ behavior: "smooth", block: "start" })
    },
    [jumpToMessage, virtualize, virtualizer, scrollRef, tJump]
  )

  /**
   * Move `delta` anchors from whichever turn the viewport is currently on.
   * `geom.activeIndex` is the turn nearest the viewport top, so stepping from
   * it matches what the user sees — including after they scrolled by hand
   * rather than jumping. Clamps at both ends instead of wrapping.
   */
  const stepAnchor = useCallback(
    (delta: number) => {
      if (turns.length === 0) return
      const from = geom.activeIndex < 0 ? 0 : geom.activeIndex
      const target = turns[Math.max(0, Math.min(from + delta, turns.length - 1))]
      if (target) jumpTo(target)
    },
    [turns, geom.activeIndex, jumpTo]
  )

  // Keyboard parity for the rail, which is pointer-only (aria-hidden). These
  // fire while the composer has focus, so they must not be a chord the textarea
  // wants — see the catalog note on the chosen combo. Monaco keeps its own
  // keymap in the Canvas/editor surfaces.
  const shortcutOptions = {
    enabled: shortcutsEnabled,
    preventDefault: true,
    allowInEditable: true,
    editorSelectors: [".monaco-editor"],
  }
  useAppShortcut("chat.timeline.prevAnchor", () => stepAnchor(-1), shortcutOptions)
  useAppShortcut("chat.timeline.nextAnchor", () => stepAnchor(1), shortcutOptions)

  const onRailPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      // While dragging the thumb the rail must not also chase the pointer with
      // a scrub card — the card would fight the drag it is sitting on top of.
      if (draggingRef.current) return
      const rect = e.currentTarget.getBoundingClientRect()
      if (rect.height <= 0) return
      const frac = (e.clientY - rect.top) / rect.height
      const index = nearestTurnIndex(frac, geom.positions, turns.length)
      if (index < 0) return
      const raw = e.clientY - rect.top
      const y = Math.max(SCRUB_CARD_HALF, Math.min(raw, rect.height - SCRUB_CARD_HALF))
      setScrub({ index, y })
    },
    [geom.positions, turns.length]
  )

  const onRailClick = useCallback(() => {
    // A drag ends with a click on the rail; without this the release would also
    // jump to whatever turn happened to be nearest, undoing the drag.
    if (draggingRef.current) return
    if (scrub && turns[scrub.index]) jumpTo(turns[scrub.index])
  }, [scrub, turns, jumpTo])

  // ── Drag the viewport thumb ─────────────────────────────────────────────
  const railRef = useRef<HTMLButtonElement>(null)
  const [dragging, setDragging] = useState(false)
  const draggingRef = useRef(false)
  /** Where inside the thumb the pointer grabbed it, so it doesn't jump on grab. */
  const grabOffsetRef = useRef(0)

  const scrollToThumbTop = useCallback(
    (clientY: number) => {
      const rail = railRef.current
      const el = scrollRef.current
      if (!rail || !el) return
      const rect = rail.getBoundingClientRect()
      const totalSize = virtualize && virtualizer ? virtualizer.getTotalSize() : el.scrollHeight
      el.scrollTop = scrollTopForThumb({
        thumbTop: clientY - rect.top - grabOffsetRef.current,
        railHeight: rect.height,
        totalSize,
        maxScrollTop: el.scrollHeight - el.clientHeight,
      })
    },
    [scrollRef, virtualize, virtualizer]
  )

  const onThumbPointerDown = useCallback((e: React.PointerEvent<HTMLElement>) => {
    // Otherwise the rail beneath treats the press as click-to-jump.
    e.stopPropagation()
    e.preventDefault()
    const thumb = e.currentTarget.getBoundingClientRect()
    grabOffsetRef.current = e.clientY - thumb.top
    draggingRef.current = true
    setDragging(true)
    setScrub(null)
    // Capture so the drag survives the pointer leaving the 16px rail — which
    // it will, immediately, because the rail is 16px wide.
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }, [])

  const onThumbPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (!draggingRef.current) return
      e.stopPropagation()
      scrollToThumbTop(e.clientY)
    },
    [scrollToThumbTop]
  )

  const onThumbPointerUp = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (!draggingRef.current) return
    e.stopPropagation()
    draggingRef.current = false
    setDragging(false)
    e.currentTarget.releasePointerCapture?.(e.pointerId)
  }, [])

  const scrubTurn = scrub ? turns[scrub.index] : null
  // The scrub card re-renders on every mousemove (setScrub). Memoize the
  // locale time-format keyed on the hovered turn so it only recomputes when the
  // pointer crosses into a different turn, not on each pixel of vertical drag.
  const scrubTime = useMemo(
    () => (scrubTurn ? formatTurnTime(scrubTurn.time, { yesterdayLabel }) : null),
    [scrubTurn, yesterdayLabel]
  )

  // Gate on the unfiltered set: an active filter that matches nothing must
  // still render the panel that owns the toggle.
  if (allTurns.length === 0) return null

  const renderTurn = (turn: TimelineTurn, index: number) => {
    const active = index === geom.activeIndex
    const isBookmarked = isTurnBookmarked(turn)
    const starredReply = starredReplyId(turn)
    const time = formatTurnTime(turn.time, { yesterdayLabel })
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-turn-index={index}
            // When the star is on a REPLY, that reply is what the user marked
            // and what they mean to return to; the question that opened the
            // turn is not.
            onClick={() => jumpTo(turn, starredReply ?? undefined)}
            aria-current={active ? "true" : undefined}
            aria-label={t("jumpTo", { label: turn.label })}
            className={cn(
              "relative flex w-full items-start gap-2 py-1.5 pl-2.5 pr-2 text-left transition-colors hover:bg-accent",
              active && "bg-accent/60"
            )}
          >
            <span
              aria-hidden
              className={cn(
                "z-10 mt-1 size-2 shrink-0 rounded-full border-2 border-background",
                isBookmarked ? "bg-yellow-500" : active ? "bg-primary" : "bg-muted-foreground/50"
              )}
            />
            <span className="min-w-0 flex-1">
              <span
                className={cn(
                  "block truncate text-xs",
                  active ? "font-medium text-foreground" : "text-muted-foreground"
                )}
              >
                {turn.label}
              </span>
              {starredReply ? (
                <span
                  className="mt-0.5 block truncate text-[10px] text-yellow-600 dark:text-yellow-500"
                  data-testid="timeline-starred-reply"
                >
                  {t("starredReply")}
                </span>
              ) : null}
              <span className="mt-0.5 block text-[10px] text-muted-foreground/70">
                {time && <span>{time}</span>}
                {time && turn.replyCount > 0 && <span> · </span>}
                {turn.replyCount > 0 && <span>{t("replyCount", { count: turn.replyCount })}</span>}
              </span>
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="left" className="max-w-xs">
          {turn.preview}
        </TooltipContent>
      </Tooltip>
    )
  }

  /**
   * The day this turn opens, if any.
   *
   * Rendered by the caller, OUTSIDE `MotionReveal`: that wrapper leaves a
   * `transform` on its div, and a transformed ancestor becomes the containing
   * block for `position: sticky` — so a header nested inside it would stick to
   * its own 40px row instead of the panel, i.e. not stick at all.
   */
  const renderDateHeader = (index: number) => {
    const header = dateHeaders.get(index)
    if (!header) return null
    return (
      <span
        // Sticky so the day stays overhead while you scan within it — the whole
        // point is answering "when was this" without scrolling back. Under
        // virtualization the rows are transform-positioned, so sticky is inert
        // here and `timeline-pinned-date-header` does the job instead; this
        // still marks the boundary as it scrolls past.
        className="sticky top-0 z-20 block bg-background/95 px-2.5 py-1 text-[10px] font-medium text-muted-foreground backdrop-blur"
        data-testid="timeline-date-header"
      >
        {header}
      </span>
    )
  }

  return (
    <div
      className={cn(
        // `@4xl/message-list` (56rem = 896px) mirrors TIMELINE_MIN_PANE_PX in
        // `timeline-visibility.ts` — the JS gate decides whether to mount,
        // this one keeps a mounted-but-too-narrow frame from painting.
        "hidden @4xl/message-list:flex",
        // In flow in BOTH states. The panel always was (as an overlay it sat on
        // top of the message text, unreadable in any pane under ~1344px), but
        // the collapsed rail used to be `absolute right-0`, which put it
        // directly on top of the message list's native scrollbar — so on any
        // platform with classic (non-overlay) scrollbars the rail swallowed
        // every scrollbar drag. Its own 16px lane costs the reading column
        // almost nothing and hands the scrollbar back.
        "relative h-full shrink-0",
        expanded ? "" : "w-4"
      )}
      onPointerLeave={() => setScrub(null)}
      data-testid="conversation-timeline"
      data-computer-use-pip-obstacle
    >
      {expanded ? (
        // No shadow/backdrop-blur: those are overlay treatments, and this
        // panel is a flush in-flow region now.
        <div className="flex h-full w-64 flex-col border-l bg-background">
          <div className="flex items-center justify-between border-b px-3 py-2">
            <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <ListTreeIcon className="size-3.5" />
              {t("title")}
            </span>
            <span className="flex items-center gap-0.5">
              <Button
                variant="ghost"
                size="icon"
                className={cn("size-6", onlyBookmarked && "text-yellow-500")}
                aria-label={onlyBookmarked ? t("showAll") : t("showBookmarked")}
                aria-pressed={onlyBookmarked}
                onClick={() => setOnlyBookmarked((v) => !v)}
                data-testid="timeline-filter-bookmarked"
              >
                <BookmarkIcon className={cn("size-3.5", onlyBookmarked && "fill-current")} />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                aria-label={t("collapse")}
                onClick={() => setPinned(false)}
              >
                <ChevronRightIcon className="size-4" />
              </Button>
            </span>
          </div>
          <div ref={expandedScrollRef} className="relative flex-1 overflow-y-auto py-1">
            {turns.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                {t("noBookmarks")}
              </p>
            ) : null}
            {/* connector line */}
            <div
              aria-hidden
              className="pointer-events-none absolute bottom-2 left-[14px] top-2 w-px bg-border"
            />
            {virtualizeExpanded && pinnedDateHeader ? (
              // The inline headers below cannot stick: every virtualized row is
              // `transform`-positioned, and a transformed ancestor becomes the
              // containing block for `position: sticky`, so each header stuck to
              // its own 40px row — i.e. not at all, in the only branch (>40
              // turns) where grouping earns its keep. This one sits outside the
              // transformed subtree and tracks the topmost visible row instead.
              <div
                className="sticky top-0 z-30 bg-background/95 px-2.5 py-1 text-[10px] font-medium text-muted-foreground backdrop-blur"
                data-testid="timeline-pinned-date-header"
              >
                {pinnedDateHeader}
              </div>
            ) : null}
            {virtualizeExpanded ? (
              <ul
                className="relative"
                style={{ height: expandedVirtualizer.getTotalSize() }}
                data-testid="timeline-expanded-list"
              >
                {expandedItems.map((item) => {
                  const turn = turns[item.index]
                  if (!turn) return null
                  return (
                    <li
                      key={item.key}
                      ref={expandedVirtualizer.measureElement}
                      data-index={item.index}
                      className="absolute left-0 top-0 w-full"
                      style={{ transform: `translateY(${item.start}px)` }}
                    >
                      {renderDateHeader(item.index)}
                      {renderTurn(turn, item.index)}
                    </li>
                  )
                })}
              </ul>
            ) : (
              <ul className="flex flex-col">
                {turns.map((turn, index) => (
                  <li key={turn.id}>
                    {renderDateHeader(index)}
                    {/* The panel's width lands in a single layout pass — no
                        width tween, which would rewrap the reading column and
                        force the main list's virtualizer to re-measure every
                        frame. The sense of it opening comes from the rows
                        arriving instead: pure opacity/transform, no layout.
                        The virtualized branch skips this, because rows there
                        mount and unmount as you scroll and would re-animate
                        continuously. */}
                    <MotionReveal index={index}>{renderTurn(turn, index)}</MotionReveal>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : (
        <div className="group relative h-full w-4">
          {/* Grip — the accessible, keyboard-focusable way to open the full panel. */}
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("expand")}
            onClick={() => setPinned(true)}
            // Faintly visible at rest rather than fully transparent: at
            // `opacity-0` the entire rail was invisible until the pointer
            // happened to cross it, so there was nothing to discover and no
            // reason to hover in the first place.
            className="absolute left-1/2 top-1 z-20 size-5 -translate-x-1/2 rounded opacity-40 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          >
            <ChevronLeftIcon className="size-3.5" />
          </Button>

          {/* Scrub preview card — pointer-only, mirrored by the accessible panel. */}
          {scrubTurn && (
            <div
              aria-hidden
              data-testid="timeline-scrub-card"
              className="pointer-events-none absolute right-full z-30 mr-1 w-44 -translate-y-1/2 rounded-md border bg-popover px-2.5 py-1.5 text-popover-foreground shadow-md"
              style={{ top: scrub?.y }}
            >
              {scrubTime && (
                <div className="text-[10px] font-medium tabular-nums text-muted-foreground">
                  {scrubTime}
                </div>
              )}
              <div className="truncate text-xs text-foreground">{scrubTurn.label}</div>
            </div>
          )}

          {/* Rail body — pointer-driven scrub + click-to-jump. */}
          <button
            type="button"
            tabIndex={-1}
            aria-hidden
            data-testid="timeline-rail"
            ref={railRef}
            // Pointer, not mouse: the rail was mouse-only, so a stylus (and any
            // other non-mouse pointer) got no scrub preview at all.
            onPointerMove={onRailPointerMove}
            onPointerLeave={() => setScrub(null)}
            onClick={onRailClick}
            className="absolute inset-0 cursor-pointer bg-transparent transition-colors hover:bg-accent/30"
          >
            {/* Viewport thumb — draggable, so a long conversation can be
                scrubbed continuously instead of only jumped turn by turn. */}
            <span
              aria-hidden
              data-testid="timeline-viewport-thumb"
              onPointerDown={onThumbPointerDown}
              onPointerMove={onThumbPointerMove}
              onPointerUp={onThumbPointerUp}
              onPointerCancel={onThumbPointerUp}
              className={cn(
                "absolute inset-x-0.5 rounded-full bg-primary/20 group-hover:bg-primary/30",
                dragging ? "cursor-grabbing bg-primary/40" : "cursor-grab"
              )}
              style={{
                top: `${geom.viewportTop * 100}%`,
                height: `${Math.max(geom.viewportHeight * 100, 4)}%`,
              }}
            />
            {railMarkers.map((marker, markerIndex) => {
              const scrubMarkerIndex =
                scrub == null || turns.length === 0
                  ? -1
                  : Math.min(
                      railMarkers.length - 1,
                      Math.floor((scrub.index * railMarkers.length) / turns.length)
                    )
              const isScrub = scrubMarkerIndex === markerIndex
              return (
                <span
                  key={marker.key}
                  aria-hidden
                  className={cn(
                    // Dots at rest, short dashes on hover: widening on hover
                    // reads as the rail "opening up" under the pointer, and a
                    // dash is far easier to aim at than a 6px dot.
                    "absolute right-1 -translate-y-1/2 rounded-full transition-all",
                    isScrub ? "h-2 w-2" : "h-1.5 w-1.5 group-hover:h-1 group-hover:w-2.5",
                    marker.isBookmarked
                      ? "bg-yellow-500"
                      : isScrub || marker.isActive
                        ? "bg-primary"
                        : // Was /40, which on a light background was very nearly
                          // invisible — the rail read as an empty strip.
                          "bg-muted-foreground/55"
                  )}
                  style={{ top: `${marker.position * 100}%` }}
                />
              )
            })}
          </button>
        </div>
      )}
    </div>
  )
})
