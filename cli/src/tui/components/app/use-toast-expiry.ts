/**
 * Auto-expiry for transient toasts. The reducer stays pure (no clock), so the
 * "dismiss this toast after N ms" timing lives here as an effect: each new toast
 * schedules a `TOAST_DISMISS` after a severity-dependent TTL (errors linger
 * longest). Timers are injectable so the behavior unit-tests deterministically
 * without real wall-clock waits.
 */
import { useEffect, useRef } from "react"
import type { Dispatch } from "react"
import type { Toast, ToastSeverity, TuiAction } from "../../state/types"

/** Default time-to-live per severity (ms). Errors stay up longest. */
export function defaultToastTtl(severity: ToastSeverity): number {
  switch (severity) {
    case "error":
      return 8000
    case "warn":
      return 6000
    default:
      return 4000
  }
}

/** Injectable timer surface (defaults to the global timers). */
export interface ToastTimers {
  set: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>
  clear: (h: ReturnType<typeof setTimeout>) => void
}

const realTimers: ToastTimers = {
  set: (cb, ms) => setTimeout(cb, ms),
  clear: (h) => clearTimeout(h),
}

export interface ToastExpiryOptions {
  ttlFor?: (severity: ToastSeverity) => number
  timers?: ToastTimers
}

/**
 * Schedule a `TOAST_DISMISS` for each live toast exactly once. Toasts that were
 * already dismissed (dropped from the array) have their pending timer cleared;
 * all timers are cleared on unmount.
 */
export function useToastExpiry(
  toasts: Toast[],
  dispatch: Dispatch<TuiAction>,
  options: ToastExpiryOptions = {}
): void {
  const ttlFor = options.ttlFor ?? defaultToastTtl
  const timers = options.timers ?? realTimers
  // id → pending timer handle. Persist across renders so we schedule each toast once.
  const scheduled = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  useEffect(() => {
    const live = new Set(toasts.map((t) => t.id))
    // Schedule any newly-arrived toast.
    for (const toast of toasts) {
      if (scheduled.current.has(toast.id)) continue
      const handle = timers.set(() => {
        scheduled.current.delete(toast.id)
        dispatch({ type: "TOAST_DISMISS", id: toast.id })
      }, ttlFor(toast.severity))
      scheduled.current.set(toast.id, handle)
    }
    // Clear timers for toasts that were dismissed out from under us (e.g. capped
    // out, or a manual dismiss) so we never fire a dangling dismiss.
    for (const [id, handle] of scheduled.current) {
      if (!live.has(id)) {
        timers.clear(handle)
        scheduled.current.delete(id)
      }
    }
  }, [toasts, dispatch, ttlFor, timers])

  // Clear every pending timer on unmount.
  useEffect(() => {
    const map = scheduled.current
    return () => {
      for (const handle of map.values()) timers.clear(handle)
      map.clear()
    }
  }, [timers])
}
