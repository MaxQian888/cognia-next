// Visibility-aware loop that drives `probeOnce` at the user-configured cadence.
//
// Two cadences:
//   - visible:  page is foregrounded (default 5 min)
//   - idle:     page is hidden / no recent interaction (default 30 min)
//
// The loop never runs in the background tab faster than the idle cadence so
// a forgotten browser tab doesn't drain quota on the user's behalf.
//
// On 401: trigger a refresh callback (the hooks layer wires this into
// `refreshAccessToken` + `subscription_save_account` + `subscription_set_active`)
// and retry once. After a successful probe we persist via `recordUsageSnapshot`.
//
// Two guards matter more here than anywhere else in the subscription layer,
// because unlike the free usage endpoint, EVERY probe spends real quota:
//
//   * The cadence is jittered. It is a user setting, so it is identical across
//     every account the user owns and across every window they have open.
//     Un-jittered, those all realign onto the same tick and arrive as one
//     burst.
//   * A failing probe backs off through the shared credential ledger instead of
//     being repeated on the next tick. A loop that answers a 429 by paying for
//     another request every five minutes is both the retry storm and the bill.

import {
  BREAKER_SCOPES,
  credentialKey,
  getSubscriptionBreaker,
  type SubscriptionBreaker,
} from "@/lib/subscription/retry/breaker"
import { jitterCadenceMs } from "@/lib/subscription/retry/backoff"
import { classifySubscriptionFailure } from "@/lib/subscription/retry/failure-class"

import type { AnthropicCredentialData, AnthropicSubscriptionSettings } from "@/types/subscription"
import { isAnthropicCredentialFresh } from "./oauth"
import { probeOnce } from "./usage-probe"
import { recordUsageSnapshot } from "./usage-collector"

export interface SchedulerDeps {
  /** Read the latest credential. Returning null pauses the loop. */
  getCredential: () => Promise<AnthropicCredentialData | null> | AnthropicCredentialData | null
  /** Triggered on 401; should refresh + persist + return the new credential. */
  refresh: (current: AnthropicCredentialData) => Promise<AnthropicCredentialData | null>
  /** Visibility helper — defaulted from `document.visibilityState` in real use. */
  isVisible?: () => boolean
  /** Hook for tests to skip persistence. */
  persist?: typeof recordUsageSnapshot
  /**
   * Account id the probe is spending, used as the ledger key so a block armed
   * by the quota panel and one armed here refer to the same credential.
   * Absent resolves to a shared "active account" key, which still keeps the
   * loop from repeating a failing probe.
   */
  getAccountId?: () => Promise<string | null> | string | null
  /** Injected credential ledger for tests. Defaults to the shared one. */
  breaker?: SubscriptionBreaker
  /** Deterministic jitter source for tests. Defaults to `Math.random`. */
  random?: () => number
  /** Injected clock for tests. Defaults to `Date.now`. */
  now?: () => number
}

/**
 * Ledger key when the caller cannot name the account. The loop only ever
 * probes the active account, so one key for "whichever that is" still stops a
 * failing probe from repeating.
 */
const ACTIVE_ACCOUNT_KEY = "active"

export interface SchedulerHandle {
  /** Stop the loop. Idempotent. */
  stop: () => void
  /** Force a probe outside the cadence. */
  triggerNow: () => Promise<void>
}

export function startUsageScheduler(
  settings: () => Pick<
    AnthropicSubscriptionSettings,
    "probeEnabled" | "visibleIntervalMs" | "idleIntervalMs"
  >,
  deps: SchedulerDeps
): SchedulerHandle {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const isVisible = deps.isVisible ?? defaultIsVisible
  const persist = deps.persist ?? recordUsageSnapshot
  const breaker = deps.breaker ?? getSubscriptionBreaker()
  const now = deps.now ?? Date.now
  const random = deps.random ?? Math.random

  function nextDelayMs(): number {
    const cfg = settings()
    // `clampCadence` lives in this file and was applied only by the Codex
    // scheduler, so a cadence below the 60s floor was honored verbatim here.
    const cadence = clampCadence(isVisible() ? cfg.visibleIntervalMs : cfg.idleIntervalMs)
    return jitterCadenceMs(cadence, PROBE_CADENCE_JITTER_RATIO, random)
  }

  async function tick() {
    if (stopped) return
    try {
      const cfg = settings()
      if (!cfg.probeEnabled) return
      const accountId = (await deps.getAccountId?.()) ?? ACTIVE_ACCOUNT_KEY
      const key = credentialKey("anthropic", accountId, BREAKER_SCOPES.probe)
      // Every probe costs real tokens, so a blocked credential is skipped
      // before the request is built rather than after it is rejected.
      if (!breaker.shouldAttempt(key, now()).allowed) return
      const credential = await deps.getCredential()
      if (!credential || !isAnthropicCredentialFresh(credential)) return
      let outcome = await probeOnce(credential)
      if (!outcome.ok && outcome.reason === "auth") {
        const refreshed = await deps.refresh(credential)
        if (refreshed) outcome = await probeOnce(refreshed)
      }
      if (outcome.ok) {
        breaker.recordSuccess(key)
        await persist(outcome.snapshot)
      } else {
        // Only what the SERVER said is classified. `outcome.reason` is our own
        // vocabulary, and feeding it to a text classifier reads our label as if
        // it were the provider's: a bodyless 429 would match the throttle
        // patterns through the word "rate-limited" and take a 30 second wait,
        // when an information-free 429 is exactly the case that has to be
        // treated as an account cap. Passing the absent body instead lets the
        // opaque branch do that, and a headerless 200 falls to the equally
        // conservative `unknown` ramp.
        const failure = classifySubscriptionFailure({
          status: outcome.status,
          body: outcome.message,
          now: now(),
        })
        breaker.recordFailure(key, failure, now(), random)
      }
    } finally {
      if (!stopped) {
        timer = setTimeout(tick, nextDelayMs())
      }
    }
  }

  timer = setTimeout(tick, 0)

  return {
    stop() {
      stopped = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    },
    async triggerNow() {
      await tick()
    },
  }
}

function defaultIsVisible(): boolean {
  if (typeof document === "undefined") return false
  return document.visibilityState !== "hidden"
}

/** Floor for active-probe cadence — 60s minimum. */
export const PROBE_CADENCE_FLOOR_MS = 60_000

/**
 * Spread applied to the configured cadence. The cadence is a user setting,
 * identical across every account and every open window, so without this they
 * all fire together.
 *
 * One-sided, not symmetric: `jitterCadenceMs` only ever ADDS, because the
 * callers treat their cadence as a floor (`clampCadence`) and a floor jitter
 * can undercut is not a floor. So a configured interval `c` becomes a uniform
 * `[c, c * 1.2]`, and the mean cadence is 10% above `c` rather than equal
 * to it.
 */
export const PROBE_CADENCE_JITTER_RATIO = 0.2

/** Clamp an arbitrary user-supplied cadence to the floor. */
export function clampCadence(value: number): number {
  if (!Number.isFinite(value)) return PROBE_CADENCE_FLOOR_MS
  return Math.max(PROBE_CADENCE_FLOOR_MS, Math.floor(value))
}
