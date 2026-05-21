"use client"

/**
 * Generic trailing-edge debounce coalescer.
 *
 * Sibling of `useRafThrottle` for the case where the inner work doesn't
 * have to be frame-paced but still shouldn't fire on every keystroke
 * (zod validation, search queries, autosave writes). The shapes are
 * intentionally identical so callers can swap between rAF coalescing
 * and time-window debouncing without restructuring code.
 *
 * Behaviour:
 *   - `call(...args)` stores the latest args and (re)arms a timer. Each
 *     call within the window resets the timer; only the *latest* args
 *     fire when the window closes.
 *   - `flush()` cancels the pending timer and invokes `fn` immediately
 *     with the most recent args (no-op if no args have arrived).
 *   - `cancel()` discards both the pending timer and the latest args.
 *   - On unmount, any pending timer is cancelled — no stale-closure fire
 *     against an unmounted tree.
 *   - `delayMs <= 0` degrades to synchronous (matches the raf hook's
 *     SSR-no-rAF degradation).
 *
 * The returned `call` / `flush` / `cancel` identities are stable across
 * renders, so callers can pass them to `useEffect` dependency arrays or
 * memoized children without busting memoization. The wrapped `fn` is
 * held in a ref so the latest closure is always invoked even though
 * `call`'s identity is stable.
 */

import { useCallback, useEffect, useRef } from "react"

export interface DebouncedCallbackHandle<TArgs extends readonly unknown[]> {
  call: (...args: TArgs) => void
  flush: () => void
  cancel: () => void
}

export function useDebouncedCallback<TArgs extends readonly unknown[]>(
  fn: (...args: TArgs) => void,
  delayMs: number
): DebouncedCallbackHandle<TArgs> {
  const fnRef = useRef(fn)
  // Keep the ref pointed at the latest closure without triggering a
  // re-render. The `useEffect` runs after commit, which is correct here:
  // any timer that fires between render and effect would pick up the
  // previous closure, which is fine because args are also captured at
  // call-time (not at fire-time).
  useEffect(() => {
    fnRef.current = fn
  }, [fn])

  const delayRef = useRef(delayMs)
  useEffect(() => {
    delayRef.current = delayMs
  }, [delayMs])

  const timerIdRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const argsRef = useRef<TArgs | null>(null)

  const drain = useCallback(() => {
    timerIdRef.current = null
    const args = argsRef.current
    argsRef.current = null
    if (args !== null) {
      fnRef.current(...args)
    }
  }, [])

  const call = useCallback(
    (...args: TArgs) => {
      argsRef.current = args
      if (delayRef.current <= 0) {
        // Zero-delay degrades to synchronous so the hook stays usable in
        // tests / SSR without injecting timer mocks everywhere.
        argsRef.current = null
        fnRef.current(...args)
        return
      }
      if (timerIdRef.current !== null) {
        clearTimeout(timerIdRef.current)
      }
      timerIdRef.current = setTimeout(drain, delayRef.current)
    },
    [drain]
  )

  const flush = useCallback(() => {
    if (timerIdRef.current !== null) {
      clearTimeout(timerIdRef.current)
      timerIdRef.current = null
    }
    const args = argsRef.current
    argsRef.current = null
    if (args !== null) {
      fnRef.current(...args)
    }
  }, [])

  const cancel = useCallback(() => {
    if (timerIdRef.current !== null) {
      clearTimeout(timerIdRef.current)
      timerIdRef.current = null
    }
    argsRef.current = null
  }, [])

  // Unmount cleanup — cancel any pending timer so the handler doesn't
  // fire against a stale closure / unmounted tree.
  useEffect(() => {
    return () => {
      if (timerIdRef.current !== null) {
        clearTimeout(timerIdRef.current)
        timerIdRef.current = null
      }
      argsRef.current = null
    }
  }, [])

  return { call, flush, cancel }
}
