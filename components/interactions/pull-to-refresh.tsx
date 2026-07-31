"use client"

/**
 * `<PullToRefresh />` (Wave 2.3).
 *
 * Wraps a scrollable list and triggers `onRefresh()` when the user pulls
 * the top of the content downward by more than `triggerPx`. While the
 * refresh handler is pending, a spinner row is shown above the list.
 *
 * Implementation: pure pointer events + CSS transform. No framer-motion.
 * The wrapper assumes the immediate child handles its own scrolling — we
 * only intercept when the child is scrolled to the top.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { Loader2Icon } from "lucide-react"
import { useReducedMotion } from "motion/react"

import { impact } from "@/lib/capacitor/haptics"
import { cn } from "@/lib/utils"

export interface PullToRefreshProps {
  children: React.ReactNode
  onRefresh: () => Promise<void> | void
  /** Distance the user must pull (px) before the refresh fires. */
  triggerPx?: number
  /** Max travel distance (px). */
  maxPx?: number
  className?: string
  /** Suppress haptic feedback (tests). */
  silent?: boolean
  /**
   * Reports the scrollable container element — the wrapper IS the scroller,
   * so virtualized children need it to attach a virtualizer (store it in
   * state and hand it to `getScrollElement`).
   */
  onScrollElChange?: (el: HTMLDivElement | null) => void
}

export function PullToRefresh({
  children,
  onRefresh,
  triggerPx = 64,
  maxPx = 96,
  className,
  silent = false,
  onScrollElChange,
}: PullToRefreshProps) {
  const [translate, setTranslate] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const startYRef = useRef<number | null>(null)
  const dragRef = useRef(false)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const firedHapticRef = useRef(false)
  const liveTranslateRef = useRef(0)
  const reduce = useReducedMotion()

  const finish = useCallback(
    async (commit: boolean) => {
      if (commit) {
        if (!silent) void impact("light")
        setRefreshing(true)
        try {
          await onRefresh()
        } catch {
          // Surface to console; don't blow up the wrapper.
          // The caller is expected to surface its own error UI.
        }
        setRefreshing(false)
      }
      setTranslate(0)
      firedHapticRef.current = false
    },
    [onRefresh, silent]
  )

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (refreshing) return
    if (!containerRef.current) return
    if (containerRef.current.scrollTop > 0) return
    startYRef.current = e.clientY
    dragRef.current = true
    setIsDragging(true)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current || startYRef.current === null) return
    const dy = e.clientY - startYRef.current
    if (dy <= 0) {
      liveTranslateRef.current = 0
      setTranslate(0)
      return
    }
    // Resist past triggerPx so the user gets a "rubber band" feel.
    const eased = dy < triggerPx ? dy : triggerPx + (dy - triggerPx) * 0.4
    const clamped = Math.min(maxPx, eased)
    liveTranslateRef.current = clamped
    setTranslate(clamped)
    if (!firedHapticRef.current && clamped >= triggerPx) {
      firedHapticRef.current = true
      if (!silent) void impact("light")
    }
  }

  const onPointerUp = () => {
    if (!dragRef.current) return
    dragRef.current = false
    setIsDragging(false)
    startYRef.current = null
    const current = liveTranslateRef.current
    liveTranslateRef.current = 0
    void finish(current >= triggerPx)
  }

  // Reset state if the component unmounts mid-refresh.
  useEffect(
    () => () => {
      dragRef.current = false
      startYRef.current = null
    },
    []
  )

  const setContainerRef = useCallback(
    (node: HTMLDivElement | null) => {
      containerRef.current = node
      onScrollElChange?.(node)
    },
    [onScrollElChange]
  )

  return (
    <div
      ref={setContainerRef}
      className={cn("relative h-full overflow-y-auto", className)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      data-testid="pull-to-refresh"
      data-refreshing={refreshing ? "true" : "false"}
    >
      <div
        className="pointer-events-none absolute inset-x-0 -top-12 flex h-12 items-end justify-center text-muted-foreground"
        style={{
          transform: `translateY(${refreshing ? maxPx : translate}px)`,
          // Snap during drag OR when reduced-motion is requested by
          // the OS; otherwise the spring-back is a 200 ms ease-out.
          transition: isDragging || reduce ? "none" : "transform 200ms ease-out",
        }}
        aria-hidden={!refreshing && translate === 0}
      >
        <Loader2Icon
          className={cn("size-5", (refreshing || translate >= triggerPx) && "animate-spin")}
        />
      </div>
      <div
        style={{
          transform: `translateY(${refreshing ? triggerPx : translate}px)`,
          // Snap during drag OR when reduced-motion is requested by
          // the OS; otherwise the spring-back is a 200 ms ease-out.
          transition: isDragging || reduce ? "none" : "transform 200ms ease-out",
        }}
      >
        {children}
      </div>
    </div>
  )
}
