"use client"

import { useEffect, useLayoutEffect, useState } from "react"

// `useLayoutEffect` warns during SSR; consumers are client-only but the static
// export still pre-renders, so fall back to `useEffect` off the DOM.
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect

/**
 * Tracks the rendered height (in px) of `el`. Unlike {@link useElementWidth}
 * (which takes a `RefObject`), this accepts the element value directly so it
 * composes with state-held element references such as the composer's
 * `setContainerEl` callback ref. Measures synchronously on mount (before
 * paint) and again on every ResizeObserver tick.
 *
 * Returns `0` until an element is provided — callers should treat `0` as
 * "not yet measured" and fall back to a sane default.
 */
export function useElementHeight(el: HTMLElement | null): number {
  const [height, setHeight] = useState(0)

  useIsomorphicLayoutEffect(() => {
    if (!el) return

    const measure = () => {
      const next = el.getBoundingClientRect().height
      setHeight((prev) => (Math.abs(prev - next) < 0.5 ? prev : next))
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
  }, [el])

  return height
}
