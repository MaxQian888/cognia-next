/**
 * React state for the fullscreen layout's scroll viewport.
 *
 * Owns the {@link ScrollIntent} (raw offset + stick-to-bottom) and the live
 * measured heights fed back from {@link ScrollView}. All the clamp/page/stick
 * rules live in the pure `scroll-view-state` module; this hook is just the thin
 * React shell that wires them to keyboard handlers and exposes the derived
 * render offset + indicator.
 *
 * Measured heights live in state so the indicator re-renders when they change.
 * `measure` only updates state when a value actually changes, so the per-render
 * measure call converges instead of looping. The size-dependent handlers close
 * over the current `sizes` (re-created when it changes) — and since the whole
 * controller object is rebuilt every render, App always calls the latest ones.
 */
import { useCallback, useState } from "react"

import {
  INITIAL_SCROLL,
  atBottom,
  effectiveTop,
  hiddenRows,
  scrollByLines,
  scrollPage,
  scrollToBottom,
  scrollToRow,
  scrollToTop,
  type ScrollIntent,
} from "../components/scroll-view-state"

export interface ScrollController {
  /** Effective render offset (rows hidden above) for the measured heights. */
  offset: number
  /** Rows hidden above / below the viewport — drives the scroll indicator. */
  hidden: { above: number; below: number }
  /** Is the view pinned to / scrolled to the bottom? */
  atBottom: boolean
  /** Feed measured content / viewport heights (called by ScrollView). */
  measure: (contentHeight: number, viewportHeight: number) => void
  pageUp: () => void
  pageDown: () => void
  lineUp: () => void
  lineDown: () => void
  toTop: () => void
  toBottom: () => void
  /** Jump so content-row `targetRow` sits ~1/3 down the viewport (find jump). */
  toRow: (targetRow: number) => void
  /** Re-pin to the bottom (e.g. after `/clear` or a session swap). */
  reset: () => void
}

export function useScroll(): ScrollController {
  const [intent, setIntent] = useState<ScrollIntent>(INITIAL_SCROLL)
  const [sizes, setSizes] = useState({ content: 0, viewport: 0 })

  const measure = useCallback((content: number, viewport: number) => {
    setSizes((prev) =>
      prev.content === content && prev.viewport === viewport ? prev : { content, viewport }
    )
  }, [])

  // Apply a pure transform using the current measured size. Re-created when
  // `sizes` changes; the controller is rebuilt every render, so callers always
  // invoke the version bound to the latest geometry.
  const apply = useCallback(
    (fn: (i: ScrollIntent, content: number, viewport: number) => ScrollIntent) => {
      setIntent((i) => fn(i, sizes.content, sizes.viewport))
    },
    [sizes]
  )

  const pageUp = useCallback(() => apply((i, c, v) => scrollPage(i, "up", c, v)), [apply])
  const pageDown = useCallback(() => apply((i, c, v) => scrollPage(i, "down", c, v)), [apply])
  const lineUp = useCallback(() => apply((i, c, v) => scrollByLines(i, -1, c, v)), [apply])
  const lineDown = useCallback(() => apply((i, c, v) => scrollByLines(i, 1, c, v)), [apply])
  const toTop = useCallback(() => setIntent(scrollToTop()), [])
  const toBottom = useCallback(() => setIntent(scrollToBottom()), [])
  const toRow = useCallback(
    (targetRow: number) => setIntent((_i) => scrollToRow(targetRow, sizes.content, sizes.viewport)),
    [sizes]
  )

  return {
    offset: effectiveTop(intent, sizes.content, sizes.viewport),
    hidden: hiddenRows(intent, sizes.content, sizes.viewport),
    atBottom: atBottom(intent, sizes.content, sizes.viewport),
    measure,
    pageUp,
    pageDown,
    lineUp,
    lineDown,
    toTop,
    toBottom,
    toRow,
    reset: toBottom,
  }
}
