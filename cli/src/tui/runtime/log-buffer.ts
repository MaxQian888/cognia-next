/**
 * Burst coalescer for the unified log buffer.
 *
 * The problem it solves: `MCP_LOG_APPEND` dispatches once PER LINE, and each
 * dispatch both copies the whole ring buffer and drives an Ink repaint. A
 * server that dumps 500 stderr lines in a second therefore costs 500 renders
 * and 500 full-buffer copies. This module accumulates arrivals in a fixed
 * window and emits ONE `LOG_APPEND_BATCH` per flush, turning that into a
 * handful of renders and one copy each.
 *
 * Timers are injectable (same seam as `use-toast-expiry.ts`) so the windowing
 * unit-tests deterministically without wall-clock waits. There is no clock read
 * here — entry timestamps are stamped at the ingest site.
 */
import { clampMessage } from "./log-model"
import type { LogInput } from "../state/types"

/** Injectable timer surface (defaults to the global timers). */
export interface LogTimers {
  set: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>
  clear: (h: ReturnType<typeof setTimeout>) => void
}

const realTimers: LogTimers = {
  set: (cb, ms) => setTimeout(cb, ms),
  clear: (h) => clearTimeout(h),
}

/** Flush window (ms). 80ms caps repaints at ~12/s however fast logs arrive. */
export const DEFAULT_FLUSH_MS = 80

/** Pending-size at which a flush fires immediately, so a pathological burst
 *  can't grow the pending array without bound between ticks. */
export const DEFAULT_MAX_PENDING = 500

export interface LogCoalescerDeps {
  /** Receives one batch per flush — the hook wires this to `dispatch`. */
  flush: (entries: LogInput[]) => void
  timers?: LogTimers
  intervalMs?: number
  maxPending?: number
  clampChars?: number
}

export interface LogCoalescer {
  push: (entry: LogInput) => void
  /** Flush synchronously (used by the overflow path and by tests). */
  flushNow: () => void
  /** Drop pending WITHOUT flushing — used by the panel's clear action so
   *  in-flight lines don't reappear a frame after the buffer is emptied. */
  discardPending: () => void
  /** Stop the timer and drop pending. Never flushes: dispatching into an
   *  unmounted reducer is a React warning. Idempotent. */
  dispose: () => void
}

export function createLogCoalescer(deps: LogCoalescerDeps): LogCoalescer {
  const timers = deps.timers ?? realTimers
  const intervalMs = deps.intervalMs ?? DEFAULT_FLUSH_MS
  const maxPending = deps.maxPending ?? DEFAULT_MAX_PENDING
  const clampChars = deps.clampChars

  let pending: LogInput[] = []
  let handle: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const disarm = () => {
    if (handle !== null) {
      timers.clear(handle)
      handle = null
    }
  }

  const flushNow = () => {
    disarm()
    if (pending.length === 0) return
    const batch = pending
    pending = []
    deps.flush(batch)
  }

  const push = (entry: LogInput) => {
    if (disposed) return
    pending.push(
      clampChars === undefined
        ? { ...entry, message: clampMessage(entry.message) }
        : { ...entry, message: clampMessage(entry.message, clampChars) }
    )
    if (pending.length >= maxPending) {
      flushNow()
      return
    }
    // FIXED WINDOW, not a debounce: the timer is armed by the first push of a
    // window and never re-armed by later ones. Re-arming on every push would
    // starve the flush forever under a continuous stream — the classic bug for
    // this shape.
    if (handle === null) {
      handle = timers.set(() => {
        handle = null
        if (pending.length === 0) return
        const batch = pending
        pending = []
        deps.flush(batch)
      }, intervalMs)
    }
  }

  return {
    push,
    flushNow,
    discardPending: () => {
      pending = []
      disarm()
    },
    dispose: () => {
      disposed = true
      pending = []
      disarm()
    },
  }
}
