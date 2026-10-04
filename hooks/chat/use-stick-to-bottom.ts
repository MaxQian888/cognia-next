"use client"

/**
 * `useStickToBottom` — the ONE owner of `scrollTop` for a chat transcript.
 *
 * Before this hook the message list wrote `scrollTop` from five independent
 * places (a `messages`/`status` effect, a content `ResizeObserver`, a viewport
 * `ResizeObserver`, the thinking indicator's phase callback, and a
 * post-finalise `requestAnimationFrame`), each with its own gate, racing
 * `virtual-core`'s own `scheduleScrollReconcile` rAF loop. Three of the five
 * ran **after paint**, which is what made the transcript visibly jitter while
 * streaming: the browser painted the taller content first (the reading column
 * jumps up by the growth delta) and only the next frame corrected the scroll
 * back down. At one coalesced commit per frame that reads as a continuous
 * shimmer under the caret.
 *
 * The fix is not "fewer writers" but "one writer, in the layout phase":
 *
 *   - state-driven pins run in a **layout effect** (post-mutation, pre-paint),
 *     so the growth and its scroll correction land in the same frame;
 *   - `ResizeObserver` callbacks are already delivered after layout and before
 *     paint, so they pin synchronously from inside the observer;
 *   - every write goes through {@link pin}, which no-ops when the container is
 *     already at the foot for the current `scrollHeight`. That makes "one
 *     commit → at most one scroll write" an assertable fact, which is what the
 *     reading-area guardrail test pins (ADR-0138).
 *
 * Following and position are separate facts. `following` (pin growth to the
 * foot) is disarmed only by the reader — moving up by wheel, touch, keyboard or
 * scrollbar, opening a disclosure, a jump elsewhere — and re-armed by returning
 * to the foot, the jump pill ({@link StickToBottom.scrollToBottom}) or a send
 * ({@link StickToBottom.resetToBottom}). The list's own growth never disarms
 * it, even when a pin's scroll event arrives after the content grew again.
 *
 * Deliberately NOT in scope: jumping to a message, the landing flash, the
 * return-here offer, and publishing to `chatViewportStore`. Those are a
 * different concern (navigation, not anchoring) and they are not broken; the
 * hook only has to be the single answer to "who moved the scroll position".
 */

import { useCallback, useEffect, useRef, useState, type RefObject, type MouseEvent } from "react"

import { useIsomorphicLayoutEffect } from "@/hooks/use-isomorphic-layout-effect"

/**
 * Distance from the foot, in px, still counted as "at the bottom".
 *
 * Sub-line slack: fractional layout, a rubber-band overshoot, or a keyboard
 * nudge that never left the last line still count as parked at the tail. An
 * upward wheel or touch gesture disarms following on its own, threshold or not.
 */
export const AT_BOTTOM_THRESHOLD_PX = 32

export interface UseStickToBottomArgs {
  /** The scrolling viewport. */
  scrollRef: RefObject<HTMLElement | null>
  /**
   * The box whose height tracks the rendered transcript. Observed so growth
   * that lands one or more frames after the state change (deferred markdown,
   * async syntax highlighting, an image decoding) still re-pins.
   */
  contentRef: RefObject<HTMLElement | null>
  /** User preference — `composerBehavior.autoScrollOnStream`. */
  enabled: boolean
  /** A turn is in flight (streaming or awaiting approval). */
  active: boolean
  /**
   * Changes once per rendered transcript commit. The layout-phase pin runs when
   * this changes; callers pass the `messages` array identity, which the chat
   * runtime replaces once per coalesced frame.
   */
  pinKey: unknown
  /** Override for {@link AT_BOTTOM_THRESHOLD_PX} (testing / tuning). */
  thresholdPx?: number
}

