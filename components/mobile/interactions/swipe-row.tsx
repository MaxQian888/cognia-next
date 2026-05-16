"use client"

/**
 * `<SwipeRow />` (Wave 2.3).
 *
 * Horizontal swipe-to-reveal row. The user drags the row left to expose
 * `rightActions` (or right to expose `leftActions`). Releasing snaps the
 * row to either fully open (if dragged past `commitThreshold`) or back to
 * closed. Tapping outside the actions or any visible action button closes
 * the row.
 *
 * Pure CSS transform; no framer-motion dependency. Touch + mouse pointer
 * events both supported. The wrapper makes no assumption about the
 * underlying row structure — pass any node as children.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { useReducedMotion } from "motion/react"

import { Button } from "@/components/ui/button"
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

export function SwipeRow({
  children,
  leftActions = [],
  rightActions = [],
  actionWidth = 72,
  commitThreshold = 0.5,
  className,
  silent = false,
}: SwipeRowProps) {
  const [translate, setTranslate] = useState(0)
  const [openSide, setOpenSide] = useState<Side>(null)
  const [isDragging, setIsDragging] = useState(false)
  const reduce = useReducedMotion()

  const startXRef = useRef<number | null>(null)
  const startTranslateRef = useRef(0)
  const draggingRef = useRef(false)
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
    startXRef.current = e.clientX
    startTranslateRef.current = translate
    draggingRef.current = true
    setIsDragging(true)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current || startXRef.current === null) return
    const dx = e.clientX - startXRef.current
    let next = startTranslateRef.current + dx
    if (leftActions.length === 0) next = Math.min(0, next)
    if (rightActions.length === 0) next = Math.max(0, next)
    next = Math.min(leftWidth, Math.max(-rightWidth, next))
    liveTranslateRef.current = next
    setTranslate(next)
  }

  const onPointerUp = () => {
    if (!draggingRef.current) return
    draggingRef.current = false
    setIsDragging(false)
    startXRef.current = null
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

  // Close when clicking outside the row.
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

  const renderAction = (action: SwipeAction) => (
    <Button
      key={action.id}
      type="button"
      variant={action.destructive ? "destructive" : "secondary"}
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
      <span>{action.label}</span>
    </Button>
  )

  return (
    <div
      ref={wrapperRef}
      className={cn("relative overflow-hidden", className)}
      data-testid="swipe-row"
      data-open={openSide ?? "closed"}
    >
      {/* Left actions (swiped right reveals these). */}
      <div
        className="absolute inset-y-0 left-0 flex"
        style={{ width: `${leftWidth}px` }}
        aria-hidden={translate <= 0}
      >
        {leftActions.map(renderAction)}
      </div>
      {/* Right actions (swiped left reveals these). */}
      <div
        className="absolute inset-y-0 right-0 flex"
        style={{ width: `${rightWidth}px` }}
        aria-hidden={translate >= 0}
      >
        {rightActions.map(renderAction)}
      </div>
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
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        data-testid="swipe-row-foreground"
      >
        {children}
      </div>
    </div>
  )
}
