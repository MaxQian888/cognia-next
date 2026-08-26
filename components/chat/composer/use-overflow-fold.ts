"use client"

// One-row fold for a wrapping chip flow.
//
// The composer's context row can hold commands, links, files, attachments and
// @-references at once. Stacked as separate bands they pushed the input down
// the screen; merged into one wrapping flow they still do, just in fewer rows.
// So the row keeps its FIRST line and folds the rest behind a "+N" toggle.
//
// The measurement is deliberately layout-based rather than count-based: how
// many chips fit depends on their labels and the pane width, and nobody can
// predict that from a number. Children stay in the flow while folded (the
// clamp is a max-height, not a filter), so the same measurement is valid in
// both states and expanding never re-measures from scratch.
//
// jsdom reports every box as 0×0, so the fold never engages under test — which
// is the honest outcome there: a layout that was never laid out has no second
// row. The arithmetic itself is pure and tested via `foldMetrics`.

import { useCallback, useEffect, useState, type RefObject } from "react"

/** One laid-out child, in the coordinates of the flow container's offsetParent. */
export interface FoldBox {
  top: number
  height: number
  /** Width, used only to drop the invisible boxes described below. */
  width?: number
}

/**
 * Smallest box that can be a chip. Anything under this is a screen-reader or
 * measurement node — dnd-kit parks a `position: fixed` 1×1 live region inside
 * the attachment chips, and at `top: -1` it became the topmost box and put the
 * "first row" above every real chip, folding a row that fitted.
 */
const MIN_CHIP_PX = 8

export interface FoldMetrics {
  /** Boxes that did not fit on the first row. */
  hidden: number
  /** Bottom edge of the first row, in the same coordinates as `top`. */
  firstRowBottom: number
}

/**
 * Split `boxes` into "first row" and "the rest".
 *
 * Boxes too small to be a chip are dropped first (see {@link MIN_CHIP_PX}).
 *
 * Row membership is decided by the BOTTOM edge, not by an equal `top`: the row
 * is centred (`items-center`), so a short chip beside a tall one sits lower and
 * an equal-top test would call it a second row. The first row's bottom is set
 * by the tallest box that starts at the topmost offset, and anything reaching
 * past that bottom has wrapped. The 1px tolerances absorb sub-pixel layout.
 */
export function foldMetrics(boxes: readonly FoldBox[]): FoldMetrics {
  const real = boxes.filter(
    (box) => box.height >= MIN_CHIP_PX && (box.width === undefined || box.width >= MIN_CHIP_PX)
  )
  if (real.length === 0) return { hidden: 0, firstRowBottom: 0 }
  const minTop = Math.min(...real.map((box) => box.top))
  const firstRowBottom = Math.max(
    ...real.filter((box) => box.top <= minTop + 1).map((box) => box.top + box.height)
  )
  const hidden = real.filter((box) => box.top + box.height > firstRowBottom + 1).length
  return { hidden, firstRowBottom }
}

export interface OverflowFold {
  /** Children pushed past the first row. 0 when everything fits. */
  hiddenCount: number
  expanded: boolean
  toggle: () => void
  /** Height to clamp the container to while folded, in px (0 = unmeasured). */
  firstRowHeight: number
}

/**
 * The laid-out descendants that actually take part in the flow.
 *
 * Several chip sets wrap their pills in a `display: contents` element (or a
 * group that is empty right now), which reports a 0×0 box and hides its real
 * children from `element.children`. Measuring the wrapper would put every chip
 * it holds at offset 0 and fold the whole row; descending through it measures
 * the chips themselves.
 */
function flowChildren(el: HTMLElement, out: HTMLElement[] = []): HTMLElement[] {
  for (const child of Array.from(el.children) as HTMLElement[]) {
    if (child.offsetWidth === 0 && child.offsetHeight === 0) {
      flowChildren(child, out)
      continue
    }
    out.push(child)
  }
  return out
}

