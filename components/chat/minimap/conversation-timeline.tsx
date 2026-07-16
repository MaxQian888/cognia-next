"use client"

import { memo, useCallback, useMemo, useState } from "react"
import type { UIMessage } from "ai"
import type { Virtualizer } from "@tanstack/react-virtual"
import { useTranslations } from "next-intl"
import { BookmarkIcon, ChevronLeftIcon, ChevronRightIcon, ListTreeIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useSettingsStore } from "@/stores/settings"
import { useChatStore } from "@/stores/chat"
import { useAppShortcut } from "@/hooks/shortcuts/use-app-shortcut"
import { useTimelineTurns, type TimelineTurn } from "./use-timeline-turns"
import { useTimelineScrollSync } from "./use-timeline-scroll-sync"
import { formatTurnTime } from "./format-turn-time"

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
    let best = 0
    let bestDist = Infinity
    for (let i = 0; i < count; i++) {
      const d = Math.abs((positions[i] ?? 0) - f)
      if (d < bestDist) {
        bestDist = d
        best = i
      }
    }
    return best
  }
  return count === 1 ? 0 : Math.round(f * (count - 1))
}

interface ScrubState {
  index: number
  /** Clamped pointer offset from the rail top, in px. */
  y: number
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
  const [onlyBookmarked, setOnlyBookmarked] = useState(false)
  const turns = useMemo(
    () => (onlyBookmarked ? allTurns.filter(isTurnBookmarked) : allTurns),
    [onlyBookmarked, allTurns, isTurnBookmarked]
  )

  const geom = useTimelineScrollSync({ scrollRef, virtualizer, virtualize, turns })

  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const expanded = settings?.conversationTimeline?.expanded ?? false
  const [scrub, setScrub] = useState<ScrubState | null>(null)

  const yesterdayLabel = t("yesterday")

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

  const jumpTo = useCallback(
    (turn: TimelineTurn) => {
      if (virtualize && virtualizer) {
        virtualizer.scrollToIndex(turn.index, { align: "start" })
        return
      }
      const sel = `[data-msg-id="${turn.id.replace(/["\\]/g, "\\$&")}"]`
      scrollRef.current?.querySelector<HTMLElement>(sel)?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      })
    },
    [virtualize, virtualizer, scrollRef]
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

  const onRailMouseMove = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
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
    if (scrub && turns[scrub.index]) jumpTo(turns[scrub.index])
  }, [scrub, turns, jumpTo])

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

  return (
    <div
      className="absolute right-0 top-0 bottom-0 z-20 hidden lg:flex"
      onMouseLeave={() => setScrub(null)}
      data-testid="conversation-timeline"
    >
      {expanded ? (
        <div className="flex h-full w-64 flex-col border-l bg-background/95 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-background/80">
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
          <div className="relative flex-1 overflow-y-auto py-1">
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
            <ul className="flex flex-col">
              {turns.map((turn, i) => {
                const active = i === geom.activeIndex
                const isBookmarked = isTurnBookmarked(turn)
                const time = formatTurnTime(turn.time, { yesterdayLabel })
                return (
                  <li key={turn.id}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={() => jumpTo(turn)}
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
                              isBookmarked
                                ? "bg-yellow-500"
                                : active
                                  ? "bg-primary"
                                  : "bg-muted-foreground/50"
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
                            <span className="mt-0.5 block text-[10px] text-muted-foreground/70">
                              {time && <span>{time}</span>}
                              {time && turn.replyCount > 0 && <span> · </span>}
                              {turn.replyCount > 0 && (
                                <span>{t("replyCount", { count: turn.replyCount })}</span>
                              )}
                            </span>
                          </span>
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="left" className="max-w-xs">
                        {turn.preview}
                      </TooltipContent>
                    </Tooltip>
                  </li>
                )
              })}
            </ul>
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
            className="absolute left-1/2 top-1 z-20 size-5 -translate-x-1/2 rounded opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
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
            onMouseMove={onRailMouseMove}
            onMouseLeave={() => setScrub(null)}
            onClick={onRailClick}
            className="absolute inset-0 cursor-pointer bg-transparent transition-colors hover:bg-accent/30"
          >
            {/* viewport slider */}
            <span
              aria-hidden
              className="absolute inset-x-0.5 rounded-full bg-primary/15 group-hover:bg-primary/25"
              style={{
                top: `${geom.viewportTop * 100}%`,
                height: `${Math.max(geom.viewportHeight * 100, 4)}%`,
              }}
            />
            {turns.map((turn, i) => {
              const isScrub = scrub?.index === i
              const isActive = i === geom.activeIndex
              const isBookmarked = isTurnBookmarked(turn)
              return (
                <span
                  key={turn.id}
                  aria-hidden
                  className={cn(
                    "absolute right-1 -translate-y-1/2 rounded-full transition-all",
                    isScrub ? "size-2" : "size-1.5",
                    isBookmarked
                      ? "bg-yellow-500"
                      : isScrub || isActive
                        ? "bg-primary"
                        : "bg-muted-foreground/40"
                  )}
                  style={{ top: `${(geom.positions[i] ?? 0) * 100}%` }}
                />
              )
            })}
          </button>
        </div>
      )}
    </div>
  )
})
