/**
 * Multi-selection model for the issue list.
 *
 * Pure, because the part that actually goes wrong here is invisible: a
 * selection that outlives the rows it pointed at. Change the filter with three
 * issues selected and two of them scroll out of the result set — a bulk edit
 * would then silently write to rows the user can no longer see. `pruneSelection`
 * is the guard, and it is only testable if the model has no React in it.
 *
 * The anchor is the other subtle piece: shift-range selects from the LAST
 * plain click, not from the nearest selected row, which is what every list in
 * every OS does and what users' fingers expect.
 */

export interface IssueSelectionState {
  selected: ReadonlySet<string>
  /** Where a shift-range starts. Null until something is plainly clicked. */
  anchor: string | null
}

export const EMPTY_ISSUE_SELECTION: IssueSelectionState = Object.freeze({
  selected: Object.freeze(new Set<string>()) as ReadonlySet<string>,
  anchor: null,
})

/** Toggle one row and move the anchor to it. */
export function toggleSelection(state: IssueSelectionState, id: string): IssueSelectionState {
  const selected = new Set(state.selected)
  if (selected.has(id)) selected.delete(id)
  else selected.add(id)
  return { selected, anchor: id }
}

/**
 * Select every row between the anchor and `id`, inclusive, ADDING to whatever
 * was already selected.
 *
 * With no anchor — or an anchor that has since been filtered away — this
 * degrades to selecting the single row rather than selecting nothing, because
 * a shift-click that appears to do nothing reads as a broken list.
 *
 * The anchor deliberately does NOT move: holding shift and walking down the
 * list should keep extending from the same origin.
 */
export function selectRange(
  state: IssueSelectionState,
  orderedIds: readonly string[],
  id: string
): IssueSelectionState {
  const to = orderedIds.indexOf(id)
  if (to === -1) return state

  const from = state.anchor === null ? -1 : orderedIds.indexOf(state.anchor)
  if (from === -1) return { selected: new Set(state.selected).add(id), anchor: id }

  const [start, end] = from <= to ? [from, to] : [to, from]
  const selected = new Set(state.selected)
  for (let index = start; index <= end; index += 1) selected.add(orderedIds[index])
  return { selected, anchor: state.anchor }
}

export function clearSelection(): IssueSelectionState {
  return { selected: new Set<string>(), anchor: null }
}

/** Select every row currently on screen; a second call clears. */
export function toggleSelectAll(
  state: IssueSelectionState,
  orderedIds: readonly string[]
): IssueSelectionState {
  const allSelected = orderedIds.length > 0 && orderedIds.every((id) => state.selected.has(id))
  if (allSelected) return clearSelection()
  return { selected: new Set(orderedIds), anchor: state.anchor }
}

/**
 * Drop ids that are no longer on screen.
 *
 * Returns the SAME state object when nothing changed, so callers can use it in
 * a `setState` without provoking a render loop — this runs on every result-set
 * change, which is every keystroke in the search box.
 */
export function pruneSelection(
  state: IssueSelectionState,
  presentIds: readonly string[]
): IssueSelectionState {
  const present = new Set(presentIds)
  let dropped = false
  const selected = new Set<string>()
  for (const id of state.selected) {
    if (present.has(id)) selected.add(id)
    else dropped = true
  }
  const anchorGone = state.anchor !== null && !present.has(state.anchor)
  if (!dropped && !anchorGone) return state
  return { selected, anchor: anchorGone ? null : state.anchor }
}

/**
 * The row the keyboard cursor moves to. Wraps at neither end — running off the
 * bottom of a list and reappearing at the top loses the user's place.
 */
export function stepCursor(
  orderedIds: readonly string[],
  current: string | undefined,
  direction: 1 | -1
): string | undefined {
  if (orderedIds.length === 0) return undefined
  if (current === undefined)
    return direction === 1 ? orderedIds[0] : orderedIds[orderedIds.length - 1]
  const index = orderedIds.indexOf(current)
  if (index === -1) return orderedIds[0]
  const next = index + direction
  if (next < 0 || next >= orderedIds.length) return current
  return orderedIds[next]
}
