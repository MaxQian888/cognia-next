"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import type { Virtualizer } from "@tanstack/react-virtual"
import type { TimelineTurn } from "./use-timeline-turns"

/** Geometry the minimap renders from — all positions are fractions in [0,1]. */
export interface TimelineGeometry {
  /** Start position of each turn, same order as the input turns. */
  positions: number[]
  /** Top of the viewport as a fraction of total scroll height. */
  viewportTop: number
  /** Viewport height as a fraction of total scroll height. */
  viewportHeight: number
  /** Index (into turns) of the turn currently near the viewport top; -1 if none. */
  activeIndex: number
}

export const EMPTY_GEOMETRY: TimelineGeometry = {
  positions: [],
  viewportTop: 0,
  viewportHeight: 1,
  activeIndex: -1,
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return n < 0 ? 0 : n > 1 ? 1 : n
}

/**
 * Pure geometry math, split out so it can be unit-tested without a DOM. Given
 * the scroll metrics and the absolute pixel `starts` of each turn, produce the
 * fractional positions, the viewport window, and the active turn (the last
 * turn whose start sits at/above a small probe below the viewport top).
 */
export function computeTimelineGeometry(params: {
  scrollTop: number
  clientHeight: number
  total: number
  starts: number[]
}): TimelineGeometry {
  const { scrollTop, clientHeight, total, starts } = params
  if (total <= 0) {
    return {
      positions: starts.map(() => 0),
      viewportTop: 0,
      viewportHeight: 1,
      activeIndex: starts.length ? 0 : -1,
    }
  }
  const positions = starts.map((s) => clamp01(s / total))
  const probe = scrollTop + Math.min(clientHeight * 0.3, 120)
  let activeIndex = starts.length ? 0 : -1
  for (let i = 0; i < starts.length; i++) {
    if (starts[i] <= probe) activeIndex = i
    else break
  }
  return {
    positions,
    viewportTop: clamp01(scrollTop / total),
    viewportHeight: clamp01(clientHeight / total),
    activeIndex,
  }
}

function selectorForId(id: string): string {
  const escaped =
    typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape(id)
      : id.replace(/["\\]/g, "\\$&")
  return `[data-msg-id="${escaped}"]`
}

export interface UseScrollSyncArgs {
  scrollRef: React.RefObject<HTMLDivElement | null>
  virtualizer: Virtualizer<HTMLDivElement, Element> | null
  virtualize: boolean
  turns: TimelineTurn[]
}

/**
 * Track the chat scroll container and produce minimap {@link TimelineGeometry}.
 * Recomputes at most once per animation frame on scroll/resize and whenever
 * the turn set changes. Uses the virtualizer's measurement cache for
 * off-screen rows (virtualized lists) and DOM measurement for short
 * document-flow lists. Self-contained — never lifts state into the parent, so
 * scrolling doesn't re-render the message list.
 */
export function useTimelineScrollSync({
  scrollRef,
  virtualizer,
  virtualize,
  turns,
}: UseScrollSyncArgs): TimelineGeometry {
  const [geom, setGeom] = useState<TimelineGeometry>(EMPTY_GEOMETRY)
  const rafRef = useRef<number | null>(null)
  // Cached document-flow `starts` (absolute pixel offset of each turn). Measuring
  // these calls getBoundingClientRect per turn — a forced synchronous reflow —
  // so we keep the result and only remeasure when the turn set or size changes,
  // never on plain scroll. Virtualized lists read the virtualizer's measurement
  // cache instead (a cheap array lookup), so they don't use this.
  const startsRef = useRef<number[] | null>(null)
  const needsRemeasureRef = useRef(true)

  const measureStarts = useCallback(
    (el: HTMLDivElement, total: number): number[] => {
      if (virtualize && virtualizer) {
        const count = virtualizer.options.count
        return turns.map((turn) => {
          const cached = virtualizer.measurementsCache?.[turn.index]?.start
          if (typeof cached === "number") return cached
          const off = virtualizer.getOffsetForIndex?.(turn.index, "start")?.[0]
          if (typeof off === "number") return off
          // Fallback estimate: turn.index is an index into the full message
          // list, so it must be divided by the item COUNT (not turns.length,
          // the user-turn count) or the ratio exceeds 1 and pins to the bottom.
          return total > 0 && count > 0 ? (turn.index / count) * total : 0
        })
      }
      const cRect = el.getBoundingClientRect()
      return turns.map((turn) => {
        const node = el.querySelector<HTMLElement>(selectorForId(turn.id))
        if (node) return node.getBoundingClientRect().top - cRect.top + el.scrollTop
        return 0
      })
    },
    [virtualize, virtualizer, turns]
  )

  const compute = useCallback(
    (remeasure: boolean): TimelineGeometry => {
      const el = scrollRef.current
      if (!el) return EMPTY_GEOMETRY
      const total = virtualize && virtualizer ? virtualizer.getTotalSize() : el.scrollHeight
      let starts: number[]
      if (virtualize && virtualizer) {
        // Virtualizer cache updates as rows are measured during scroll; reading
        // it is cheap, so re-derive every frame to track newly-measured rows.
        starts = measureStarts(el, total)
      } else if (remeasure || startsRef.current == null) {
        startsRef.current = measureStarts(el, total)
        starts = startsRef.current
      } else {
        starts = startsRef.current
      }
      return computeTimelineGeometry({
        scrollTop: el.scrollTop,
        clientHeight: el.clientHeight,
        total,
        starts,
      })
    },
    [scrollRef, virtualizer, virtualize, measureStarts]
  )

  const schedule = useCallback(() => {
    if (rafRef.current != null) return
    const raf =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame
        : (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16) as unknown as number
    rafRef.current = raf(() => {
      rafRef.current = null
      const remeasure = needsRemeasureRef.current
      needsRemeasureRef.current = false
      setGeom(compute(remeasure))
    })
  }, [compute])

  // Force a fresh document-flow measurement on the next frame (turn set / size
  // change). Plain scroll calls `schedule` directly, reusing the cached starts.
  const scheduleRemeasure = useCallback(() => {
    needsRemeasureRef.current = true
    schedule()
  }, [schedule])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    needsRemeasureRef.current = true
    setGeom(compute(true))
    el.addEventListener("scroll", schedule, { passive: true })
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(scheduleRemeasure) : null
    ro?.observe(el)
    return () => {
      el.removeEventListener("scroll", schedule)
      ro?.disconnect()
      if (rafRef.current != null && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(rafRef.current)
      }
      rafRef.current = null
    }
  }, [scrollRef, schedule, scheduleRemeasure, compute])

  // Remeasure when the turn set changes (new messages, streaming growth).
  useEffect(() => {
    scheduleRemeasure()
  }, [turns, scheduleRemeasure])

  return geom
}