export interface StickToBottom {
  /**
   * Whether the reader counts as being at the tail: physically within the
   * threshold of the foot, or following the stream (the next pin puts them
   * there). This is what the jump pill reads, so it never offers "back to the
   * latest" to someone the list is about to carry there anyway — nor to a
   * reader who opened a disclosure at the foot and is still looking at it.
   */
  atBottom: boolean
  /**
   * Whether growth is being followed — the arm/disarm state behind every pin.
   * Distinct from {@link atBottom}: opening a disclosure at the foot disarms
   * following while the reader is still physically at the bottom.
   */
  following: boolean
  /** `onScroll` handler for the viewport. Stable identity. */
  handleScroll: () => void
  /** Read a disclosure in place; reaching the physical foot re-arms following. */
  handleContentClick: (event: Pick<MouseEvent<HTMLElement>, "target">) => void
  /**
   * Pin now, honouring the enabled/following gate. For callers that change the
   * transcript's geometry outside a render (re-measuring a virtualizer, handing
   * the live tail back to the virtual list). Must be called from a layout
   * effect to stay in the same frame as the change.
   */
  pinNow: () => void
  /**
   * Jump to the foot and re-arm following, regardless of the current gate —
   * used when opening a conversation (the previous session's disarmed state
   * would otherwise carry over) and when the reader sends a message.
   */
  resetToBottom: () => void
  /**
   * The jump pill's "back to the latest": re-arm following immediately, then
   * scroll there (smoothly by default). Re-arming first matters — the smooth
   * scroll takes several frames, and a stream that grows during them is
   * followed rather than leaving the scroll short of the new foot.
   */
  scrollToBottom: (behavior?: ScrollBehavior) => void
  /**
   * Stop following without scrolling. For programmatic navigation away from the
   * foot (jumping to a message), whose own scroll would otherwise race the next
   * streamed pin.
   */
  release: () => void
}

/**
 * How long after an upward wheel / touch gesture its scroll events still count
 * as the reader moving up. Long enough to cover a wheel notch's smooth scroll,
 * short enough that a later collapse-to-the-foot re-arms as before.
 */
const GESTURE_WINDOW_MS = 300

/** Whether a scroll container *inside* the transcript would consume an upward scroll. */
function innerScrollerCanScrollUp(target: EventTarget | null, root: HTMLElement): boolean {
  let node = target instanceof Element ? target : null
  while (node && node !== root) {
    if (
      node instanceof HTMLElement &&
      node.scrollTop > 0 &&
      node.scrollHeight > node.clientHeight
    ) {
      const overflowY = getComputedStyle(node).overflowY
      if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") return true
    }
    node = node.parentElement
  }
  return false
}

