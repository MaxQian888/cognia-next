"use client"

/**
 * Auto-retry a tripped error boundary once connectivity returns.
 *
 * For `offline` / `network` error categories (see `lib/error/classify-error`),
 * the recovery the user wants is "retry as soon as I'm back online". This hook
 * watches an `online` flag (sourced from `useNetworkStatus`) and, on an
 * offline→online transition, runs a short visible countdown before calling
 * `onRetry` (the boundary's `reset`). The countdown is cancelable so an
 * accidental reconnect doesn't yank the page out from under the user.
 *
 * Disabled (or absent `onRetry`) → the hook is inert and never starts a timer.
 */

import { useCallback, useEffect, useRef, useState } from "react"

export interface UseAutoRetryOnReconnectOptions {
  /** Only arm when the error is connectivity-related AND a reset exists. */
  enabled: boolean
  /** Live connectivity from `useNetworkStatus`. */
  online: boolean
  /** Invoked when the countdown reaches zero (typically the boundary `reset`). */
  onRetry: () => void
  /** Visible countdown length before retrying. Default 3s. */
  countdownSeconds?: number
}

export interface UseAutoRetryOnReconnectResult {
  /** A countdown is currently running. */
  pending: boolean
  /** Seconds remaining (0 when idle). */
  secondsLeft: number
  /** Abort the current countdown without retrying. */
  cancel: () => void
}

export function useAutoRetryOnReconnect({
  enabled,
  online,
  onRetry,
  countdownSeconds = 3,
}: UseAutoRetryOnReconnectOptions): UseAutoRetryOnReconnectResult {
  const [secondsLeft, setSecondsLeft] = useState(0)
  const [pending, setPending] = useState(false)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const wasOnlineRef = useRef(online)
  // Keep the latest onRetry without re-arming the reconnect effect each render.
  const onRetryRef = useRef(onRetry)
  useEffect(() => {
    onRetryRef.current = onRetry
  }, [onRetry])

  const clearTimer = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
  }, [])

  const cancel = useCallback(() => {
    clearTimer()
    setPending(false)
    setSecondsLeft(0)
  }, [clearTimer])

  // Detect the offline→online transition and start the countdown.
  useEffect(() => {
    const wasOffline = wasOnlineRef.current === false
    wasOnlineRef.current = online

    if (!enabled) {
      // Stay inert; never auto-retry when not armed.
      return
    }
    if (!(wasOffline && online)) {
      return
    }
    if (intervalRef.current !== null) {
      return
    }

    // Starting the countdown is the whole point of reacting to the transition.
    setPending(true)
    setSecondsLeft(countdownSeconds)
    intervalRef.current = setInterval(() => {
      setSecondsLeft((prev) => {
        if (prev <= 1) {
          clearTimer()
          setPending(false)
          onRetryRef.current()
          return 0
        }
        return prev - 1
      })
    }, 1000)
  }, [enabled, online, countdownSeconds, clearTimer])

  // If the hook is disabled mid-countdown (e.g. category changed), stand down.
  useEffect(() => {
    if (!enabled && intervalRef.current !== null) {
      cancel()
    }
  }, [enabled, cancel])

  // Cleanup on unmount.
  useEffect(() => clearTimer, [clearTimer])

  return { pending, secondsLeft, cancel }
}
