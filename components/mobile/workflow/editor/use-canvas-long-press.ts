"use client"

/**
 * Long-press on the workflow canvas, resolved to what was actually pressed.
 *
 * The desktop canvas reaches its context menu through `contextmenu`, which a
 * touch device fires inconsistently (and not at all inside some WebViews), so
 * on a phone the only way to delete a node was to open its inspector and find
 * the button. Every other destructive gesture in this app is a long press.
 *
 * `<LongPress>` cannot serve here for two reasons: it renders a `<span>`, and
 * it hands its callback no event, while the canvas needs a block-level box and
 * the pressed element to tell a node from an edge from empty space. The timing
 * comes from the same constants so the gesture feels identical.
 */

import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react"

import {
  LONG_PRESS_DELAY_MS,
  LONG_PRESS_TOLERANCE_PX,
} from "@/components/interactions/long-press"
import { impact } from "@/lib/capacitor/haptics"

export type CanvasPressTarget =
  | { kind: "node"; id: string }
  | { kind: "edge"; id: string }
  | { kind: "pane" }

/**
 * Which graph element an event landed on.
 *
 * React Flow stamps `data-id` on both node and edge wrappers, so the DOM is the
 * authority. Exported for the test, which is the only way to pin the selector
 * pair against a React Flow upgrade.
 */
export function resolvePressTarget(target: EventTarget | null): CanvasPressTarget {
  if (!(target instanceof Element)) return { kind: "pane" }
  const node = target.closest<HTMLElement>(".react-flow__node")
  if (node?.dataset.id) return { kind: "node", id: node.dataset.id }
  const edge = target.closest<HTMLElement>(".react-flow__edge")
  if (edge?.dataset.id) return { kind: "edge", id: edge.dataset.id }
  return { kind: "pane" }
}

export interface CanvasLongPressOptions {
  onLongPress: (target: CanvasPressTarget) => void
  /** Skip the haptic. Tests pass true. */
  silent?: boolean
  /** Off in read mode, where there is nothing destructive to offer. */
  enabled?: boolean
}

export interface CanvasLongPressHandlers {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerUp: () => void
  onPointerCancel: () => void
  onPointerLeave: () => void
}

export function useCanvasLongPress({
  onLongPress,
  silent = false,
  enabled = true,
}: CanvasLongPressOptions): CanvasLongPressHandlers {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const origin = useRef<{ x: number; y: number } | null>(null)

  const cancel = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
    origin.current = null
  }, [])

  useEffect(() => () => cancel(), [cancel])

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      cancel()
      if (!enabled) return
      // A second finger means pinch-zoom, never a press.
      if (e.isPrimary === false) return
      const target = resolvePressTarget(e.target)
      origin.current = { x: e.clientX, y: e.clientY }
      timer.current = setTimeout(() => {
        timer.current = null
        if (!silent) void impact("medium")
        onLongPress(target)
      }, LONG_PRESS_DELAY_MS)
    },
    [cancel, enabled, onLongPress, silent]
  )

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (!origin.current || timer.current === null) return
      const dx = e.clientX - origin.current.x
      const dy = e.clientY - origin.current.y
      // Panning and node-dragging both start as a press. Moving past the
      // tolerance is what says this is a drag, not a menu.
      if (Math.hypot(dx, dy) > LONG_PRESS_TOLERANCE_PX) cancel()
    },
    [cancel]
  )

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onPointerLeave: cancel,
  }
}
