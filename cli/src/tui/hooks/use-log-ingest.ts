/**
 * Owns the single log coalescer + the external-agent subscriptions for the app's
 * lifetime, and hands a stable `pushLog` to everything that produces log lines.
 *
 * Mounted ONCE (in `App`), never per turn: the external-agent event emitter is a
 * bare `EventEmitter` with the default 10-listener cap, and a
 * `MaxListenersExceededWarning` would print to stderr — straight through the Ink
 * frame.
 */
import { useCallback, useEffect, useMemo } from "react"
import type { Dispatch } from "react"

import { createLogCoalescer, type LogTimers } from "../runtime/log-buffer"
import { startLogIngest, type LogIngestSubscriptions } from "../runtime/log-ingest"
import type { LogInput, TuiAction } from "../state/types"

export interface UseLogIngestOptions {
  dispatch: Dispatch<TuiAction>
  timers?: LogTimers
  subs?: LogIngestSubscriptions
  intervalMs?: number
  captureStdout?: boolean
  now?: () => number
}

export interface LogIngestHandle {
  /** Push one line into the coalescer (batched into `LOG_APPEND_BATCH`). */
  pushLog: (entry: LogInput) => void
  /** Empty the buffer, dropping anything still in flight. */
  clearLogs: () => void
}

export function useLogIngest({
  dispatch,
  timers,
  subs,
  intervalMs,
  captureStdout,
  now = Date.now,
}: UseLogIngestOptions): LogIngestHandle {
  // Keyed on `dispatch` alone (stable from `useReducer`). Rebuilding this per
  // render would hand every render a fresh, empty pending array and silently
  // drop lines mid-window.
  const coalescer = useMemo(
    () =>
      createLogCoalescer({
        flush: (entries) => dispatch({ type: "LOG_APPEND_BATCH", entries }),
        ...(timers ? { timers } : {}),
        ...(intervalMs === undefined ? {} : { intervalMs }),
      }),
    [dispatch, timers, intervalMs]
  )

  useEffect(() => () => coalescer.dispose(), [coalescer])

  useEffect(
    () =>
      startLogIngest({
        emit: coalescer.push,
        now,
        ...(subs ? { subs } : {}),
        ...(captureStdout === undefined ? {} : { captureStdout }),
      }),
    [coalescer, now, subs, captureStdout]
  )

  const pushLog = useCallback((entry: LogInput) => coalescer.push(entry), [coalescer])

  const clearLogs = useCallback(() => {
    // Order matters: without discarding first, lines already queued would land
    // a frame after the clear and the panel would look like it failed to clear.
    coalescer.discardPending()
    dispatch({ type: "LOG_CLEAR" })
  }, [coalescer, dispatch])

  return { pushLog, clearLogs }
}
