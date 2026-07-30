"use client"

import { type RefObject, useCallback, useEffect, useRef, useState } from "react"

import type { ElementRect } from "@/lib/browser/protocol"

function readRect(el: HTMLElement): ElementRect {
  const r = el.getBoundingClientRect()
  return {
    x: Math.round(r.left),
    y: Math.round(r.top),
    width: Math.round(r.width),
    height: Math.round(r.height),
  }
}

function rectsEqual(a: ElementRect | null, b: ElementRect): boolean {
  return !!a && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

export interface UseElementRectOptions {
  /**
   * When false, rect changes are delivered only via `onChange` and the hook
   * always returns null — no React state, so a scroll/resize burst does not
   * re-render the consuming component. Defaults to true.
   */
  trackState?: boolean
}

/**
 * Track an element's viewport rect (logical CSS px) across resizes, scrolls,
 * and window changes — the basis for positioning the native embedded webview
 * over a reserved `<div>`. Generalizes `hooks/use-element-width.ts`, which only
 * reports width. Coalesces bursts via `requestAnimationFrame` and skips
 * no-op updates so the Tauri `set_bounds` round-trip only fires on real change.
 */
export function useElementRect(
  ref: RefObject<HTMLElement | null>,
  onChange?: (rect: ElementRect) => void,
  options: UseElementRectOptions = {}
): ElementRect | null {
  const trackState = options.trackState !== false
  const [rect, setRect] = useState<ElementRect | null>(null)
  const rectRef = useRef<ElementRect | null>(null)
  const onChangeRef = useRef(onChange)
  const trackStateRef = useRef(trackState)
  useEffect(() => {
    onChangeRef.current = onChange
    trackStateRef.current = trackState
  }, [onChange, trackState])

  const measure = useCallback(() => {
    const el = ref.current
    if (!el) return
    const next = readRect(el)
    if (rectsEqual(rectRef.current, next)) return
    rectRef.current = next
    if (trackStateRef.current) setRect(next)
    onChangeRef.current?.(next)
  }, [ref])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    measure()
    let frame = 0
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(measure)
    }
    const observer = new ResizeObserver(schedule)
    observer.observe(el)
    // ResizeObserver does not fire when layout moves the element without
    // changing its size. Native child webviews still need the new viewport
    // coordinates in that case — for example, moving the 64px app rail from
    // the right edge to the left translates the reserved pane by 64px while
    // preserving its dimensions. Watch only the ancestor chain (not the whole
    // document subtree) for the class/child changes that can reposition it.
    const layoutObserver = new MutationObserver(schedule)
    let ancestor = el.parentElement
    while (ancestor) {
      layoutObserver.observe(ancestor, { attributes: true, childList: true })
      ancestor = ancestor.parentElement
    }
    window.addEventListener("resize", schedule)
    window.addEventListener("scroll", schedule, true)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      layoutObserver.disconnect()
      window.removeEventListener("resize", schedule)
      window.removeEventListener("scroll", schedule, true)
    }
  }, [measure, ref])

  return rect
}
