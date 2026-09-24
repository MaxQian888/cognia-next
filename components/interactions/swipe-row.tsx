"use client"

/**
 * `<SwipeRow />` (Wave 2.3).
 *
 * Horizontal swipe-to-reveal row. The user drags the row left to expose
 * `rightActions` (or right to expose `leftActions`). Releasing snaps the
 * row to either fully open (if dragged past `commitThreshold`) or back to
 * closed. Tapping outside the actions or any visible action button closes
 * the row, and so does tapping the row itself while it is open — that tap
 * means "put it back", never "open what's underneath".
 *
 * Pure CSS transform; no framer-motion dependency. Touch + mouse pointer
 * events both supported. The wrapper makes no assumption about the
 * underlying row structure — pass any node as children.
 *
 * Gesture contract:
 *   - Nothing moves until the pointer has travelled {@link LONG_PRESS_TOLERANCE_PX}
 *     horizontally. Sharing the long-press tolerance is deliberate: the same
 *     pointermove that starts a drag here has already cancelled a pending
 *     `<LongPress>` inside the row (the child sees the event first), so a row
 *     can never both slide and open its long-press menu.
 *   - Vertical intent wins: a pointer that travels further down than across
 *     before the slop is abandoned, and the list keeps scrolling.
 *   - Once a drag starts the foreground captures the pointer, so a mouse
 *     released outside the row still ends the drag instead of leaving the row
 *     glued to the cursor.
 *   - A drag never doubles as a click on the row underneath.
 *
 * The wrapper carries `data-swipe-row`, which `useEdgeSwipe` reads to leave a
 * drag that starts on a row to the row (see `hooks/ui/use-edge-swipe.ts`).
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { useReducedMotion } from "motion/react"

import { Button } from "@/components/ui/button"
import { LONG_PRESS_TOLERANCE_PX } from "@/components/interactions/long-press"
import { impact } from "@/lib/capacitor/haptics"
import { cn } from "@/lib/utils"

export interface SwipeAction {
  id: string
  label: string
  icon?: React.ReactNode
  /** Tailwind classes for the action button background. */
  className?: string
  destructive?: boolean
  onSelect: () => void
}

export interface SwipeRowProps {
  children: React.ReactNode
  leftActions?: SwipeAction[]
  rightActions?: SwipeAction[]
  /** Width per action, in pixels. */
  actionWidth?: number
  /** Distance past which the row commits to open on release. */
  commitThreshold?: number
  /** Optional className applied to the outer wrapper. */
  className?: string
  /** Suppress haptic feedback (used in tests). */
  silent?: boolean
}

type Side = "left" | "right" | null

/** Horizontal travel before a press becomes a drag. */
export const SWIPE_ROW_SLOP_PX = LONG_PRESS_TOLERANCE_PX

const NO_ACTIONS: SwipeAction[] = []

