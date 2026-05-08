"use client"

/**
 * `<LongPress />` (Wave 2.3).
 *
 * Wraps a child node in a span that owns pointer handlers. Fires
 * `onLongPress` after the user holds a pointer for `delayMs` (default
 * 500 ms). Movement past `tolerancePx` cancels the gesture so it can't
 * misfire when the user starts a scroll. The wrapper deliberately
 * leaves the child's own onClick / pointer handlers intact (events
 * bubble up).
 *
 * Used by:
 *   - chat-room message rows → action sheet
 *   - chat-list rows → tap=open / long-press=context menu
 */

import { useCallback, useEffect, useRef } from "react"

import { impact } from "@/lib/capacitor/haptics"

export interface LongPressProps {
  onLongPress: () => void
  /** Hold time before the gesture fires (ms). */
  delayMs?: number
  /** Movement tolerance in pixels. */
  tolerancePx?: number
  /** Disable the haptic on fire (used in tests). */
  silent?: boolean
  /** Optional className applied to the wrapping span. */
  className?: string
  children: React.ReactNode
}

export function LongPress({
  onLongPress,
  delayMs = 500,
  tolerancePx = 10,
  silent = false,
  className,
  children,
}: LongPressProps) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startPosRef = useRef<{ x: number; y: number } | null>(null)
  const firedRef = useRef(false)

  const cancel = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    startPosRef.current = null
    firedRef.current = false
  }, [])

  useEffect(() => () => cancel(), [cancel])

  const start = (e: React.PointerEvent<HTMLElement>) => {
    cancel()
    startPosRef.current = { x: e.clientX, y: e.clientY }
    timerRef.current = setTimeout(() => {
      firedRef.current = true
      if (!silent) {
        void impact("medium")
      }
      onLongPress()
    }, delayMs)
  }

  const move = (e: React.PointerEvent<HTMLElement>) => {
    if (!startPosRef.current || timerRef.current === null) return
    const dx = e.clientX - startPosRef.current.x
    const dy = e.clientY - startPosRef.current.y
    if (Math.hypot(dx, dy) > tolerancePx) {
      cancel()
    }
  }

  return (
    <span
      className={className}
      onPointerDown={start}
      onPointerUp={cancel}
      onPointerMove={move}
      onPointerCancel={cancel}
      onPointerLeave={cancel}
      data-long-press-active="true"
    >
      {children}
    </span>
  )
}
