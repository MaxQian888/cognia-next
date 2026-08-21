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
 * Deliberately NOT in scope: jumping to a message, the landing flash, the
 * return-here offer, and publishing to `chatViewportStore`. Those are a
 * different concern (navigation, not anchoring) and they are not broken; the
 * hook only has to be the single answer to "who moved the scroll position".
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from "react"

import { useIsomorphicLayoutEffect } from "@/hooks/use-isomorphic-layout-effect"

/**
 * Distance from the foot, in px, still counted as "at the bottom".
 *
 * One line of prose plus its leading is comfortably under this, so a reader who
 * has nudged the wheel a notch is still treated as parked at the tail and keeps
 * following the stream.
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
  /** Whether the reader is parked at the tail. */
  atBottom: boolean
  /** `onScroll` handler for the viewport. Stable identity. */
  handleScroll: () => void
  /**
   * Pin now, honouring the enabled/active/at-bottom gate. For callers that
   * change the transcript's geometry outside a render (re-measuring a
   * virtualizer, handing the live tail back to the virtual list). Must be
   * called from a layout effect to stay in the same frame as the change.
   */
  pinNow: () => void
  /**
   * Jump to the foot and re-arm following, regardless of the current gate —
   * used when opening a conversation, where the previous session's
   * `atBottom: false` would otherwise disarm the whole new thread.
   */
  resetToBottom: () => void
}

export function useStickToBottom({
  scrollRef,
  contentRef,
  enabled,
  active,
  pinKey,
  thresholdPx = AT_BOTTOM_THRESHOLD_PX,
}: UseStickToBottomArgs): StickToBottom {
  const [atBottom, setAtBottom] = useState(true)

  // Latest gate, mirrored into a ref so the observers below (registered once)
  // read current values without re-subscribing every frame.
  //
  // Synced in a LAYOUT effect, declared first so it wins the ordering against
  // every other effect in this hook and in the host component. Within a frame
  // the browser runs layout effects → style/layout → ResizeObserver callbacks →
  // paint, so both readers below always see the gate for the commit they are
  // reacting to.
  const gateRef = useRef({ enabled, active, atBottom })
  useIsomorphicLayoutEffect(() => {
    gateRef.current = { enabled, active, atBottom }
  })

  // `scrollHeight` at the last write. Together with the foot check this makes a
  // repeat pin for unchanged geometry a no-op, so the write count is a function
  // of real growth rather than of how many observers happened to fire.
  const pinnedHeightRef = useRef(-1)

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
    },
    [scrollRef]
  )

  const pinNow = useCallback(() => {
    const gate = gateRef.current
    if (!gate.enabled || !gate.atBottom) return
    pin()
  }, [pin])

  const resetToBottom = useCallback(() => {
    setAtBottom(true)
    gateRef.current = { ...gateRef.current, atBottom: true }
    pin(true)
  }, [pin])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const next = el.scrollHeight - el.scrollTop - el.clientHeight < thresholdPx
    setAtBottom((prev) => (prev === next ? prev : next))
  }, [scrollRef, thresholdPx])

  // Transcript commits. A layout effect, NOT `useEffect`: the whole point is
  // that the correction lands in the frame that painted the growth.
  useIsomorphicLayoutEffect(() => {
    const gate = gateRef.current
    if (!gate.enabled || !gate.active || !gate.atBottom) return
    pin()
  }, [pinKey, active, enabled, pin])

  // Content-box growth. Covers everything the commit above cannot see: markdown
  // that renders across several frames, Shiki finishing a fence, an image
  // decoding, the thinking indicator revealing its skeleton. Observer callbacks
  // are delivered after layout and before paint, so this is already same-frame.
  useEffect(() => {
    const content = contentRef.current
    if (!content) return
    const observer = new ResizeObserver(() => {
      const gate = gateRef.current
      if (!gate.enabled || !gate.active || !gate.atBottom) return
      pin()
    })
    observer.observe(content)
    return () => observer.disconnect()
  }, [contentRef, pin])

  // Viewport resize — dragging the artifact dock divider, toggling it, resizing
  // the window. Narrowing the viewport rewraps text taller, so a reader parked
  // at the foot drifts up unless we re-pin. Deliberately drops the `active`
  // gate: staying pinned across a layout change is a scroll-stability concern,
  // not a streaming one.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const observer = new ResizeObserver(() => {
      const gate = gateRef.current
      if (!gate.enabled || !gate.atBottom) return
      pin()
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [scrollRef, pin])

  return { atBottom, handleScroll, pinNow, resetToBottom }
}
