"use client"

import { type RefObject, useEffect, useState } from "react"

/** Screens of look-ahead: start work one screen before the element scrolls in. */
export const DEFAULT_LOOK_AHEAD_SCREENS = 1

export interface NearViewportOptions {
  /** How many screens of look-ahead to allow. Defaults to one. */
  lookAheadScreens?: number
  /**
   * Skip the check and report visible immediately. For call sites that already
   * know the work is cheap (a cache hit) and want to avoid paying for an
   * observer at all.
   */
  disabled?: boolean
}

/**
 * Whether `ref`'s element is within `lookAheadScreens` of the viewport.
 *
 * **Latches.** Once true it stays true and the observer disconnects. Expensive
 * blocks — Mermaid diagrams, A2UI surfaces — must not be torn down and rebuilt
 * every time the user scrolls past them; the point is to defer the *first*
 * render out of the initial paint, not to churn on every scroll. The chat list
 * is virtualized, so a row that scrolls far enough away unmounts anyway.
 *
 * **Never withholds content indefinitely.** The element's position is measured
 * synchronously on mount and the observer is only used for the not-yet-near
 * case. That matters because "IntersectionObserver exists" does not imply "it
 * will deliver a callback": jsdom polyfills it with a no-op, and a gate that
 * waited on that callback alone would leave every diagram permanently blank.
 * With no layout engine every rect is 0×0 at the origin, which reads as
 * on-screen — the correct answer when there is no viewport to be off.
 */
export function useNearViewport(
  ref: RefObject<Element | null>,
  { lookAheadScreens = DEFAULT_LOOK_AHEAD_SCREENS, disabled = false }: NearViewportOptions = {}
): boolean {
  const [near, setNear] = useState(disabled)

  // `setNear` in an effect body is normally a render-loop smell, which is what
  // `set-state-in-effect` guards. It is safe here precisely because the value
  // latches: the effect returns early once `near` is true, so at most one
  // transition can ever happen per mount. The measurement it depends on
  // (`getBoundingClientRect`) needs a mounted element, so it cannot move into
  // the `useState` initializer — a DOM ref is still null during first render.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (near) return
    const el = ref.current
    if (!el) return

    if (isWithinLookAhead(el, lookAheadScreens)) {
      setNear(true)
      return
    }
    if (typeof IntersectionObserver === "undefined") {
      setNear(true)
      return
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        setNear(true)
        observer.disconnect()
      },
      { rootMargin: `${Math.round(lookAheadScreens * 100)}% 0px` }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [near, ref, lookAheadScreens])
  /* eslint-enable react-hooks/set-state-in-effect */

  return near
}

/**
 * Synchronous "is it close enough" check, in the same band the observer's
 * `rootMargin` describes. Exported for the test that pins the band.
 */
export function isWithinLookAhead(el: Element, lookAheadScreens: number): boolean {
  if (typeof window === "undefined" || typeof el.getBoundingClientRect !== "function") return true
  const viewport = window.innerHeight || 0
  const margin = viewport * lookAheadScreens
  const rect = el.getBoundingClientRect()
  return rect.top <= viewport + margin && rect.bottom >= -margin
}
