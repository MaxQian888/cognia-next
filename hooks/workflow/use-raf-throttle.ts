"use client"

/**
 * Generic `requestAnimationFrame` coalescer.
 *
 * Used by every pointer-move-rate handler in the visual workflow editor:
 *   - drag-time alignment-guide computation
 *   - lasso pointer-move
 *   - connection-preview pointer-move
 *   - viewport-breadcrumb recomputation on pan
 *
 * Behaviour:
 *   - `call(...args)` stores the latest args and schedules a single frame if
 *     none is pending. Latest args win — earlier calls in the same frame are
 *     discarded.
 *   - `flush()` cancels any pending frame and invokes `fn` immediately with
 *     the most recent args (no-op if no args have arrived).
 *   - `cancel()` discards both the pending frame and the latest args.
 *   - On unmount, any pending frame is cancelled.
 *
 * The returned `call` / `flush` / `cancel` identities are stable across
 * renders, so callers can pass them to `useEffect` dependency arrays or
 * memoized children without busting memoization. The wrapped `fn` is held
 * in a ref so the latest closure is always invoked even though `call`'s
 * identity is stable.
 */

import { useCallback, useEffect, useRef } from "react"

export interface RafThrottleHandle<TArgs extends readonly unknown[]> {
  call: (...args: TArgs) => void
  flush: () => void
  cancel: () => void
}

export function useRafThrottle<TArgs extends readonly unknown[]>(
  fn: (...args: TArgs) => void
): RafThrottleHandle<TArgs> {
  const fnRef = useRef(fn)
  // Keep the ref pointed at the latest closure without triggering a
  // re-render. The `useEffect` runs after commit, which is correct here:
  // any frame that fires between render and effect would pick up the
  // previous closure, which is fine because args are also captured at
  // call-time (not at frame-time).
  useEffect(() => {
    fnRef.current = fn
  }, [fn])

  // Pending flag and frame id are tracked separately so a synchronous-firing
  // rAF (some test polyfills, some browser edge cases) doesn't leave us
  // thinking a frame is still in flight after `drain` already ran.
  const pendingRef = useRef(false)
  const frameIdRef = useRef<number | null>(null)
  const argsRef = useRef<TArgs | null>(null)

  const drain = useCallback(() => {
    pendingRef.current = false
    frameIdRef.current = null
    const args = argsRef.current
    argsRef.current = null
    if (args !== null) {
      fnRef.current(...args)
    }
  }, [])

  const call = useCallback(
    (...args: TArgs) => {
      argsRef.current = args
      if (typeof requestAnimationFrame === "undefined") {
        // SSR / Node without rAF polyfill: invoke synchronously so the hook
        // degrades gracefully instead of dropping calls on the floor.
        argsRef.current = null
        fnRef.current(...args)
        return
      }
      if (pendingRef.current) return
      pendingRef.current = true
      const id = requestAnimationFrame(drain)
      // Only record the id if `drain` hasn't already fired (e.g. when the
      // host implementation invokes the callback synchronously).
      if (pendingRef.current) frameIdRef.current = id
    },
    [drain]
  )

  const flush = useCallback(() => {
    if (frameIdRef.current !== null && typeof cancelAnimationFrame !== "undefined") {
      cancelAnimationFrame(frameIdRef.current)
    }
    pendingRef.current = false
    frameIdRef.current = null
    const args = argsRef.current
    argsRef.current = null
    if (args !== null) {
      fnRef.current(...args)
    }
  }, [])

  const cancel = useCallback(() => {
    if (frameIdRef.current !== null && typeof cancelAnimationFrame !== "undefined") {
      cancelAnimationFrame(frameIdRef.current)
    }
    pendingRef.current = false
    frameIdRef.current = null
    argsRef.current = null
  }, [])

  // Unmount cleanup — cancel any pending frame so the handler doesn't fire
  // against a stale closure / unmounted tree.
  useEffect(() => {
    return () => {
      if (frameIdRef.current !== null && typeof cancelAnimationFrame !== "undefined") {
        cancelAnimationFrame(frameIdRef.current)
      }
      pendingRef.current = false
      frameIdRef.current = null
      argsRef.current = null
    }
  }, [])

  return { call, flush, cancel }
}
