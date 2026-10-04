"use client"

/**
 * Which of a list of anchored sections a scroll container is currently showing,
 * and a way to jump to one.
 *
 * For in-pane navigation over one long scroll (the device dashboard): the
 * reader needs to see where they are and get to a section without a second
 * scrollbar's worth of hunting, while the sections stay on one page.
 *
 * A scroll listener rather than an `IntersectionObserver`, deliberately.
 * "Which section's top has passed the reading line" is one comparison per
 * section, it answers the bottom-of-the-pane case an observer cannot (a short
 * last card never reaches the line, so it would never become active), and it
 * is plain layout reads that every WebView the Capacitor shell runs on
 * supports. jsdom has no layout, so with every rect at the origin the first
 * section is active, which is the right answer when there is no viewport.
 *
 * Jumping writes `scrollTop` rather than calling `scrollTo` or
 * `scrollIntoView`: the former is missing in jsdom and in older Android
 * WebViews, and the latter scrolls every ancestor too, which on a phone drags
 * the whole drawer.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from "react"

export interface UseScrollSpyOptions {
  /** Section element ids, in document order. */
  ids: readonly string[]
  /**
   * How far below the container's top edge a section's top must have passed to
   * count as the one being read. Also the gap left above a section jumped to.
   */
  offset?: number
  /**
   * Returns the container to the top whenever it changes, e.g. the id of the
   * record the sections describe. Carrying one record's offset into another
   * lands the reader mid-way through it with no sign that is what happened.
   */
  resetKey?: unknown
}

export interface UseScrollSpyResult<T extends HTMLElement> {
  /**
   * Attach to the scrolling element the sections live in. The hook owns the
   * ref rather than taking one, because jumping writes its `scrollTop`, and a
   * hook must not mutate what it was handed.
   */
  rootRef: RefObject<T | null>
  activeId: string | null
  scrollTo: (id: string) => void
}

/** Pixels from the bottom at which the container counts as scrolled to the end. */
const BOTTOM_SLACK = 2

/**
 * The active section for one set of measurements. Pure, so the rule is
 * testable without a layout engine.
 *
 * `tops` are each section's top edge relative to the container's top, in the
 * same order as `ids`; `null` marks a section that is not in the DOM.
 */
export function pickActiveSection(
  ids: readonly string[],
  tops: readonly (number | null)[],
  offset: number,
  atBottom: boolean
): string | null {
  const present = ids.filter((_, index) => tops[index] !== null)
  if (present.length === 0) return null
  // A short last section can never scroll up to the reading line; once there
  // is nothing left to scroll, the reader is looking at it.
  if (atBottom) return present[present.length - 1]!
  let active = present[0]!
  ids.forEach((id, index) => {
    const top = tops[index]
    if (top !== null && top !== undefined && top <= offset) active = id
  })
  return active
}

export function useScrollSpy<T extends HTMLElement = HTMLDivElement>({
  ids,
  offset = 16,
  resetKey,
}: UseScrollSpyOptions): UseScrollSpyResult<T> {
  const rootRef = useRef<T | null>(null)
  const [activeId, setActiveId] = useState<string | null>(ids[0] ?? null)
  /**
   * Set by a jump that actually moved the container. The scroll event that
   * jump fires would otherwise re-measure and, for a short section near the
   * bottom, hand "active" to the last section instead of the one clicked.
   */
  const ignoreNextScroll = useRef(false)
  // Read through a ref by the listener, so a new array with the same members
  // (every parent render) does not re-subscribe it; a different list does,
  // through `idsKey`, so a new device's sections are measured afresh.
  const idsRef = useRef(ids)
  const idsKey = ids.join("\u0000")

  useEffect(() => {
    idsRef.current = ids
  })

  useEffect(() => {
    // `scrollTop`, not `scrollTo`: the latter is absent in jsdom and in the
    // older Android WebViews the Capacitor shell runs on, and an unanimated
    // jump to the top is exactly what a new record wants.
    if (rootRef.current) rootRef.current.scrollTop = 0
  }, [resetKey])

  useEffect(() => {
    const container = rootRef.current
    if (!container) return
    let frame: number | null = null

    const measure = () => {
      const current = idsRef.current
      const containerTop = container.getBoundingClientRect().top
      const tops = current.map((id) => {
        const element = container.ownerDocument.getElementById(id)
        if (!element || !container.contains(element)) return null
        return element.getBoundingClientRect().top - containerTop
      })
      const atBottom =
        container.scrollHeight > container.clientHeight &&
        container.scrollTop + container.clientHeight >= container.scrollHeight - BOTTOM_SLACK
      setActiveId(pickActiveSection(current, tops, offset, atBottom))
    }
    // A flag rather than "is there a frame id": a callback that runs
    // synchronously (some WebViews, and test doubles) would clear the id
    // before `requestAnimationFrame` returned it, leaving a stale id that
    // blocks every later frame.
    let scheduled = false
    const schedule = () => {
      if (scheduled) return
      scheduled = true
      frame = requestAnimationFrame(() => {
        scheduled = false
        frame = null
        measure()
      })
    }
    const onScroll = () => {
      if (ignoreNextScroll.current) {
        ignoreNextScroll.current = false
        return
      }
      schedule()
    }

    // The first reading goes through a frame too: the sections have to have
    // laid out before their positions mean anything.
    schedule()
    container.addEventListener("scroll", onScroll, { passive: true })
    return () => {
      container.removeEventListener("scroll", onScroll)
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [idsKey, offset])

  const scrollTo = useCallback(
    (id: string) => {
      const container = rootRef.current
      const element = container?.ownerDocument.getElementById(id)
      if (!container || !element || !container.contains(element)) return
      const delta = element.getBoundingClientRect().top - container.getBoundingClientRect().top
      const before = container.scrollTop
      container.scrollTop = Math.max(0, before + delta - offset / 2)
      // Only a jump that moved fires a scroll event to swallow. Arming the flag
      // for one that did not would eat the reader's next real scroll.
      if (container.scrollTop !== before) ignoreNextScroll.current = true
      // Said immediately rather than after the scroll event: a section near the
      // bottom may not move at all, and the click must still land.
      setActiveId(id)
    },
    [offset]
  )

  return { rootRef, activeId, scrollTo }
}
