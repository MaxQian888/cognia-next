/**
 * Waiting for a companion Host's feature manifest — the retry policy both
 * companion boots share.
 *
 * The web companion (`WebCompanionBootProvider`) and the phone
 * (`CompanionBootProvider`) both open their Host bindings by asking for
 * `host_feature_manifest`. That first call routinely fails for reasons that
 * fix themselves: the phone opened without network, the relay or WebRTC
 * carrier is still coming up, the Host is restarting. A boot that treats that
 * first failure as final stays "Host offline" until the app is restarted,
 * however healthy the link becomes afterwards. This module is the one place
 * that decides how long to wait between attempts and when to stop.
 *
 * Framework-free: callers inject the load, the cancellation probe and the
 * sleep, so each provider keeps its own lifetime and snapshot wording.
 */

import type { CompanionErrorInit } from "@/lib/tauri/companion-problem"

/** Our own retry schedule, used whenever the Host does not name a wait. */
export const HOST_RECOVERY_BACKOFF_MS = [250, 1_000, 4_000, 16_000, 30_000] as const

/** A Host's verdict on a rejected call, as carried by `CompanionError`. */
export type HostRefusal = CompanionErrorInit

/**
 * Read the Host's own verdict off a rejected call.
 *
 * Shape-checked rather than `instanceof CompanionError`: the error crosses a
 * module boundary, and a class identity that does not survive that boundary
 * would make this guard throw inside the very `catch` meant to handle the
 * failure — turning a retryable blip into a dead boot.
 */
export function hostRefusal(error: unknown): HostRefusal | null {
  if (typeof error !== "object" || error === null) return null
  const candidate = error as { code?: unknown; retryable?: unknown; retryAfterMs?: unknown }
  if (typeof candidate.code !== "string" || typeof candidate.retryable !== "boolean") return null
  return {
    code: candidate.code,
    message: error instanceof Error ? error.message : String(error),
    retryable: candidate.retryable,
    ...(typeof candidate.retryAfterMs === "number" &&
    Number.isFinite(candidate.retryAfterMs) &&
    candidate.retryAfterMs >= 0
      ? { retryAfterMs: candidate.retryAfterMs }
      : {}),
  }
}

/**
 * The scheduled wait for `attempt` (0-based), ±15% jitter so a fleet of
 * clients that lost the same Host does not retry in lockstep. Attempts past
 * the end of the schedule stay on its last step.
 */
export function jitteredBackoffMs(attempt: number, random: () => number = Math.random): number {
  const base =
    HOST_RECOVERY_BACKOFF_MS[Math.min(Math.max(0, attempt), HOST_RECOVERY_BACKOFF_MS.length - 1)]
  return Math.round(base * (0.85 + random() * 0.3))
}

/**
 * How long to wait before attempt `attempt + 1`.
 *
 * When the Host names a wait, take it: our own schedule is what keeps a rate
 * limit pinned. A wait of zero is not a wait, though — honouring it verbatim
 * would drop the backoff entirely and spin the caller with no pause at all.
 * Zero (and anything absent) falls back to our own schedule.
 */
export function hostRetryDelayMs(
  attempt: number,
  hostAskedMs: number | undefined,
  random: () => number = Math.random
): number {
  return hostAskedMs !== undefined && hostAskedMs > 0
    ? hostAskedMs
    : jitteredBackoffMs(attempt, random)
}

export interface HostManifestRetry {
  error: unknown
  /** The Host's verdict when the failure carried one (always retryable here). */
  refusal: HostRefusal | null
  /** 0-based index of the attempt that just failed. */
  attempt: number
  /** The wait about to start. */
  delayMs: number
}

export type HostManifestWaitOutcome<T> =
  | { kind: "loaded"; value: T }
  | { kind: "refused"; refusal: HostRefusal; error: unknown }
  | { kind: "cancelled" }

export interface WaitForHostManifestOptions<T> {
  /** One attempt. A rejection is classified; a resolution ends the wait. */
  load: () => Promise<T>
  /** Probed before every attempt and after every failure. */
  isCancelled: () => boolean
  /** A retryable failure; the caller publishes its "connecting" state here. */
  onRetry?: (retry: HostManifestRetry) => void
  /**
   * The wait between attempts. May resolve early (a carrier came back) and
   * should resolve when the caller is torn down — the loop re-checks
   * `isCancelled` after every wait.
   */
  sleep: (ms: number) => Promise<void>
  random?: () => number
}

/**
 * Retry `load` until it resolves, the Host refuses deterministically, or the
 * caller is cancelled.
 *
 * The Host answers every refusal with `retryable`, and a deterministic refusal
 * (a contract violation, a revoked grant) must not be retried on the schedule
 * of a dropped packet: the retries would spend the device's remote-execution
 * quota until the Host answers 429 to everything — a second failure, caused
 * entirely by the response to the first, and one that hides it.
 */
export async function waitForHostManifest<T>(
  options: WaitForHostManifestOptions<T>
): Promise<HostManifestWaitOutcome<T>> {
  const { load, isCancelled, onRetry, sleep, random = Math.random } = options
  let attempt = 0
  while (!isCancelled()) {
    try {
      return { kind: "loaded", value: await load() }
    } catch (error) {
      if (isCancelled()) return { kind: "cancelled" }
      const refusal = hostRefusal(error)
      if (refusal && !refusal.retryable) return { kind: "refused", refusal, error }
      const delayMs = hostRetryDelayMs(attempt, refusal?.retryAfterMs, random)
      onRetry?.({ error, refusal, attempt, delayMs })
      attempt++
      await sleep(delayMs)
    }
  }
  return { kind: "cancelled" }
}

export interface WakeableSleep {
  /** Wait `ms`, or less if woken. Resolves at once after `dispose`. */
  sleep(ms: number): Promise<void>
  /**
   * End the current wait now. With no wait in progress the next one returns
   * at once instead: a carrier that came back while an attempt was in flight
   * still earns an immediate retry when that attempt fails.
   */
  wake(): void
  /** Clear the timer and release any waiter; every later wait is instant. */
  dispose(): void
}

/** A sleep for {@link waitForHostManifest} that a link-up event can cut short. */
export function createWakeableSleep(): WakeableSleep {
  let timer: ReturnType<typeof setTimeout> | null = null
  let release: (() => void) | null = null
  let wakePending = false
  let disposed = false

  const settle = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    const resolve = release
    release = null
    resolve?.()
  }

  return {
    sleep(ms) {
      if (disposed) return Promise.resolve()
      if (wakePending) {
        wakePending = false
        return Promise.resolve()
      }
      settle()
      return new Promise<void>((resolve) => {
        release = resolve
        timer = setTimeout(settle, ms)
      })
    },
    wake() {
      if (disposed) return
      if (release) settle()
      else wakePending = true
    },
    dispose() {
      disposed = true
      wakePending = false
      settle()
    },
  }
}
