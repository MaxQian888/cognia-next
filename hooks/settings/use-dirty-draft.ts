"use client"

/**
 * Draft state for a settings form, with an explicit save and an honest dirty
 * set.
 *
 * This exists to fix a specific defect the subagent policy cards shipped with:
 * they hydrated their local state from the settings store inside
 * `useEffect(..., [settings])`, unconditionally. Any save anywhere else in the
 * app publishes a new `settings` object, so an unrelated write would silently
 * overwrite whatever the user was in the middle of typing — no warning, no way
 * to get the value back.
 *
 * The fix is to re-hydrate on *identity* rather than on *reference*: the draft
 * reloads when the thing being edited changes (a different template, a
 * different panel), and at no other time. Concurrent writes to the same
 * settings object are then simply not observed while a draft is open, which is
 * the behaviour a user editing a form expects.
 *
 * State is adjusted during render rather than in an effect — the React 19
 * pattern for deriving state from props, and the one `react-hooks/set-state-in-effect`
 * enforces in this repo.
 */

import { useCallback, useMemo, useState } from "react"

/** Structural comparison for plain settings values (JSON-shaped). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null || typeof a !== "object") return false

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, i) => deepEqual(item, b[i]))
  }

  const aRecord = a as Record<string, unknown>
  const bRecord = b as Record<string, unknown>
  const aKeys = Object.keys(aRecord)
  const bKeys = Object.keys(bRecord)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every((key) => Object.hasOwn(bRecord, key) && deepEqual(aRecord[key], bRecord[key]))
}

export interface DirtyDraft<T extends object> {
  /** Current working values. */
  draft: T
  /** Values as of the last hydrate/commit — what "discard" restores. */
  baseline: T
  /** Replace one field. */
  setField: <K extends keyof T>(key: K, value: T[K]) => void
  /** Merge several fields at once. */
  patch: (partial: Partial<T>) => void
  /** Keys whose draft value differs from the baseline. */
  dirtyKeys: readonly (keyof T)[]
  isDirty: boolean
  /** Throw away edits and go back to the baseline. */
  discard: () => void
  /**
   * Re-baseline after a successful save. Pass the persisted values when the
   * store normalises them (clamping, defaulting); omit to accept the draft.
   */
  commit: (saved?: T) => void
}

/**
 * @param identity Changing this reloads the draft from `initial`. Use the id of
 *                 whatever is being edited — a template id, a panel id.
 * @param initial  Values to hydrate from. Read only when `identity` changes,
 *                 which is the whole point.
 */
export function useDirtyDraft<T extends object>(identity: string, initial: T): DirtyDraft<T> {
  const [state, setState] = useState(() => ({ identity, baseline: initial, draft: initial }))

  // Identity changed → this is a different thing being edited, so reload.
  // Deliberately NOT keyed on `initial`'s reference.
  if (state.identity !== identity) {
    setState({ identity, baseline: initial, draft: initial })
  }

  const setField = useCallback(<K extends keyof T>(key: K, value: T[K]) => {
    setState((prev) => ({ ...prev, draft: { ...prev.draft, [key]: value } }))
  }, [])

  const patch = useCallback((partial: Partial<T>) => {
    setState((prev) => ({ ...prev, draft: { ...prev.draft, ...partial } }))
  }, [])

  const discard = useCallback(() => {
    setState((prev) => ({ ...prev, draft: prev.baseline }))
  }, [])

  const commit = useCallback((saved?: T) => {
    setState((prev) => {
      const next = saved ?? prev.draft
      return { ...prev, baseline: next, draft: next }
    })
  }, [])

  const dirtyKeys = useMemo(() => {
    const keys = new Set<keyof T>([
      ...(Object.keys(state.baseline) as (keyof T)[]),
      ...(Object.keys(state.draft) as (keyof T)[]),
    ])
    return [...keys].filter((key) => !deepEqual(state.baseline[key], state.draft[key]))
  }, [state.baseline, state.draft])

  return {
    draft: state.draft,
    baseline: state.baseline,
    setField,
    patch,
    dirtyKeys,
    isDirty: dirtyKeys.length > 0,
    discard,
    commit,
  }
}
