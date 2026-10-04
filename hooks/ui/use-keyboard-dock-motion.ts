"use client"

import { useEffect } from "react"

import { readReducedMotion } from "@cognia/plugin-ui/motion-tokens"
import { shellDockDurationScale } from "@/lib/ui/shell-dock-motion"

/**
 * Glide a bottom-docked element (the chat composer) to its new resting place
 * when the soft keyboard opens or closes, instead of letting it jump.
 *
 * Why a FLIP rather than a CSS transition: the move is not one layout change
 * but several, landing in different frames. When the keyboard opens the tab
 * bar's bottom reserve collapses (the dock drops ~56px) and the OS shrinks the
 * WebView frame (the dock rises by the keyboard height); closing replays both
 * in the opposite order. Each step used to paint, which is the double jump.
 * The OS frame resize cannot be animated from the page at all.
 *
 * So the hook watches the dock's LAYOUT bottom (its rect minus its own
 * transform). Whenever it moves, it re-applies the visual position the dock
 * had a moment ago as a `translateY` and eases that offset to zero. A change
 * arriving mid-glide starts from wherever the dock currently is on screen, so
 * the steps compose into one continuous motion. Content-height changes (the
 * textarea growing, the run strip appearing) leave the bottom where it is and
 * are ignored.
 *
 * Detection runs from a `ResizeObserver` (the dock and its parent column; its
 * callbacks land after layout and before paint, so the corrective transform is
 * in place for the very first frame of the new layout) plus `window` /
 * `visualViewport` resize.
 *
 * Reduced motion (the app's switch or the OS hint, see `readReducedMotion`)
 * snaps instead. Without the Web Animations API the hook does nothing.
 */

/** ~ the soft-keyboard animation on Android (≈250–285ms) and iOS (≈250ms). */
export const KEYBOARD_DOCK_DURATION_MS = 240

/** Decelerating, like the keyboard itself: fast off the mark, soft landing. */
export const KEYBOARD_DOCK_EASING = "cubic-bezier(0.32, 0.72, 0, 1)"

/** Sub-pixel noise from fractional layout is not a move. */
const MOVE_EPSILON_PX = 1

/**
 * The element's current vertical translation in px, as computed (so it
 * includes an in-flight animation). 0 for `none` or anything unparseable.
 */
export function readTranslateY(element: Element): number {
  if (typeof getComputedStyle !== "function") return 0
  const transform = getComputedStyle(element).transform
  if (!transform || transform === "none") return 0
  const match = /^matrix(3d)?\(([^)]+)\)$/.exec(transform.trim())
  if (!match) return 0
  const values = match[2].split(",").map((part) => Number.parseFloat(part))
  // matrix(a, b, c, d, tx, ty) → index 5; matrix3d(... tx, ty, tz, 1) → 13.
  const ty = match[1] ? values[13] : values[5]
  return Number.isFinite(ty) ? ty : 0
}

export function useKeyboardDockMotion(element: HTMLElement | null, enabled: boolean): void {
  useEffect(() => {
    if (!enabled || !element || typeof window === "undefined") return

    let animation: Animation | null = null
    const layoutBottom = () => element.getBoundingClientRect().bottom - readTranslateY(element)
    let lastBottom = layoutBottom()

    const check = () => {
      const bottom = layoutBottom()
      const delta = bottom - lastBottom
      lastBottom = bottom
      if (Math.abs(delta) < MOVE_EPSILON_PX) return
      // Where the dock is on screen right now, relative to its new slot.
      const from = readTranslateY(element) - delta
      animation?.cancel()
      animation = null
      if (readReducedMotion() || typeof element.animate !== "function") return
      const glide = element.animate(
        [{ transform: `translateY(${from}px)` }, { transform: "translateY(0px)" }],
        {
          duration: KEYBOARD_DOCK_DURATION_MS * shellDockDurationScale(element),
          easing: KEYBOARD_DOCK_EASING,
        }
      )
      animation = glide
      glide.onfinish = () => {
        if (animation === glide) animation = null
      }
    }

    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(check) : null
    observer?.observe(element)
    if (element.parentElement) observer?.observe(element.parentElement)
    const vv = window.visualViewport
    window.addEventListener("resize", check)
    vv?.addEventListener("resize", check)

    return () => {
      observer?.disconnect()
      window.removeEventListener("resize", check)
      vv?.removeEventListener("resize", check)
      animation?.cancel()
      animation = null
    }
  }, [element, enabled])
}
