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
import {
  anchorAtRow,
  buildVirtualBlockIndex,
  rowForAnchor,
  type VirtualBlockIndex,
  type VirtualBlockMetric,
} from "../state/virtual-block-index"

export interface ScrollController {
  /** Effective render offset (rows hidden above) for the measured heights. */
  offset: number
  /** Rows hidden above / below the viewport — drives the scroll indicator. */
  hidden: { above: number; below: number }
  /** Is the view pinned to / scrolled to the bottom? */
  atBottom: boolean
  /** Last measured viewport height, used to size the virtual window. */
  viewportRows: number
  /** Rows appended since the user left follow-tail mode. */
  newRowsBelow: number
  /** Install/correct the exact variable-height block model. */
  setBlockMetrics: (blocks: readonly VirtualBlockMetric[]) => void
  /** Feed measured content / viewport heights (called by ScrollView). */
  measure: (contentHeight: number, viewportHeight: number) => void
  pageUp: () => void
  pageDown: () => void
  halfPageUp: () => void
  halfPageDown: () => void
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
  const [blockIndex, setBlockIndex] = useState<VirtualBlockIndex | null>(null)
  const [newRowsBelow, setNewRowsBelow] = useState(0)

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
      setIntent((i) => {
        const next = fn(i, sizes.content, sizes.viewport)
        if (next.stick) setNewRowsBelow(0)
        return next
      })
    },
    [sizes]
  )

  const pageUp = useCallback(() => apply((i, c, v) => scrollPage(i, "up", c, v)), [apply])
  const pageDown = useCallback(() => apply((i, c, v) => scrollPage(i, "down", c, v)), [apply])
  const halfPageUp = useCallback(
    () => apply((i, c, v) => scrollByLines(i, -Math.max(1, Math.floor(v / 2)), c, v)),
    [apply]
  )
  const halfPageDown = useCallback(
    () => apply((i, c, v) => scrollByLines(i, Math.max(1, Math.floor(v / 2)), c, v)),
    [apply]
  )
  const lineUp = useCallback(() => apply((i, c, v) => scrollByLines(i, -1, c, v)), [apply])
  const lineDown = useCallback(() => apply((i, c, v) => scrollByLines(i, 1, c, v)), [apply])
  const toTop = useCallback(() => setIntent(scrollToTop()), [])
  const toBottom = useCallback(() => setIntent(scrollToBottom()), [])
  const toRow = useCallback(
    (targetRow: number) => setIntent((_i) => scrollToRow(targetRow, sizes.content, sizes.viewport)),
    [sizes]
  )

  const setBlockMetrics = useCallback(
    (blocks: readonly VirtualBlockMetric[]) => {
      const next = buildVirtualBlockIndex(blocks)
      if (
        blockIndex &&
        blockIndex.totalRows === next.totalRows &&
        blockIndex.blocks.length === next.blocks.length &&
        blockIndex.blocks.every(
          (block, index) =>
            block.id === next.blocks[index]?.id && block.rows === next.blocks[index]?.rows
        )
      ) {
        return
      }
      const oldTotal = blockIndex?.totalRows ?? sizes.content
      if (!intent.stick && next.totalRows > oldTotal) {
        setNewRowsBelow((rows) => rows + next.totalRows - oldTotal)
      }
      if (!intent.stick && blockIndex) {
        const anchor = anchorAtRow(
          blockIndex,
          effectiveTop(intent, blockIndex.totalRows, sizes.viewport)
        )
        setIntent({ top: rowForAnchor(next, anchor), stick: false })
      }
      setBlockIndex(next)
      setSizes((current) =>
        current.content === next.totalRows ? current : { ...current, content: next.totalRows }
      )
    },
    [blockIndex, intent, sizes.content, sizes.viewport]
  )

  const jumpBottom = useCallback(() => {
    setNewRowsBelow(0)
    toBottom()
  }, [toBottom])

  return {
    offset: effectiveTop(intent, sizes.content, sizes.viewport),
    hidden: hiddenRows(intent, sizes.content, sizes.viewport),
    atBottom: atBottom(intent, sizes.content, sizes.viewport),
    viewportRows: sizes.viewport,
    newRowsBelow,
    setBlockMetrics,
    measure,
    pageUp,
    pageDown,
    halfPageUp,
    halfPageDown,
    lineUp,
    lineDown,
    toTop,
    toBottom: jumpBottom,
    toRow,
    reset: jumpBottom,
  }
}
