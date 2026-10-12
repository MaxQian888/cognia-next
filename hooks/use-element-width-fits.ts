"use client"

import { useEffect, useRef, useState, type RefObject } from "react"

import { useIsomorphicLayoutEffect } from "@/hooks/use-isomorphic-layout-effect"

interface Binding {
  el: HTMLElement
  release: () => void
}

/**
 * Whether the element behind `ref` is at least `minPx` wide — `useElementWidth`
 * for callers that only branch on one threshold.
 *
 * The difference is what re-renders. `useElementWidth` stores the width, so
 * every ResizeObserver tick that moves it by half a pixel re-renders the
 * caller: a workbench reading it re-rendered itself and every panel body on
 * each frame of a dock drag or open/close animation, to recompute one boolean
 * that flipped at most once. This stores the boolean, so React bails out of
 * every tick that does not cross the threshold.
 *
 * Unmeasured (no element yet, or a 0-wide box as in jsdom) reads as `true`:
 * the same "treat 0 as not yet measured" rule `useElementWidth`'s callers
 * apply, so a first paint does not pick the narrow layout and then snap. The
 * element is re-checked after every commit, for the same late-ref reason
 * `useElementWidth` documents.
 */
export function useElementWidthFits(ref: RefObject<HTMLElement | null>, minPx: number): boolean {
  const [fits, setFits] = useState(true)
  const bound = useRef<Binding | null>(null)
  const minRef = useRef(minPx)

  useIsomorphicLayoutEffect(() => {
    const el = ref.current
    const thresholdChanged = minRef.current !== minPx
    minRef.current = minPx
    if (!thresholdChanged && (bound.current?.el ?? null) === el) return

    bound.current?.release()
    bound.current = null

    if (!el) {
      setFits(true)
      return
    }

    const measure = () => {
      const width = el.getBoundingClientRect().width
      setFits(width === 0 || width >= minRef.current)
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

  return fits
}