export function SwipeRow({
  children,
  leftActions = NO_ACTIONS,
  rightActions = NO_ACTIONS,
  actionWidth = 72,
  commitThreshold = 0.5,
  className,
  silent = false,
}: SwipeRowProps) {
  const [translate, setTranslate] = useState(0)
  const [openSide, setOpenSide] = useState<Side>(null)
  const [isDragging, setIsDragging] = useState(false)
  // OS preference only: the app's own Reduce-motion setting is enforced by the
  // global `html.reduce-motion *` rule in `app/globals.css`, whose
  // `transition-duration: 1ms !important` outranks the inline transition below.
  const reduce = useReducedMotion()

  const startRef = useRef<{ x: number; y: number; pointerId: number } | null>(null)
  const startTranslateRef = useRef(0)
  /** Press is live (pointer down, not yet released or abandoned). */
  const pressedRef = useRef(false)
  /** Horizontal travel passed the slop — this press is a drag now. */
  const draggingRef = useRef(false)
  /** The row was open when this press began, so releasing it closes the row. */
  const openAtDownRef = useRef(false)
  /** Swallow the click the browser synthesizes after a drag / a closing tap. */
  const suppressClickRef = useRef(false)
  /** Mirror of `translate` updated synchronously inside handlers so
   *  pointerUp sees the latest value despite React state batching. */
  const liveTranslateRef = useRef(0)

  const leftWidth = leftActions.length * actionWidth
  const rightWidth = rightActions.length * actionWidth

  const close = useCallback(() => {
    liveTranslateRef.current = 0
    setTranslate(0)
    setOpenSide(null)
  }, [])

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // A secondary button is a context menu, never a drag.
    if (e.pointerType === "mouse" && e.button !== 0) return
    startRef.current = { x: e.clientX, y: e.clientY, pointerId: e.pointerId }
    startTranslateRef.current = liveTranslateRef.current
    pressedRef.current = true
    draggingRef.current = false
    openAtDownRef.current = openSide !== null
    suppressClickRef.current = false
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = startRef.current
    if (!pressedRef.current || !start) return
    const dx = e.clientX - start.x
    const dy = e.clientY - start.y
    if (!draggingRef.current) {
      if (Math.abs(dx) <= SWIPE_ROW_SLOP_PX) {
        // Scrolling the list, not swiping the row: let the press go so a later
        // sideways wobble in the same scroll cannot start a drag.
        if (Math.abs(dy) > SWIPE_ROW_SLOP_PX) pressedRef.current = false
        return
      }
      if (Math.abs(dy) > Math.abs(dx)) {
        pressedRef.current = false
        return
      }
      draggingRef.current = true
      setIsDragging(true)
      const target = e.currentTarget
      try {
        target.setPointerCapture?.(start.pointerId)
      } catch {
        // The pointer can already be gone (released between events); the drag
        // still ends through pointerup / lostpointercapture.
      }
    }
    let next = startTranslateRef.current + dx
    if (leftActions.length === 0) next = Math.min(0, next)
    if (rightActions.length === 0) next = Math.max(0, next)
    next = Math.min(leftWidth, Math.max(-rightWidth, next))
    liveTranslateRef.current = next
    setTranslate(next)
  }

  const settle = () => {
    const current = liveTranslateRef.current
    if (current < -rightWidth * commitThreshold && rightActions.length > 0) {
      liveTranslateRef.current = -rightWidth
      setTranslate(-rightWidth)
      setOpenSide("right")
      if (!silent) void impact("light")
    } else if (current > leftWidth * commitThreshold && leftActions.length > 0) {
      liveTranslateRef.current = leftWidth
      setTranslate(leftWidth)
      setOpenSide("left")
      if (!silent) void impact("light")
    } else {
      close()
    }
  }

  const endPress = (cancelled: boolean) => {
    const wasPressed = pressedRef.current
    const wasDragging = draggingRef.current
    pressedRef.current = false
    draggingRef.current = false
    startRef.current = null
    if (wasDragging) {
      setIsDragging(false)
      suppressClickRef.current = true
      settle()
      return
    }
    // A plain tap on an open row closes it. The click that follows is the
    // same tap, so it must not also open the conversation underneath.
    if (wasPressed && !cancelled && openAtDownRef.current) {
      suppressClickRef.current = true
      close()
    }
  }

  const onClickCapture = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!suppressClickRef.current) return
    suppressClickRef.current = false
    e.preventDefault()
    e.stopPropagation()
  }

  // Close when pressing outside the row.
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (openSide === null) return
    const handler = (event: PointerEvent) => {
      if (!wrapperRef.current) return
      if (event.target instanceof Node && wrapperRef.current.contains(event.target)) return
      close()
    }
    window.addEventListener("pointerdown", handler)
    return () => window.removeEventListener("pointerdown", handler)
  }, [openSide, close])

  const renderAction = (action: SwipeAction, revealed: boolean) => (
    <Button
      key={action.id}
      type="button"
      variant={action.destructive ? "destructive" : "secondary"}
      // `inert` on the strip already removes a hidden action from the tab
      // order; the explicit tabIndex covers WebViews that predate `inert`.
      tabIndex={revealed ? undefined : -1}
      onClick={() => {
        action.onSelect()
        close()
      }}
      data-testid={`swipe-action-${action.id}`}
      className={cn(
        // Override Button's default `inline-flex items-center` to a
        // vertical icon+label stack that fills the swipe-row reveal.
        "h-full flex-col items-center justify-center gap-0.5 rounded-none text-xs font-medium",
        action.className
      )}
      style={{ width: `${actionWidth}px` }}
    >
      {action.icon ? <span aria-hidden="true">{action.icon}</span> : null}
      <span className="max-w-full truncate px-1">{action.label}</span>
    </Button>
  )

  // An action is only reachable once its side is fully open. While closed (or
  // mid-drag) the strips sit behind the foreground, and a keyboard or screen
  // reader landing on an invisible "Delete" is the bug `inert` prevents.
  const leftRevealed = openSide === "left"
  const rightRevealed = openSide === "right"

  return (
    <div
      ref={wrapperRef}
      className={cn("relative overflow-hidden", className)}
      data-testid="swipe-row"
      data-swipe-row=""
      data-open={openSide ?? "closed"}
    >
      {/* Left actions (swiped right reveals these). */}
      {leftActions.length > 0 ? (
        <div
          className="absolute inset-y-0 left-0 flex"
          style={{ width: `${leftWidth}px` }}
          aria-hidden={!leftRevealed}
          inert={!leftRevealed}
          data-testid="swipe-row-left-actions"
        >
          {leftActions.map((action) => renderAction(action, leftRevealed))}
        </div>
      ) : null}
      {/* Right actions (swiped left reveals these). */}
      {rightActions.length > 0 ? (
        <div
          className="absolute inset-y-0 right-0 flex"
          style={{ width: `${rightWidth}px` }}
          aria-hidden={!rightRevealed}
          inert={!rightRevealed}
          data-testid="swipe-row-right-actions"
        >
          {rightActions.map((action) => renderAction(action, rightRevealed))}
        </div>
      ) : null}
      {/* Foreground row. */}
      <div
        className="relative bg-background"
        style={{
          transform: `translateX(${translate}px)`,
          // Snap (no animation) while dragging OR when the OS asks for
          // reduced motion; otherwise ease back / open over 200 ms.
          transition: isDragging || reduce ? "none" : "transform 200ms ease-out",
          touchAction: "pan-y",
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => endPress(false)}
        onPointerCancel={() => endPress(true)}
        onLostPointerCapture={() => {
          if (draggingRef.current) endPress(false)
        }}
        onClickCapture={onClickCapture}
        // A keyboard activation is never the tail of a drag.
        onKeyDownCapture={() => {
          suppressClickRef.current = false
        }}
        data-testid="swipe-row-foreground"
      >
        {children}
      </div>
    </div>
  )
}