export function useStickToBottom({
  scrollRef,
  contentRef,
  enabled,
  active,
  pinKey,
  thresholdPx = AT_BOTTOM_THRESHOLD_PX,
}: UseStickToBottomArgs): StickToBottom {
  // Two facts, deliberately kept apart (they used to be one `atBottom` flag):
  //
  //   following  growth is pinned to the foot. Disarmed only by the READER —
  //              moving up (wheel, touch, keyboard, scrollbar), opening a
  //              disclosure, a jump elsewhere. Never by the list's own growth.
  //   near       the viewport physically sits within `thresholdPx` of the foot.
  //
  // Folding them together is what lost the stream: a pin's scroll event is
  // delivered a frame later, and when content grew in between (a fence
  // highlighting, an image decoding, a tool card mounting) the handler read
  // "not at the bottom" and switched following off, so the observer that would
  // have caught the growth stood down and the reply ran off the screen.
  const [following, setFollowingState] = useState(true)
  const [near, setNearState] = useState(true)
  const followingRef = useRef(true)
  const nearRef = useRef(true)

  const setFollowing = useCallback((next: boolean) => {
    followingRef.current = next
    setFollowingState((prev) => (prev === next ? prev : next))
  }, [])
  const setNear = useCallback((next: boolean) => {
    nearRef.current = next
    setNearState((prev) => (prev === next ? prev : next))
  }, [])

  // Latest props, mirrored into a ref so the observers below (registered once)
  // read current values without re-subscribing every frame.
  //
  // Synced in a LAYOUT effect, declared first so it wins the ordering against
  // every other effect in this hook and in the host component. Within a frame
  // the browser runs layout effects → style/layout → ResizeObserver callbacks →
  // paint, so both readers below always see the gate for the commit they are
  // reacting to.
  const gateRef = useRef({ enabled, active })
  useIsomorphicLayoutEffect(() => {
    gateRef.current = { enabled, active }
  })

  // `scrollHeight` at the last write. Together with the foot check this makes a
  // repeat pin for unchanged geometry a no-op, so the write count is a function
  // of real growth rather than of how many observers happened to fire.
  const pinnedHeightRef = useRef(-1)
  // The last `scrollTop` this hook observed (its own pin, or a scroll event),
  // or null while the viewport has never been scrollable. Comparing against it
  // is how a scroll event tells the reader moving up from the list growing.
  const lastTopRef = useRef<number | null>(null)
  // Until when scroll events still belong to an upward wheel / touch gesture.
  const gestureUntilRef = useRef(0)

  const measureNear = useCallback(
    (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight < thresholdPx,
    [thresholdPx]
  )

  const pin = useCallback(
    (force = false) => {
      const el = scrollRef.current
      if (!el) return
      const height = el.scrollHeight
      if (!force && height === pinnedHeightRef.current) {
        // Same geometry as the last pin — only re-write if the reader is no
        // longer at the foot (which only happens if something else moved it).
        if (el.scrollTop >= height - el.clientHeight - 1) return
      }
      // Assigning `scrollHeight` rather than `scrollHeight - clientHeight`: the
      // browser clamps it to the same place and the intent reads plainly.
      // Setting `scrollTop` never resizes content, so this can't loop.
      el.scrollTop = height
      pinnedHeightRef.current = height
      // Read back: the browser clamps, and the clamped value is what the next
      // scroll event will report.
      lastTopRef.current = height > el.clientHeight ? el.scrollTop : null
      setNear(true)
    },
    [scrollRef, setNear]
  )

  /** Re-derive `near` without scrolling — growth the reader is not following. */
  const syncNear = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    setNear(measureNear(el))
  }, [measureNear, scrollRef, setNear])

  const pinNow = useCallback(() => {
    if (!gateRef.current.enabled || !followingRef.current) return
    pin()
  }, [pin])

  const resetToBottom = useCallback(() => {
    gestureUntilRef.current = 0
    setFollowing(true)
    pin(true)
  }, [pin, setFollowing])

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      const el = scrollRef.current
      if (!el) return
      gestureUntilRef.current = 0
      setFollowing(true)
      el.scrollTo({ top: el.scrollHeight, behavior })
    },
    [scrollRef, setFollowing]
  )

  const release = useCallback(() => setFollowing(false), [setFollowing])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const top = el.scrollTop
    const previous = lastTopRef.current
    lastTopRef.current = el.scrollHeight > el.clientHeight ? top : null
    const isNear = measureNear(el)
    // A position never observed cannot be compared against, so it counts as a
    // move: the reader is wherever they chose to be.
    const movedUp = previous === null || top < previous - 1
    if (isNear) {
      // Back at the foot re-arms — unless the reader is in the middle of
      // moving up and simply has not left the threshold yet.
      const movingUpByHand = movedUp && performance.now() < gestureUntilRef.current
      if (!movingUpByHand) setFollowing(true)
    } else if (movedUp) {
      // Up and away from the foot: the reader's choice (or a jump's). Growth
      // can only push the foot further down, never move `scrollTop` up, so it
      // lands in neither branch and following survives it.
      setFollowing(false)
    }
    // User intent must win immediately, including within the same event: the
    // refs above are already updated for any observer that fires before React
    // commits.
    setNear(isNear)
  }, [measureNear, scrollRef, setFollowing, setNear])

  const handleContentClick = useCallback(
    (event: Pick<MouseEvent<HTMLElement>, "target">) => {
      const target = event.target
      if (!(target instanceof Element)) return
      const disclosure = target.closest(
        "button[aria-expanded]:not([aria-haspopup]), [data-scroll-disclosure]"
      )
      if (!disclosure || !contentRef.current?.contains(disclosure)) return
      setFollowing(false)
    },
    [contentRef, setFollowing]
  )

  // Transcript commits. A layout effect, NOT `useEffect`: the whole point is
  // that the correction lands in the frame that painted the growth.
  useIsomorphicLayoutEffect(() => {
    const gate = gateRef.current
    if (!gate.enabled || !gate.active || !followingRef.current) return
    pin()
  }, [pinKey, active, enabled, pin])

  // Content-box growth. Covers everything the commit above cannot see: markdown
  // that renders across several frames, Shiki finishing a fence, an image
  // decoding, a tool card or reasoning block expanding, the thinking indicator
  // revealing its skeleton. Observer callbacks are delivered after layout and
  // before paint, so this is already same-frame. When not following it only
  // re-derives `near`, so the jump pill appears as the stream leaves the reader.
  useEffect(() => {
    const content = contentRef.current
    if (!content) return
    const observer = new ResizeObserver(() => {
      // Late image/diagram layout also lands after a turn has completed.
      // Disclosures explicitly disarm following via handleContentClick.
      if (gateRef.current.enabled && followingRef.current) pin()
      else syncNear()
    })
    observer.observe(content)
    return () => observer.disconnect()
  }, [contentRef, pin, syncNear])

  // Viewport resize — dragging the artifact dock divider, toggling it, resizing
  // the window, a phone keyboard closing after a send. Narrowing the viewport
  // rewraps text taller, so a reader parked at the foot drifts up unless we
  // re-pin. Deliberately drops the `active` gate: staying pinned across a
  // layout change is a scroll-stability concern, not a streaming one.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const observer = new ResizeObserver(() => {
      if (gateRef.current.enabled && followingRef.current) pin()
      else syncNear()
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [scrollRef, pin, syncNear])

  // Upward intent, read from the gesture itself rather than from the scroll it
  // will cause. While a stream pins every frame, a wheel notch's smooth scroll
  // or a finger's first few pixels are overwritten by the next pin before they
  // ever leave the threshold — so the reader could not get away from the foot.
  // Disarming on the gesture lets the very first movement stick.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let touch: { x: number; y: number } | null = null
    const movingUp = (target: EventTarget | null) => {
      // Nothing to move up into, or a scroller inside a message (a long tool
      // output) takes the gesture: the transcript itself is not moving.
      if (el.scrollTop <= 0 || el.scrollHeight <= el.clientHeight + 1) return
      if (innerScrollerCanScrollUp(target, el)) return
      gestureUntilRef.current = performance.now() + GESTURE_WINDOW_MS
      if (followingRef.current) setFollowing(false)
    }
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) movingUp(event.target)
    }
    const onTouchStart = (event: TouchEvent) => {
      const point = event.touches[0]
      touch = point ? { x: point.clientX, y: point.clientY } : null
    }
    const onTouchMove = (event: TouchEvent) => {
      const point = event.touches[0]
      if (!point) return
      const previous = touch
      touch = { x: point.clientX, y: point.clientY }
      if (!previous) return
      const dy = point.clientY - previous.y
      // A finger moving DOWN drags the content down, i.e. scrolls up. Mostly
      // horizontal swipes (a wide table, a code fence) are not that.
      if (dy > 1 && dy > Math.abs(point.clientX - previous.x)) movingUp(event.target)
    }
    const onTouchEnd = () => {
      touch = null
    }
    el.addEventListener("wheel", onWheel, { passive: true })
    el.addEventListener("touchstart", onTouchStart, { passive: true })
    el.addEventListener("touchmove", onTouchMove, { passive: true })
    el.addEventListener("touchend", onTouchEnd, { passive: true })
    el.addEventListener("touchcancel", onTouchEnd, { passive: true })
    return () => {
      el.removeEventListener("wheel", onWheel)
      el.removeEventListener("touchstart", onTouchStart)
      el.removeEventListener("touchmove", onTouchMove)
      el.removeEventListener("touchend", onTouchEnd)
      el.removeEventListener("touchcancel", onTouchEnd)
    }
  }, [scrollRef, setFollowing])

  return {
    atBottom: near || (enabled && following),
    following,
    handleScroll,
    handleContentClick,
    pinNow,
    resetToBottom,
    scrollToBottom,
    release,
  }
}
