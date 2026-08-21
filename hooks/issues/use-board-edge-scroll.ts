"use client"

/**
 * Horizontal edge auto-scroll for the issue board's column strip.
 *
 * dnd-kit's built-in auto-scroll walks the scrollable ancestors of the active
 * draggable, and on this board the innermost one is the column's own
 * `overflow-y-auto` — so dragging toward the right edge scrolls the column the
 * card is leaving instead of the board it is crossing. The board pins dnd-kit's
 * x-threshold to 0 and hands the horizontal axis to this hook.
 *
 * The rAF loop keeps running on the LAST known position rather than stopping
 * between pointer events, because the common gesture is to park the card at the
 * edge and wait for the board to come to you — an event-driven nudge would
 * scroll one frame and then stall.
 */

import { useCallback, useEffect, useRef, type RefObject } from "react"

import { boardEdgeScrollDelta, clampScrollDelta } from "@/lib/issues/board-autoscroll"

export interface BoardEdgeScroll {
  /** Feed the dragged card's horizontal centre; null stops the loop. */
  track: (clientX: number | null) => void
  stop: () => void
}

export function useBoardEdgeScroll(ref: RefObject<HTMLElement | null>): BoardEdgeScroll {
  const pointerX = useRef<number | null>(null)
  const frame = useRef<number | null>(null)

  const stop = useCallback(() => {
    pointerX.current = null
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current)
      frame.current = null
    }
  }, [])

  const track = useCallback(
    (clientX: number | null) => {
      if (clientX === null) {
        stop()
        return
      }
      pointerX.current = clientX
      if (frame.current !== null) return

      // Declared inside the starter so it can recurse without a ref — writing
      // a self-referencing ref during render is what `react-hooks/refs` bans,
      // and a drag begins rarely enough that re-creating the closure is free.
      const step = () => {
        frame.current = null
        const element = ref.current
        const x = pointerX.current
        if (!element || x === null) return

        const rect = element.getBoundingClientRect()
        const delta = clampScrollDelta(
          boardEdgeScrollDelta(x, { left: rect.left, right: rect.right }),
          element.scrollLeft,
          element.scrollWidth,
          element.clientWidth
        )
        if (delta !== 0) element.scrollLeft += delta

        // Keep spinning even at delta 0: the card may still be parked in the
        // hot zone, and waiting for another pointer event would stall the
        // scroll exactly when the user is holding still and expecting it.
        frame.current = requestAnimationFrame(step)
      }

      frame.current = requestAnimationFrame(step)
    },
    [ref, stop]
  )

  // A drag interrupted by an unmount (route change, view switch) must not
  // leave a frame scheduled against a detached element.
  useEffect(() => stop, [stop])

  return { track, stop }
}
