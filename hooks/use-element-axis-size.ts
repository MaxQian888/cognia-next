"use client"

import { useEffect, useLayoutEffect, useState } from "react"

// `useLayoutEffect` warns during SSR; consumers are client-only but the static
// export still pre-renders, so fall back to `useEffect` off the DOM.
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect

/** Which side of the box to track. */
export type ElementAxis = "width" | "height"

/**
 * Tracks the rendered size of `el` along one axis, in px. Measures
 * synchronously on mount (before paint, so a caller can pick a layout without a
 * visible flash) and again on every ResizeObserver tick.
 *
 * Takes the element value rather than a `RefObject` so it composes with
 * state-held / callback refs — the case where the element only shows up on a
 * later render. Returns `0` until one is provided; callers should treat `0` as
 * "not yet measured" and fall back to a sane default rather than committing to
 * a zero-size layout.
 *
 * One axis, returned as a number, on purpose: consumers re-render when the side
 * they asked about changes and stay still when the other one does.
 * {@link useElementHeight} is this hook with `axis` pinned, and the terminal
 * dock region sizes itself from the perpendicular axis of whichever shell edge
 * it is docked to.
 */
export function useElementAxisSize(el: HTMLElement | null, axis: ElementAxis): number {
  const [size, setSize] = useState(0)

  useIsomorphicLayoutEffect(() => {
    if (!el) {
      setSize(0)
      return
    }

    const measure = () => {
      const next = el.getBoundingClientRect()[axis]
      setSize((prev) => (Math.abs(prev - next) < 0.5 ? prev : next))
    }

    measure()

    let observer: ResizeObserver | undefined
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(measure)
      observer.observe(el)
    } else {
      window.addEventListener("resize", measure)
    }

    return () => {
      if (observer) observer.disconnect()
      else window.removeEventListener("resize", measure)
    }
  }, [el, axis])

  return size
}
