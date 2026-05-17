"use client"

/**
 * Gated wrapper around `dexie-react-hooks`' `useLiveQuery`.
 *
 * When `enabled === false`, the querier returns the previously resolved value
 * held in a ref, so noisy live-tables (e.g. `workflowRunEvents` streaming
 * during a workflow run) stop re-evaluating expensive consumers (CodeMirror
 * editors in the inspector) while the user is actively dragging a node on
 * the canvas.
 *
 * When `enabled` flips back to `true`, the next render's dependency change
 * re-issues a fresh fetch.
 */

import { useCallback, useRef } from "react"
import { useLiveQuery } from "dexie-react-hooks"

export function useGatedLiveQuery<T>(
  querier: () => T | Promise<T>,
  deps: ReadonlyArray<unknown>,
  defaultResult: T,
  enabled: boolean
): T {
  const lastRef = useRef<T>(defaultResult)

  // Materialize a dep array literal up-front so React Compiler can analyse
  // the useCallback deps. We then thread the same merged array to useLiveQuery.
  const mergedDeps = [enabled, ...deps]

  /* eslint-disable react-hooks/exhaustive-deps -- callers pass a fresh querier each render; closure capture is intentional, deps controlled via `deps`. */
  /* eslint-disable react-hooks/use-memo -- spread dep array is intentional; the rule wants a literal but we forward a caller-supplied list. */
  const gatedQuerier = useCallback(async (): Promise<T> => {
    if (!enabled) {
      return lastRef.current
    }
    const raw = querier()
    const resolved = raw instanceof Promise ? await raw : raw
    lastRef.current = resolved
    return resolved
  }, mergedDeps)
  /* eslint-enable react-hooks/exhaustive-deps */
  /* eslint-enable react-hooks/use-memo */

  const result = useLiveQuery<T, T>(gatedQuerier, mergedDeps, defaultResult)
  // `useLiveQuery` can return `undefined` between the first render and the
  // resolver's first microtask; fall back to the last value (which is the
  // default until any real result lands) so consumers never see undefined.
  // eslint-disable-next-line react-hooks/refs -- reading lastRef during render is the fallback path; the ref is updated in the querier (an effect-equivalent context).
  return result === undefined ? lastRef.current : result
}
