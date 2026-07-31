"use client"

/**
 * `useStableCallback(fn)` — returns a callback whose identity NEVER changes
 * while always invoking the latest `fn`.
 *
 * Use it where a callback prop crosses a `React.memo` boundary that compares
 * callbacks by identity (e.g. `MessageRenderer`'s comparator): upstream
 * re-renders (session liveQuery refreshes, workspace state) rebuild inline
 * closures and would otherwise bust the memo for every mounted row, even
 * though the behavior of the callback is unchanged.
 *
 * The latest `fn` is committed via `useInsertionEffect` (the earliest effect
 * phase) so event handlers fired from layout effects already see the fresh
 * closure. The returned identity must never be invoked DURING render — it is
 * an event-handler contract, same as React's proposed `useEffectEvent`.
 */
import { useCallback, useInsertionEffect, useRef } from "react"

export function useStableCallback<Args extends unknown[], R>(
  fn: (...args: Args) => R
): (...args: Args) => R {
  const ref = useRef(fn)
  useInsertionEffect(() => {
    ref.current = fn
  })
  return useCallback((...args: Args) => ref.current(...args), [])
}