/**
 * The container ref is passed IN rather than handed back: an object that
 * carries a ref cannot be read during render (`react-hooks/refs`), and every
 * field here — the count, the clamp height — exists precisely to be read
 * during render.
 *
 * `expanded` is deliberately STICKY: once the user has opened the row it stays
 * open, even across the chip set shrinking below the fold and growing past it
 * again. Resetting it would quietly re-hide context the user just asked to see,
 * and the toggle is one click away either way.
 */
export function useOverflowFold<T extends HTMLElement>(ref: RefObject<T | null>): OverflowFold {
  const [hiddenCount, setHiddenCount] = useState(0)
  const [firstRowHeight, setFirstRowHeight] = useState(0)
  const [expanded, setExpanded] = useState(false)

  const measure = useCallback(
    (known?: readonly HTMLElement[]) => {
      const el = ref.current
      if (!el) return
      const children = known ?? flowChildren(el)
      const { hidden, firstRowBottom } = foldMetrics(
        children.map((child) => ({
          top: child.offsetTop,
          height: child.offsetHeight,
          width: child.offsetWidth,
        }))
      )
      // `offsetTop` is relative to the offsetParent, so subtracting the
      // container's own offset turns the row's bottom edge into a height for it —
      // one that still includes its padding-top, which the clamp must keep.
      const clamp = firstRowBottom > 0 ? Math.max(0, firstRowBottom - el.offsetTop) : 0
      // Functional updates: this runs from a ResizeObserver, and comparing
      // against the captured value would re-render on every observed frame.
      setHiddenCount((prev) => (prev === hidden ? prev : hidden))
      setFirstRowHeight((prev) => (prev === clamp ? prev : clamp))
    },
    [ref]
  )

  useEffect(() => {
    const el = ref.current
    if (!el) return
    // Without a ResizeObserver there is nothing to attach, so measure once and
    // stop. With one, `pass()` below does the initial measurement — walking the
    // children twice on mount would just be a second forced layout.
    if (typeof ResizeObserver === "undefined") {
      measure()
      return
    }

    let frame = 0
    let observed: HTMLElement[] = []
    // Observe the container (pane resizes) AND each laid-out child (a chip's
    // label can change length without the container changing size).
    const observer = new ResizeObserver(() => schedule())

    // ONE walk, ONE measurement, and a re-observation only when the child set
    // genuinely changed.
    //
    // `flowChildren` reads `offsetWidth`/`offsetHeight` per descendant, so each
    // walk forces a synchronous layout — and every fresh `observe()` schedules
    // another ResizeObserver callback, which used to force another. Running
    // that per DOM mutation meant several full layout passes each time a chip
    // set swapped a pill, in the composer's typing hot path.
    const pass = () => {
      const children = flowChildren(el)
      const changed =
        children.length !== observed.length || children.some((child, i) => child !== observed[i])
      if (changed) {
        observer.disconnect()
        observer.observe(el)
        for (const child of children) observer.observe(child)
        observed = children
      }
      measure(children)
    }

    // Coalesce every signal into at most one pass per frame: a burst of
    // mutations, plus the initial callback each new `observe()` fires, all
    // collapse into a single measurement.
    const schedule = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        pass()
      })
    }

    pass()
    // Chips come and go as the user types; the mutation feed is what notices a
    // chip set swapping its own pills without touching the container's direct
    // children. It only ever schedules — `pass` decides whether anything moved.
    const mutation = typeof MutationObserver === "undefined" ? null : new MutationObserver(schedule)
    mutation?.observe(el, { childList: true, subtree: true })
    return () => {
      if (frame) cancelAnimationFrame(frame)
      observer.disconnect()
      mutation?.disconnect()
    }
  }, [measure, ref])

  const toggle = useCallback(() => setExpanded((value) => !value), [])

  return { hiddenCount, expanded, toggle, firstRowHeight }
}
