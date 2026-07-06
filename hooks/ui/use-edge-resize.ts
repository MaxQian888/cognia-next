"use client"

import { useCallback, useRef, useState } from "react"
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react"

/** Clamp `value` into `[min, max]`. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export interface UseEdgeResizeOptions {
  /** Current (controlled) width in px — owned by the caller (e.g. a store). */
  width: number
  /** Lower bound in px. */
  min: number
  /** Upper bound in px. */
  max: number
  /** Called with the next clamped width during a drag or arrow-key nudge. */
  onChange: (width: number) => void
  /** Called on double-click of the handle — typically resets to a default. */
  onReset?: () => void
  /** Arrow-key step in px. Defaults to 16. */
  step?: number
  /**
   * Which side the handle sits on. `"right"` (default): dragging right grows the
   * panel. `"left"`: dragging right shrinks it (handle on the panel's left edge).
   */
  edge?: "left" | "right"
}

export interface UseEdgeResizeResult {
  /** True while a pointer drag is in progress. */
  dragging: boolean
  onPointerDown: (e: ReactPointerEvent) => void
  onPointerMove: (e: ReactPointerEvent) => void
  onPointerUp: (e: ReactPointerEvent) => void
  onKeyDown: (e: ReactKeyboardEvent) => void
  onDoubleClick: () => void
}

/**
 * Controller for a draggable resize handle on the edge of a panel. The width is
 * *controlled* — the caller stores/persists it and passes it back in; this hook
 * only computes the next value from pointer / keyboard input and calls
 * `onChange`. Uses pointer capture so the drag keeps tracking when the cursor
 * leaves the thin handle. Pair with a focusable `role="separator"` element.
 */
export function useEdgeResize({
  width,
  min,
  max,
  onChange,
  onReset,
  step = 16,
  edge = "right",
}: UseEdgeResizeOptions): UseEdgeResizeResult {
  const startRef = useRef<{ x: number; width: number } | null>(null)
  const [dragging, setDragging] = useState(false)

  const onPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      e.preventDefault()
      const target = e.currentTarget as Element
      if (typeof target.setPointerCapture === "function") {
        try {
          target.setPointerCapture(e.pointerId)
        } catch {
          // jsdom / unsupported — pointer capture is a best-effort nicety.
        }
      }
      startRef.current = { x: e.clientX, width }
      setDragging(true)
    },
    [width]
  )

  const onPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      const start = startRef.current
      if (!start) return
      const delta = e.clientX - start.x
      const raw = edge === "left" ? start.width - delta : start.width + delta
      onChange(clamp(raw, min, max))
    },
    [edge, min, max, onChange]
  )

  const endDrag = useCallback((e: ReactPointerEvent) => {
    if (!startRef.current) return
    startRef.current = null
    setDragging(false)
    const target = e.currentTarget as Element
    if (typeof target.releasePointerCapture === "function") {
      try {
        target.releasePointerCapture(e.pointerId)
      } catch {
        // best-effort — see onPointerDown.
      }
    }
  }, [])

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent) => {
      const grow = edge === "left" ? "ArrowLeft" : "ArrowRight"
      const shrink = edge === "left" ? "ArrowRight" : "ArrowLeft"
      if (e.key === grow) {
        e.preventDefault()
        onChange(clamp(width + step, min, max))
      } else if (e.key === shrink) {
        e.preventDefault()
        onChange(clamp(width - step, min, max))
      } else if ((e.key === "Enter" || e.key === " ") && onReset) {
        e.preventDefault()
        onReset()
      }
    },
    [edge, width, step, min, max, onChange, onReset]
  )

  const onDoubleClick = useCallback(() => onReset?.(), [onReset])

  return { dragging, onPointerDown, onPointerMove, onPointerUp: endDrag, onKeyDown, onDoubleClick }
}
