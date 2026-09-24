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
 * Once the press has fired, the release that ends it is not also a tap: the
 * click the browser synthesizes on pointerup is swallowed (capture phase, so
 * the child's onClick never runs), and so is the platform context menu /
 * selection callout a held touch would otherwise raise on top of whatever
 * `onLongPress` opened. Without this, a long-press on a list row opened its
 * action menu AND navigated into the row the moment the finger lifted.
 *
 * Used by:
 *   - chat-room message rows → action sheet
 *   - chat-list rows → tap=open / long-press=context menu
 */

import { useCallback, useEffect, useRef } from "react"

import { impact } from "@/lib/capacitor/haptics"

/**
 * Hold time and movement tolerance for a long press, exported so a surface
 * that cannot use the wrapper component still presses at the same pace.
 *
 * The workflow canvas is one: `<LongPress>` renders a `<span>` and hands its
 * callback no event, and the canvas needs both a block-level box and the
 * pressed element in order to tell a node from an edge from empty space.
 */
export const LONG_PRESS_DELAY_MS = 500
export const LONG_PRESS_TOLERANCE_PX = 10

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
  delayMs = LONG_PRESS_DELAY_MS,
  tolerancePx = LONG_PRESS_TOLERANCE_PX,
  silent = false,
  className,
  children,
}: LongPressProps) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startPosRef = useRef<{ x: number; y: number } | null>(null)
  const firedRef = useRef(false)
  /**
   * The current press already fired, so the click (and context menu) it ends
   * with belong to the long-press. Survives `cancel()` on pointerup because
   * the click is dispatched after it; cleared by the next press or keydown.
   */
  const consumedRef = useRef(false)

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
    consumedRef.current = false
    // A secondary mouse button opens the context menu on its own; timing it as
    // a hold would fire a second time when the menu closes.
    if (e.pointerType === "mouse" && e.button !== 0) return
    startPosRef.current = { x: e.clientX, y: e.clientY }
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      firedRef.current = true
      consumedRef.current = true
      if (!silent) {
        void impact("medium")
      }
      onLongPress()
    }, delayMs)
  }

  const swallowIfConsumed = (e: React.SyntheticEvent) => {
    if (!consumedRef.current) return
    e.preventDefault()
    e.stopPropagation()
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
      onClickCapture={(e) => {
        if (!consumedRef.current) return
        consumedRef.current = false
        e.preventDefault()
        e.stopPropagation()
      }}
      // Android raises `contextmenu` for a held touch at about the same moment
      // the timer fires; iOS raises its callout. Either one on top of the
      // menu `onLongPress` just opened is a second, competing menu.
      onContextMenuCapture={swallowIfConsumed}
      onKeyDownCapture={() => {
        consumedRef.current = false
      }}
      data-long-press-active="true"
    >
      {children}
    </span>
  )
}
