"use client"

import { useEffect, useLayoutEffect, useState, type RefObject } from "react"

// `useLayoutEffect` warns during SSR; the composer is client-only but the
// static export still pre-renders, so fall back to `useEffect` off the DOM.
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect

/**
 * Tracks the rendered width (in px) of the element behind `ref`. Measures
 * synchronously on mount (before paint, so callers can pick a layout without
 * a visible flash) and again on every ResizeObserver tick.
 *
 * Returns `0` until the ref is attached — callers should treat `0` as
 * "not yet measured" and avoid switching layouts on it.
 */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0)

  useIsomorphicLayoutEffect(() => {
    const el = ref.current
    if (!el) return

    const measure = () => {
      const next = el.getBoundingClientRect().width
      setWidth((prev) => (Math.abs(prev - next) < 0.5 ? prev : next))
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
  }, [ref])

  return width
}
