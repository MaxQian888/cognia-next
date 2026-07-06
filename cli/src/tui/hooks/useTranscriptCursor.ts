/**
 * React shell over the pure {@link ../navigation/transcript-cursor} state
 * machine. Owns the cursor state, a per-cell height registry, and the derived
 * `targetRow` that the scroll controller jumps to.
 *
 * Per-cell measurement is the one cost find adds, so it is GATED: callers only
 * wrap cells in measuring boxes while {@link TranscriptCursor.measuring} is true
 * (find open, or a cell is focused). Heights live in a ref and bump a version
 * counter only when a value actually changes, so a static history re-measures on
 * resize, not on every keystroke.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
// `heights` is held in state (not a ref) so it can be read during render to
// derive `targetRow`. Reports are de-duped, so a settled history never churns.

import {
  INITIAL_CURSOR,
  cellAtRow,
  cellTopRow,
  clearFocus,
  closeFind,
  currentMatch,
  focusedCell,
  isFindActive,
  moveCursor,
  nextMatch,
  openFind,
  prevMatch,
  setFindQuery,
  type CursorState,
} from "../navigation/transcript-cursor"
import type { SearchHit } from "../format/scrollback-search"
import type { Cell } from "../state/types"

export interface TranscriptCursor {
  state: CursorState
  /** Whether per-cell measurement is needed (find open or a cell focused). */
  measuring: boolean
  /** Total matches and current 0-based index — for the FindBar. */
  matchCount: number
  matchIndex: number
  /** The current find match (cell + line) for in-cell highlight, or null. */
  match: SearchHit | null
  /** Top content-row of the focused cell given measured heights, or null. */
  targetRow: number | null
  /** The focused cell (for per-cell copy / expand), or null. */
  focused: Cell | null
  /** Map a scroll-content row (absolute click row minus the content box's top)
   * to the cell under it, or null when it lands on a gap / unmeasured cell.
   * Only meaningful while measuring (find/focus open, or `alwaysMeasure`). */
  cellIdAtContentRow: (row: number) => string | null
  open: () => void
  close: () => void
  setQuery: (query: string) => void
  next: () => void
  prev: () => void
  move: (dir: "up" | "down") => void
  clear: () => void
  /** Report a measured cell height (called by the measuring transcript wrapper). */
  reportCellHeight: (id: string, height: number) => void
}

export function useTranscriptCursor(
  cells: Cell[],
  /** Keep per-cell measurement on even when find is closed and no cell is
   * focused — so a transcript click can be mapped to a cell (`/menu`-style
   * click-to-expand). Costs the measuring wrappers + disables context folding,
   * so the App only sets it when the click-to-expand pref is on. */
  alwaysMeasure = false
): TranscriptCursor {
  const [state, setState] = useState<CursorState>(INITIAL_CURSOR)
  // Latest cells, so the action closures (which fire on keypress, after commit)
  // never compute over a stale transcript. Synced in an effect rather than during
  // render, so the ref is only mutated as a committed side effect.
  const cellsRef = useRef(cells)
  useEffect(() => {
    cellsRef.current = cells
  }, [cells])

  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(new Map())

  const reportCellHeight = useCallback((id: string, height: number) => {
    setHeights((prev) => {
      if (prev.get(id) === height) return prev
      const next = new Map(prev)
      next.set(id, height)
      return next
    })
  }, [])

  const open = useCallback(() => setState(openFind), [])
  const close = useCallback(() => setState(closeFind), [])
  const setQuery = useCallback(
    (query: string) => setState((s) => setFindQuery(s, cellsRef.current, query)),
    []
  )
  const next = useCallback(() => setState(nextMatch), [])
  const prev = useCallback(() => setState(prevMatch), [])
  const move = useCallback(
    (dir: "up" | "down") => setState((s) => moveCursor(s, cellsRef.current, dir)),
    []
  )
  const clear = useCallback(() => {
    setHeights(new Map())
    setState(clearFocus)
  }, [])

  const measuring = isFindActive(state) || state.focusedCellId !== null || alwaysMeasure

  const cellIdAtContentRow = useCallback(
    (row: number) =>
      cellAtRow(
        cells.map((c) => c.id),
        heights,
        row
      ),
    [cells, heights]
  )

  const targetRow = useMemo(() => {
    if (state.focusedCellId === null) return null
    return cellTopRow(
      cells.map((c) => c.id),
      heights,
      state.focusedCellId
    )
  }, [state.focusedCellId, heights, cells])

  return {
    state,
    measuring,
    matchCount: state.find?.matches.length ?? 0,
    matchIndex: state.find?.index ?? 0,
    match: currentMatch(state),
    targetRow,
    focused: focusedCell(cells, state),
    cellIdAtContentRow,
    open,
    close,
    setQuery,
    next,
    prev,
    move,
    clear,
    reportCellHeight,
  }
}
