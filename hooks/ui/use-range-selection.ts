"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

export interface RangeSelectionMouseEvent {
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

export interface UseRangeSelectionResult {
  selected: ReadonlySet<string>
  anchorId: string | null
  /** True iff the most recent `handleClick` used Ctrl/Cmd or Shift. */
  lastInteractionWasModified: boolean
  /** Modifier-aware click handler. The caller decides whether to also fire its own onSelect. */
  handleClick: (id: string, e: RangeSelectionMouseEvent) => void
  selectAll: () => void
  clear: () => void
  isSelected: (id: string) => boolean
}

/**
 * File-manager-style multi-select state. Pure React; no Zustand.
 *
 * Click semantics (`event.ctrlKey || event.metaKey` is treated as Ctrl):
 * - plain        → selection := {id}, anchor := id
 * - Ctrl         → toggle id ∈ selection, anchor := id
 * - Shift        → selection := range(anchor, id) (or {id} when no anchor yet)
 * - Ctrl+Shift   → selection := selection ∪ range(anchor, id) (anchor unchanged)
 *
 * `selectAll()` replaces selection with every id in `orderedIds`; `clear()`
 * empties both selection and anchor. When `orderedIds` shrinks, ids that
 * vanished are filtered out lazily when callers read `selected` /
 * `anchorId` — the underlying state isn't mutated, but consumers never see
 * stale targets, which is what the channel-list cares about.
 */
export function useRangeSelection(orderedIds: readonly string[]): UseRangeSelectionResult {
  const [rawSelected, setRawSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [rawAnchor, setRawAnchor] = useState<string | null>(null)
  const [lastInteractionWasModified, setLastInteractionWasModified] = useState(false)

  // Mirror the anchor into a ref so `handleClick` can read it without
  // listing it as a useCallback dependency. Each click would otherwise
  // rebuild `handleClick`, recreating every SessionRow's `onSelect` prop
  // and defeating React.memo on the rows.
  const rawAnchorRef = useRef<string | null>(rawAnchor)
  useEffect(() => {
    rawAnchorRef.current = rawAnchor
  }, [rawAnchor])

  // Externally-visible selection: drop entries that are no longer in
  // `orderedIds`. Doing this in a `useMemo` avoids the "setState in effect"
  // anti-pattern (rule `react-hooks/set-state-in-effect`); raw state stays
  // authoritative, the view is derived.
  const selected = useMemo<ReadonlySet<string>>(() => {
    if (rawSelected.size === 0) return rawSelected
    const valid = new Set(orderedIds)
    if (orderedIds.length === 0) return new Set()
    let allStillPresent = true
    for (const id of rawSelected) {
      if (!valid.has(id)) {
        allStillPresent = false
        break
      }
    }
    if (allStillPresent) return rawSelected
    const next = new Set<string>()
    for (const id of rawSelected) if (valid.has(id)) next.add(id)
    return next
  }, [rawSelected, orderedIds])

  const anchorId = useMemo<string | null>(() => {
    if (rawAnchor === null) return null
    return orderedIds.includes(rawAnchor) ? rawAnchor : null
  }, [rawAnchor, orderedIds])

  const handleClick = useCallback(
    (id: string, e: RangeSelectionMouseEvent) => {
      const ctrl = e.ctrlKey || e.metaKey
      const shift = e.shiftKey
      const ids = orderedIds
      setLastInteractionWasModified(ctrl || shift)

      if (shift) {
        // Range from the current visible anchor → id (inclusive). The
        // anchor is read through a ref so the click handler doesn't have
        // to depend on `rawAnchor` (which would invalidate it after every
        // click and break SessionRow memoization).
        const currentAnchor = rawAnchorRef.current
        const visibleAnchor =
          currentAnchor !== null && ids.includes(currentAnchor) ? currentAnchor : null
        if (visibleAnchor === null) {
          setRawSelected(new Set([id]))
          setRawAnchor(id)
          return
        }
        const a = ids.indexOf(visibleAnchor)
        const b = ids.indexOf(id)
        if (a === -1 || b === -1) {
          setRawSelected(new Set([id]))
          setRawAnchor(id)
          return
        }
        const [lo, hi] = a <= b ? [a, b] : [b, a]
        const range = ids.slice(lo, hi + 1)
        if (ctrl) {
          // Additive Shift+Ctrl: union with the current selection.
          setRawSelected((prev) => {
            const next = new Set(prev)
            for (const rid of range) next.add(rid)
            return next
          })
          return
        }
        setRawSelected(new Set(range))
        // Plain Shift leaves the anchor in place so successive Shift-clicks
        // continue to extend from the original anchor (Explorer behavior).
        return
      }

      if (ctrl) {
        setRawSelected((prev) => {
          const next = new Set(prev)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
        setRawAnchor(id)
        return
      }

      setRawSelected(new Set([id]))
      setRawAnchor(id)
    },
    [orderedIds]
  )

  const selectAll = useCallback(() => {
    const ids = orderedIds
    setRawSelected((prev) => {
      if (prev.size === ids.length && ids.every((id) => prev.has(id))) return prev
      return new Set(ids)
    })
    setRawAnchor((prev) => {
      const next = ids.length > 0 ? ids[ids.length - 1] : null
      return prev === next ? prev : next
    })
    setLastInteractionWasModified((prev) => (prev === true ? prev : true))
  }, [orderedIds])

  // Guarded with previous-value setters so a caller that invokes `clear()`
  // when state is already empty (e.g. the channel-list's mount-time effect)
  // does NOT trigger a redundant re-render.
  const clear = useCallback(() => {
    setRawSelected((prev) => (prev.size === 0 ? prev : new Set()))
    setRawAnchor((prev) => (prev === null ? prev : null))
    setLastInteractionWasModified((prev) => (prev === false ? prev : false))
  }, [])

  const isSelected = useCallback((id: string) => selected.has(id), [selected])

  return {
    selected,
    anchorId,
    lastInteractionWasModified,
    handleClick,
    selectAll,
    clear,
    isSelected,
  }
}
