"use client"

/**
 * Selection + keyboard cursor for the issue list.
 *
 * All the decisions live in `lib/issues/selection.ts`; this holds the state and
 * keeps it honest against the rows currently on screen.
 *
 * Pruning is DERIVED during render rather than written back in an effect. Two
 * reasons: this repo bans `setState` inside an effect (it is a render loop
 * waiting for a `pruneSelection` that forgets to return its input unchanged),
 * and deriving means a row filtered away and then filtered back comes back
 * still selected. What matters is that nothing outside this hook ever sees a
 * selected id that is not on screen, so a bulk action cannot write to a row the
 * user cannot see.
 */

import { useCallback, useMemo, useState } from "react"

import {
  clearSelection,
  EMPTY_ISSUE_SELECTION,
  pruneSelection,
  selectRange,
  stepCursor,
  toggleSelectAll,
  toggleSelection,
  type IssueSelectionState,
} from "@/lib/issues/selection"

export interface IssueSelection {
  /** Only ids present in `orderedIds`. Never a stale row. */
  selectedIds: ReadonlySet<string>
  /** The keyboard cursor's row, independent of what is checked. */
  cursorId: string | undefined
  setCursorId: (id: string | undefined) => void
  toggle: (id: string) => void
  extendTo: (id: string) => void
  toggleAll: () => void
  clear: () => void
  moveCursor: (direction: 1 | -1) => string | undefined
}

export function useIssueSelection(orderedIds: readonly string[]): IssueSelection {
  const [raw, setRaw] = useState<IssueSelectionState>(EMPTY_ISSUE_SELECTION)
  const [rawCursor, setRawCursor] = useState<string | undefined>(undefined)

  const state = useMemo(() => pruneSelection(raw, orderedIds), [raw, orderedIds])
  const cursorId = rawCursor !== undefined && orderedIds.includes(rawCursor) ? rawCursor : undefined

  const toggle = useCallback((id: string) => setRaw((current) => toggleSelection(current, id)), [])
  const extendTo = useCallback(
    (id: string) =>
      setRaw((current) => selectRange(pruneSelection(current, orderedIds), orderedIds, id)),
    [orderedIds]
  )
  const toggleAll = useCallback(
    () => setRaw((current) => toggleSelectAll(pruneSelection(current, orderedIds), orderedIds)),
    [orderedIds]
  )
  const clear = useCallback(() => setRaw(clearSelection()), [])

  const moveCursor = useCallback(
    (direction: 1 | -1) => {
      const next = stepCursor(orderedIds, cursorId, direction)
      setRawCursor(next)
      return next
    },
    [orderedIds, cursorId]
  )

  return {
    selectedIds: state.selected,
    cursorId,
    setCursorId: setRawCursor,
    toggle,
    extendTo,
    toggleAll,
    clear,
    moveCursor,
  }
}
