"use client"

/**
 * Rotation cache for ephemeral TURN credentials. ADR-0021.
 *
 * Wraps `provisionIceServers` in a self-rescheduling loop: provision once
 * immediately, hand the servers to `onRefresh`, then re-provision at ~80%
 * of the credential TTL so the live `RTCConfiguration` never serves an
 * expired relay credential. On a provider error the last-good credentials
 * are retained and a bounded exponential backoff retry is scheduled.
 *
 * Owned by the desktop / mobile signaling controllers (sibling to their
 * settings subscription); `stop()` is called from their uninstall fn and
 * suppresses any in-flight provision callback that lands after teardown.
 */

import { provisionIceServers, type ProvisionResult } from "./turn-provisioning"
import type { TurnProviderConfig } from "@cognia/agent-config-types"

export interface ProvisionerHandle {
  /** Latest provisioned ICE servers; `[]` before the first success. */
  current(): RTCIceServer[]
  /** Stop the loop, cancel the pending timer, and ignore late callbacks. */
  stop(): void
}

export interface StartProvisionerOptions {
  provider: TurnProviderConfig
  /** Called with the fresh ICE servers on every successful (re)provision. */
  onRefresh: (iceServers: RTCIceServer[]) => void
  fetchImpl?: typeof fetch
  nowMs?: () => number
  setTimeoutImpl?: typeof setTimeout
  clearTimeoutImpl?: typeof clearTimeout
  /** Fraction of the TTL after which to refresh. Default 0.8. */
  refreshFraction?: number
  /** Backoff floor / ceiling for retry-after-error. Defaults 5s / 5min. */
  minBackoffMs?: number
  maxBackoffMs?: number
  /** Test seam — defaults to `provisionIceServers`. */
  provisionImpl?: typeof provisionIceServers
}

export function startTurnProvisioner(opts: StartProvisionerOptions): ProvisionerHandle {
  const now = opts.nowMs ?? Date.now
  const setT = opts.setTimeoutImpl ?? setTimeout
  const clearT = opts.clearTimeoutImpl ?? clearTimeout
  const refreshFraction = opts.refreshFraction ?? 0.8
  const minBackoff = opts.minBackoffMs ?? 5_000
  const maxBackoff = opts.maxBackoffMs ?? 300_000
  const provision = opts.provisionImpl ?? provisionIceServers

  let stopped = false
  let cached: RTCIceServer[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let backoff = minBackoff

  const schedule = (ms: number): void => {
    if (stopped) return
    timer = setT(
      () => {
        void refresh()
      },
      Math.max(1_000, ms)
    )
  }

  const refresh = async (): Promise<void> => {
    if (stopped) return
    let result: ProvisionResult
    try {
      result = await provision(opts.provider, { fetchImpl: opts.fetchImpl, nowMs: now })
    } catch {
      if (stopped) return
      // Keep last-good `cached`; retry with bounded exponential backoff.
      const delay = backoff
      backoff = Math.min(maxBackoff, backoff * 2)
      schedule(delay)
      return
    }
    if (stopped) return
    cached = result.iceServers
    backoff = minBackoff
    opts.onRefresh(result.iceServers)
    schedule((result.expiresAt - now()) * refreshFraction)
  }

  void refresh()

  return {
    current: () => cached,
    stop: () => {
      stopped = true
      if (timer !== null) {
        clearT(timer)
        timer = null
      }
    },
  }
}
