"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react"

/** Clamp `value` into `[min, max]`. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Which side of the panel the handle sits on. `"left"`/`"right"` resize
 * horizontally; `"top"`/`"bottom"` resize vertically. In each pair, the handle
 * on the far edge grows the panel as the pointer moves away from it.
 */
export type ResizeEdge = "left" | "right" | "top" | "bottom"

export interface UseEdgeResizeOptions {
  /**
   * Current (controlled) size, in the caller's own unit — px by default, or
   * percent when {@link UseEdgeResizeOptions.scale} is set. Owned by the caller
   * (e.g. a store) and passed back in.
   */
  width: number
  /** Lower bound, same unit as `width`. */
  min: number
  /** Upper bound, same unit as `width`. */
  max: number
  /** Called with the next clamped size during a drag or arrow-key nudge. */
  onChange: (width: number) => void
  /** Called on double-click of the handle — typically resets to a default. */
  onReset?: () => void
  /** Arrow-key step, same unit as `width`. Defaults to 16. */
  step?: number
  /**
   * Which side the handle sits on. `"right"` (default): dragging right grows the
   * panel. `"left"`: dragging right shrinks it (handle on the panel's left edge).
   * `"bottom"` / `"top"` are the vertical equivalents.
   */
  edge?: ResizeEdge
  /**
   * Caller units per CSS pixel. Defaults to `1` (the size is in px). A panel
   * sized as a percentage of the viewport passes `100 / window.innerWidth` (or
   * `innerHeight`) so a pointer delta converts into the same unit as `width`.
   */
  scale?: number
}

export interface UseEdgeResizeResult {
  /** True while a pointer drag is in progress. */
  dragging: boolean
  onPointerDown: (e: ReactPointerEvent) => void
  onPointerMove: (e: ReactPointerEvent) => void
  onPointerUp: (e: ReactPointerEvent) => void
  onPointerCancel: (e: ReactPointerEvent) => void
  onLostPointerCapture: (e: ReactPointerEvent) => void
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
  scale = 1,
}: UseEdgeResizeOptions): UseEdgeResizeResult {
  const vertical = edge === "top" || edge === "bottom"
  // `"left"` and `"top"` handles sit on the near edge, so the panel grows as the
  // pointer moves toward negative coordinates.
  const inverted = edge === "left" || edge === "top"
  const startRef = useRef<{
    x: number
    y: number
    width: number
    pointerId: number
    target: Element
  } | null>(null)
  const [dragging, setDragging] = useState(false)

  const onPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      if ((e.button != null && e.button !== 0) || startRef.current) return
      e.preventDefault()
      const target = e.currentTarget as Element
      if (typeof target.setPointerCapture === "function") {
        try {
          target.setPointerCapture(e.pointerId)
        } catch {
          // jsdom / unsupported — pointer capture is a best-effort nicety.
        }
      }
      startRef.current = { x: e.clientX, y: e.clientY, width, pointerId: e.pointerId, target }
      setDragging(true)
    },
    [width]
  )

  const onPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      const start = startRef.current
      if (!start || e.pointerId !== start.pointerId) return
      const delta = (vertical ? e.clientY - start.y : e.clientX - start.x) * scale
      const raw = inverted ? start.width - delta : start.width + delta
      onChange(clamp(raw, min, max))
    },
    [vertical, inverted, scale, min, max, onChange]
  )

  const finishDrag = useCallback(() => {
    const start = startRef.current
    if (!start) return
    startRef.current = null
    setDragging(false)
    try {
      start.target.releasePointerCapture?.(start.pointerId)
    } catch {
      // Capture may already be lost after cancellation or window blur.
    }
  }, [])

  const endDrag = useCallback(
    (e: ReactPointerEvent) => {
      if (startRef.current?.pointerId === e.pointerId) finishDrag()
    },
    [finishDrag]
  )

  useEffect(() => {
    if (!dragging) return
    const previous = document.body.getAttribute("data-edge-resizing")
    document.body.setAttribute("data-edge-resizing", vertical ? "vertical" : "horizontal")
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !startRef.current) return
      event.preventDefault()
      onChange(clamp(startRef.current.width, min, max))
      finishDrag()
    }
    // Native listeners also protect consumers that only bind down/move/up.
    const target = startRef.current?.target
    const cancelled = (event: Event) => {
      if ((event as PointerEvent).pointerId === startRef.current?.pointerId) finishDrag()
    }
    target?.addEventListener?.("lostpointercapture", cancelled)
    target?.addEventListener?.("pointercancel", cancelled)
    window.addEventListener("blur", finishDrag)
    window.addEventListener("keydown", cancel)
    return () => {
      window.removeEventListener("blur", finishDrag)
      window.removeEventListener("keydown", cancel)
      target?.removeEventListener?.("lostpointercapture", cancelled)
      target?.removeEventListener?.("pointercancel", cancelled)
      if (previous === null) document.body.removeAttribute("data-edge-resizing")
      else document.body.setAttribute("data-edge-resizing", previous)
    }
  }, [dragging, vertical, finishDrag, onChange, min, max])

  useEffect(
    () => () => {
      const start = startRef.current
      startRef.current = null
      try {
        start?.target.releasePointerCapture?.(start.pointerId)
      } catch {
        // Unmount can follow the browser releasing capture itself.
      }
    },
    []
  )

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent) => {
      const [grow, shrink] = vertical
        ? inverted
          ? (["ArrowUp", "ArrowDown"] as const)
          : (["ArrowDown", "ArrowUp"] as const)
        : inverted
          ? (["ArrowLeft", "ArrowRight"] as const)
          : (["ArrowRight", "ArrowLeft"] as const)
      const nudge = e.shiftKey ? step / 4 : step
      if (e.key === grow) {
        e.preventDefault()
        onChange(clamp(width + nudge, min, max))
      } else if (e.key === shrink) {
        e.preventDefault()
        onChange(clamp(width - nudge, min, max))
      } else if (e.key === "Home" || e.key === "End") {
        e.preventDefault()
        onChange(e.key === "Home" ? min : max)
      } else if ((e.key === "Enter" || e.key === " ") && onReset) {
        e.preventDefault()
        onReset()
      }
    },
    [vertical, inverted, width, step, min, max, onChange, onReset]
  )

  const onDoubleClick = useCallback(() => onReset?.(), [onReset])

  return {
    dragging,
    onPointerDown,
    onPointerMove,
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
    onLostPointerCapture: endDrag,
    onKeyDown,
    onDoubleClick,
  }
}
