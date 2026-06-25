/**
 * Pure state machine for the fullscreen transcript's focus cursor + find.
 *
 * The fullscreen viewport has no native scrollback and no notion of a "current"
 * cell — so find-in-viewport, per-cell copy, and per-cell expand all need a
 * shared primitive: a cursor that points at one committed {@link Cell}. This
 * module owns that cursor and the incremental find on top of it. It is pure (no
 * Ink, no React, no I/O): the {@link useTranscriptCursor} hook is the thin React
 * shell, and {@link searchCells} (already used by `/search`) is the match core.
 *
 * `focusedCellId` is the cursor. `find` is non-null while the find bar is open;
 * its `matches` come straight from {@link searchCells}, so the excerpt/line of a
 * hit reads exactly like the transcript line the user sees.
 */
import { searchCells, type SearchHit } from "../format/scrollback-search"
import type { Cell } from "../state/types"

/** The find bar's live state. `null` ⇒ the bar is closed. */
export interface FindState {
  /** The query the user has typed (may be empty right after opening). */
  query: string
  /** One hit per matching line, in cell order (from {@link searchCells}). */
  matches: SearchHit[]
  /** Index of the current match within {@link matches} (0 when none). */
  index: number
}

export interface CursorState {
  /** The {@link Cell.id} the cursor points at, or `null` when unfocused. */
  focusedCellId: string | null
  /** The find bar state, or `null` when find is closed. */
  find: FindState | null
}

/** The initial state: no focus, find closed. */
export const INITIAL_CURSOR: CursorState = { focusedCellId: null, find: null }

/** Is the find bar open? */
export function isFindActive(state: CursorState): boolean {
  return state.find !== null
}

/**
 * The current match (cell + line) while find is open and has hits, else `null`.
 * Drives both the viewport jump (via the cell's measured row) and the in-cell
 * matched-line highlight.
 */
export function currentMatch(state: CursorState): SearchHit | null {
  const find = state.find
  if (!find || find.matches.length === 0) return null
  return find.matches[find.index] ?? null
}

/** Open the find bar with an empty query (no matches yet, focus unchanged). */
export function openFind(state: CursorState): CursorState {
  if (state.find) return state
  return { ...state, find: { query: "", matches: [], index: 0 } }
}

/**
 * Close the find bar. The cursor (`focusedCellId`) is intentionally KEPT so a
 * follow-up copy/expand acts on the last match the user landed on.
 */
export function closeFind(state: CursorState): CursorState {
  if (!state.find) return state
  return { ...state, find: null }
}

/**
 * Set the find query and recompute matches over `cells`. The cursor jumps to the
 * first hit; with no hits (or an empty query) the cursor is left where it was so
 * the view doesn't lurch. No-op when find is closed.
 */
export function setFindQuery(state: CursorState, cells: Cell[], query: string): CursorState {
  if (!state.find) return state
  const matches = searchCells(cells, query)
  const focusedCellId = matches.length > 0 ? matches[0].cellId : state.focusedCellId
  return { ...state, focusedCellId, find: { query, matches, index: 0 } }
}

/** Advance to the next match (wraps). No-op without an open find that has hits. */
export function nextMatch(state: CursorState): CursorState {
  return stepMatch(state, 1)
}

/** Go to the previous match (wraps). No-op without an open find that has hits. */
export function prevMatch(state: CursorState): CursorState {
  return stepMatch(state, -1)
}

function stepMatch(state: CursorState, delta: number): CursorState {
  const find = state.find
  if (!find || find.matches.length === 0) return state
  const len = find.matches.length
  const index = (find.index + delta + len) % len
  return { ...state, focusedCellId: find.matches[index].cellId, find: { ...find, index } }
}

/**
 * Move the cursor to the previous/next committed cell. With no current focus,
 * `"up"` lands on the last cell and `"down"` on the first (so the cursor enters
 * from the nearest edge). Clamps at the ends. No-op when there are no cells.
 */
export function moveCursor(state: CursorState, cells: Cell[], dir: "up" | "down"): CursorState {
  if (cells.length === 0) return state
  const cur = cells.findIndex((c) => c.id === state.focusedCellId)
  let next: number
  if (cur === -1) {
    next = dir === "up" ? cells.length - 1 : 0
  } else {
    next = dir === "up" ? cur - 1 : cur + 1
  }
  const clamped = Math.min(cells.length - 1, Math.max(0, next))
  return { ...state, focusedCellId: cells[clamped].id }
}

/** Drop the cursor focus (e.g. on `/clear` or a session swap). */
export function clearFocus(state: CursorState): CursorState {
  if (state.focusedCellId === null && state.find === null) return state
  return INITIAL_CURSOR
}

/** Look up the focused {@link Cell}, or `null` when nothing is focused / found. */
export function focusedCell(cells: Cell[], state: CursorState): Cell | null {
  if (state.focusedCellId === null) return null
  return cells.find((c) => c.id === state.focusedCellId) ?? null
}

/**
 * The top content-row of `targetId` given each cell's measured height (in cell
 * order), accounting for a `gap` row between cells (the transcript renders each
 * cell with a trailing blank row). Unmeasured cells contribute 0. Returns `null`
 * when `targetId` isn't among `orderedIds` (e.g. not yet committed). Pure, so the
 * row math is unit-tested without Ink measurement.
 */
export function cellTopRow(
  orderedIds: string[],
  heights: ReadonlyMap<string, number>,
  targetId: string,
  gap = 1
): number | null {
  let row = 0
  for (const id of orderedIds) {
    if (id === targetId) return row
    row += (heights.get(id) ?? 0) + gap
  }
  return null
}
