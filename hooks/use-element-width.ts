"use client"

import { useEffect, useRef, useState, type RefObject } from "react"

import { useIsomorphicLayoutEffect } from "@/hooks/use-isomorphic-layout-effect"

interface Binding {
  el: HTMLElement
  release: () => void
}

/**
 * Tracks the rendered width (in px) of the element behind `ref`. Measures
 * synchronously on mount (before paint, so callers can pick a layout without
 * a visible flash) and again on every ResizeObserver tick.
 *
 * Returns `0` until the ref is attached — callers should treat `0` as
 * "not yet measured" and avoid switching layouts on it.
 *
 * The ref is re-checked after every commit, not only on mount: a component
 * that renders `null` first (`if (!mounted) return null`, a loading branch, a
 * media-query fork) has a `null` ref at its first commit, and a one-shot
 * mount effect would then never observe the element that shows up on the
 * next render. The title bar sized its column outlets from exactly such refs
 * and came up 16px–256px wrong after a hard reload until something happened
 * to remount. Re-checking is one identity comparison per render; the
 * observer is only rebuilt when the element actually changes.
 */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0)
  const bound = useRef<Binding | null>(null)

  useIsomorphicLayoutEffect(() => {
    const el = ref.current
    if ((bound.current?.el ?? null) === el) return

    bound.current?.release()
    bound.current = null

    if (!el) {
      setWidth(0)
      return
    }

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

    bound.current = {
      el,
      release: () => {
        if (observer) observer.disconnect()
        else window.removeEventListener("resize", measure)
      },
    }
  })

  useEffect(
    () => () => {
      bound.current?.release()
      bound.current = null
    },
    []
  )

  return width
}
