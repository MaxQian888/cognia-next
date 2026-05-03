"use client"

import { useEffect, useState, type RefObject } from "react"

export interface OverflowState {
  hasOverflowLeft: boolean
  hasOverflowRight: boolean
}

/**
 * Tracks horizontal overflow on a scrollable container so callers can render
 * fade affordances on the leading / trailing edges only when the content
 * actually overflows. Updates on scroll, resize, and content-size changes.
 *
 * Returns `{ hasOverflowLeft: false, hasOverflowRight: false }` until the
 * ref is mounted — safe to render fades conditionally on these flags.
 */
export function useOverflowState(ref: RefObject<HTMLElement | null>): OverflowState {
  const [state, setState] = useState<OverflowState>({
    hasOverflowLeft: false,
    hasOverflowRight: false,
  })

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const update = () => {
      const left = el.scrollLeft > 0
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1 // 1px tolerance
      setState((prev) =>
        prev.hasOverflowLeft === left && prev.hasOverflowRight === right
          ? prev
          : { hasOverflowLeft: left, hasOverflowRight: right }
      )
    }

    update()
    el.addEventListener("scroll", update, { passive: true })

    let observer: ResizeObserver | undefined
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => update())
      observer.observe(el)
    } else {
      window.addEventListener("resize", update)
    }

    return () => {
      el.removeEventListener("scroll", update)
      if (observer) observer.disconnect()
      else window.removeEventListener("resize", update)
    }
  }, [ref])

  return state
}
