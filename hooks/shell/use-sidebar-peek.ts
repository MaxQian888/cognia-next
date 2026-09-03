"use client"

/**
 * Hover-intent state machine for the collapsed sidebar's edge peek.
 *
 * A fully collapsed rail reclaims the whole column, which is the point of
 * collapsing it. What it costs is the glance: every look at the conversation
 * list becomes a round trip through the toggle. The peek buys the glance back
 * by floating the rail over the content while the pointer rests on the window
 * edge it went away into.
 *
 * The delays are the whole design. Opening immediately turns a pointer crossing
 * the window edge on its way to the scrollbar into a flyout, so the open waits
 * for {@link PEEK_OPEN_DELAY_MS} of sustained hover. Closing immediately makes
 * the gap between the hot strip and the panel unbridgeable, so the close waits
 * for {@link PEEK_CLOSE_DELAY_MS} and any re-entry during that window cancels
 * it. Both timers are cleared on unmount, and every one of them is transient:
 * nothing here is persisted, because a floating panel that survives a reload
 * would look like a rail that failed to collapse.
 */

import { useCallback, useEffect, useRef, useState } from "react"

/** Sustained hover on the edge strip before the panel floats in. */
export const PEEK_OPEN_DELAY_MS = 150
/** Grace period after the pointer leaves, so the strip and the panel feel joined. */
export const PEEK_CLOSE_DELAY_MS = 260

export interface SidebarPeekHandlers {
  onMouseEnter: () => void
  onMouseLeave: () => void
}

export interface UseSidebarPeek {
  /** True while the flyout should be slid in. */
  open: boolean
  /** For the invisible hot strip pinned to the window edge. */
  edgeHandlers: SidebarPeekHandlers
  /** For the flyout itself, so moving onto it cancels the pending close. */
  panelHandlers: SidebarPeekHandlers
  /** Dismiss now, skipping the grace period (Escape, or a click that navigates). */
  close: () => void
}

export interface UseSidebarPeekOptions {
  /**
   * Whether the peek can happen at all. Goes false when the rail is expanded,
   * when the user turned the behaviour off, or on a touch-only pointer. A
   * false value closes an open peek rather than freezing it on screen.
   */
  enabled: boolean
  openDelay?: number
  closeDelay?: number
}

export function useSidebarPeek({
  enabled,
  openDelay = PEEK_OPEN_DELAY_MS,
  closeDelay = PEEK_CLOSE_DELAY_MS,
}: UseSidebarPeekOptions): UseSidebarPeek {
  const [open, setOpen] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimer = useCallback(() => {
    if (timer.current === null) return
    clearTimeout(timer.current)
    timer.current = null
  }, [])

  const close = useCallback(() => {
    clearTimer()
    setOpen(false)
  }, [clearTimer])

  // The rail can be expanded (or the preference switched off) while a peek is
  // on screen. Dropping `enabled` has to take the panel with it, otherwise the
  // expanded rail and its own flyout are both drawn. Derived during render
  // rather than in an effect: the panel must not be on screen for the frame
  // between the rail expanding and an effect catching up, and a re-arm has to
  // start closed rather than restore whatever the last peek left behind.
  const [previousEnabled, setPreviousEnabled] = useState(enabled)
  if (previousEnabled !== enabled) {
    setPreviousEnabled(enabled)
    if (open) setOpen(false)
  }

  useEffect(() => {
    if (!enabled) clearTimer()
  }, [enabled, clearTimer])

  useEffect(() => clearTimer, [clearTimer])

  // Escape is the keyboard's way out of a surface the pointer summoned.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [open, close])

  const scheduleOpen = useCallback(() => {
    if (!enabled) return
    clearTimer()
    timer.current = setTimeout(() => {
      timer.current = null
      setOpen(true)
    }, openDelay)
  }, [enabled, openDelay, clearTimer])

  const scheduleClose = useCallback(() => {
    clearTimer()
    timer.current = setTimeout(() => {
      timer.current = null
      setOpen(false)
    }, closeDelay)
  }, [closeDelay, clearTimer])

  const edgeHandlers: SidebarPeekHandlers = {
    onMouseEnter: scheduleOpen,
    onMouseLeave: scheduleClose,
  }
  // Identical today, kept as two objects because they are two different
  // intents: the strip arms the peek, the panel only holds it open.
  const panelHandlers: SidebarPeekHandlers = {
    onMouseEnter: clearTimer,
    onMouseLeave: scheduleClose,
  }

  return { open, edgeHandlers, panelHandlers, close }
}
