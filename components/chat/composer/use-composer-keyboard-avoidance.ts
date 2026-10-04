"use client"

import { useEffect } from "react"

import { readReducedMotion } from "@cognia/plugin-ui/motion-tokens"
import { useKeyboardDockMotion } from "@/hooks/ui/use-keyboard-dock-motion"
import { useKeyboardViewport } from "@/hooks/ui/use-keyboard-insets"

/**
 * The composer's half of keyboard avoidance. The shell's half sizes the
 * viewport-owning column to the visible height (`MobileShellWrapper`); this
 * keeps the WHOLE composer (box and toolbar row) above the keyboard inside it.
 *
 * - `docked` (bottom of a conversation): the column already ends at the top of
 *   the keyboard, so the composer is in place; what is left is the motion.
 *   `useKeyboardDockMotion` glides it between the before/after positions so
 *   the open and close read as one move with the keyboard instead of a jump
 *   (or two).
 * - `hero` (the welcome page, inside a scroll container): when the keyboard
 *   opens, the browser scrolls only far enough to reveal the focused
 *   TEXTAREA, which leaves the toolbar row under the keyboard. Once the
 *   viewport has settled, scroll the composer root itself into view
 *   (`block: "nearest"`: the whole card, its bottom edge on the keyboard when
 *   it was cut off; no move at all when it already fits).
 *
 * `enabled` is the soft-keyboard gate (`softKeyboard` in the composer); on a
 * desktop the hook does nothing.
 */
export function useComposerKeyboardAvoidance({
  root,
  placement,
  enabled,
}: {
  root: HTMLElement | null
  placement: "docked" | "hero"
  enabled: boolean
}): void {
  const { open, viewportHeight } = useKeyboardViewport(enabled)

  useKeyboardDockMotion(root, enabled && placement === "docked")

  useEffect(() => {
    if (!enabled || placement !== "hero" || !root || !open) return
    if (typeof window === "undefined" || typeof root.scrollIntoView !== "function") return
    const active = root.ownerDocument.activeElement
    if (!active || !root.contains(active)) return
    // One frame later: the viewport change that triggered this has been laid
    // out, so "nearest" measures the final geometry.
    const frame = window.requestAnimationFrame(() => {
      root.scrollIntoView({
        block: "nearest",
        inline: "nearest",
        behavior: readReducedMotion() ? "auto" : "smooth",
      })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [enabled, placement, root, open, viewportHeight])
}
