"use client"

/**
 * Edge-swipe gesture detection for touch surfaces.
 *
 * The compact shell has no window chrome to hang a sidebar toggle off, so the
 * conversation rail is summoned the way every mobile drawer is: a finger
 * dragged in from the window edge. This hook is the detector for both halves
 * of that gesture. `onOpen` fires for a drag that *starts* inside the edge hot
 * zone and travels inward. `onClose` fires for a drag that travels back out
 * toward the same edge from anywhere. The caller owns the open/closed state and
 * passes only the handler that makes sense for it, which is what keeps the hook
 * free of any knowledge of the surface it drives.
 *
 * Deliberately listener-only: it never calls `preventDefault`, so a vertical
 * scroll inside the drawer is untouched and the listeners stay `passive`. A
 * gesture is rejected the moment its off-axis travel passes `slop`, so a
 * diagonal flick while scrolling a list cannot open anything.
 */

import { useEffect, useRef } from "react"

export type SwipeEdge = "left" | "right"

export interface EdgeSwipeOptions {
  /** Which window edge an opening swipe starts from. */
  edge: SwipeEdge
  /** Master switch. `false` detaches every listener. Default `true`. */
  enabled?: boolean
  /** A swipe that started within {@link edgeSize} of `edge` moved inward past {@link threshold}. */
  onOpen?: () => void
  /** A swipe (from anywhere) moved outward, toward `edge`, past {@link threshold}. */
  onClose?: () => void
  /** Width of the edge hot zone in px. */
  edgeSize?: number
  /** Inward/outward travel required, in px. */
  threshold?: number
  /** Off-axis travel that disqualifies the gesture, in px. */
  slop?: number
}

export const EDGE_SWIPE_ZONE = 24
export const EDGE_SWIPE_THRESHOLD = 56
export const EDGE_SWIPE_SLOP = 44

interface Tracked {
  x: number
  y: number
  /** Started inside the edge hot zone, so an opening swipe is possible. */
  fromEdge: boolean
  /** Off-axis travel already exceeded `slop`, so the gesture is dead. */
  rejected: boolean
}

export function useEdgeSwipe({
  edge,
  enabled = true,
  onOpen,
  onClose,
  edgeSize = EDGE_SWIPE_ZONE,
  threshold = EDGE_SWIPE_THRESHOLD,
  slop = EDGE_SWIPE_SLOP,
}: EdgeSwipeOptions): void {
  // Handlers are read through a ref so a caller passing inline arrows does not
  // re-attach four window listeners on every render of a list that repaints
  // constantly (which the conversation sidebar does). Written after commit
  // rather than during render: a ref is not render output, and a touch cannot
  // land between the two anyway.
  const handlers = useRef({ onOpen, onClose })
  useEffect(() => {
    handlers.current = { onOpen, onClose }
  })

  useEffect(() => {
    if (!enabled) return
    if (typeof window === "undefined") return

    let tracked: Tracked | null = null

    const start = (event: TouchEvent) => {
      // Multi-touch is a pinch/zoom, never a drawer gesture.
      if (event.touches.length !== 1) {
        tracked = null
        return
      }
      const touch = event.touches[0]
      if (!touch) return
      const fromLeft = touch.clientX <= edgeSize
      const fromRight = touch.clientX >= window.innerWidth - edgeSize
      tracked = {
        x: touch.clientX,
        y: touch.clientY,
        fromEdge: edge === "left" ? fromLeft : fromRight,
        rejected: false,
      }
    }

    const move = (event: TouchEvent) => {
      if (!tracked || tracked.rejected) return
      if (event.touches.length !== 1) {
        tracked.rejected = true
        return
      }
      const touch = event.touches[0]
      if (!touch) return
      const dx = touch.clientX - tracked.x
      const dy = touch.clientY - tracked.y
      // Vertical intent wins outright: the list under the finger scrolls, and
      // a drawer that opens halfway through a scroll is worse than no gesture.
      if (Math.abs(dy) > slop && Math.abs(dy) > Math.abs(dx)) tracked.rejected = true
    }

    const end = (event: TouchEvent) => {
      const current = tracked
      tracked = null
      if (!current || current.rejected) return
      const touch = event.changedTouches[0]
      if (!touch) return
      const dx = touch.clientX - current.x
      const dy = touch.clientY - current.y
      if (Math.abs(dy) > slop) return
      // "Inward" is away from the edge the drawer lives on.
      const inward = edge === "left" ? dx : -dx
      if (current.fromEdge && inward >= threshold) {
        handlers.current.onOpen?.()
        return
      }
      if (-inward >= threshold) handlers.current.onClose?.()
    }

    const cancel = () => {
      tracked = null
    }

    window.addEventListener("touchstart", start, { passive: true })
    window.addEventListener("touchmove", move, { passive: true })
    window.addEventListener("touchend", end, { passive: true })
    window.addEventListener("touchcancel", cancel, { passive: true })
    return () => {
      window.removeEventListener("touchstart", start)
      window.removeEventListener("touchmove", move)
      window.removeEventListener("touchend", end)
      window.removeEventListener("touchcancel", cancel)
    }
  }, [enabled, edge, edgeSize, threshold, slop])
}
