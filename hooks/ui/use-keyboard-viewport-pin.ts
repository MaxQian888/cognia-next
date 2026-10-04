"use client"

import { useEffect, useState } from "react"

import { useKeyboardViewport } from "@/hooks/ui/use-keyboard-insets"

/**
 * Keep a viewport-owning page scrolled to the top while the soft keyboard is
 * open.
 *
 * A route that owns the viewport (`lib/shell/full-viewport-routes.ts`) is a
 * definite-height column that never scrolls as a document. When an input in
 * it takes focus, the browser still scrolls the root — programmatically, so
 * `overflow: hidden` does not stop it — or pans the visual viewport, by just
 * enough to show the focused textarea. With the column sized to the visible
 * height (`--visual-viewport-height`) that scroll is never needed, and leaving
 * it in place shifts the header off the top and leaves the rest of the
 * composer (its toolbar row) under the keyboard. This hook undoes it whenever
 * it appears while the keyboard is open.
 *
 * Never while pinch-zoomed: panning a zoomed viewport is the user's doing.
 */
export function useKeyboardViewportPin(enabled: boolean): void {
  const { open } = useKeyboardViewport(enabled)

  // The keyboard closing is the one moment the open-only pin below misses:
  // the scroll Chromium applied while it was up survives the close (the frame
  // grows back under an already-scrolled root), so the window bar sits off
  // the top and a keyboard-tall blank band fills the bottom. Undo it once on
  // the open → closed edge, and again a frame later, after the resize lands.
  const [wasOpen, setWasOpen] = useState(open)
  const [closedAt, setClosedAt] = useState(0)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (!open) setClosedAt((n) => n + 1)
  }

  useEffect(() => {
    if (!enabled || closedAt === 0 || typeof window === "undefined") return
    const vv = window.visualViewport
    const reset = () => {
      const scale = vv && typeof vv.scale === "number" ? vv.scale : 1
      if (Math.abs(scale - 1) > 0.01) return
      if ((window.scrollY ?? 0) !== 0) window.scrollTo(0, 0)
    }
    reset()
    const frame = window.requestAnimationFrame(reset)
    return () => window.cancelAnimationFrame(frame)
  }, [enabled, closedAt])

  useEffect(() => {
    if (!enabled || !open || typeof window === "undefined") return
    const vv = window.visualViewport
    const zoomed = () => {
      const scale = vv && typeof vv.scale === "number" ? vv.scale : 1
      return Math.abs(scale - 1) > 0.01
    }
    const pin = () => {
      if (zoomed()) return
      const panned = (vv?.offsetTop ?? 0) > 0
      if ((window.scrollY ?? 0) !== 0 || panned) window.scrollTo(0, 0)
    }
    pin()
    vv?.addEventListener("scroll", pin)
    vv?.addEventListener("resize", pin)
    window.addEventListener("scroll", pin)
    return () => {
      vv?.removeEventListener("scroll", pin)
      vv?.removeEventListener("resize", pin)
      window.removeEventListener("scroll", pin)
    }
  }, [enabled, open])
}
