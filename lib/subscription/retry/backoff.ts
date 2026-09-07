// Per-reason backoff policy for subscription quota / balance / refresh calls.
//
// Shape follows `lib/updates/backoff.ts` (consecutive-failure ramp, jitter
// ratio, server hint honored when longer), with one addition the Update Center
// does not need: the ramp is chosen per failure reason. A 5 second concurrency
// shed and a 5 hour account quota window are both "one failure", and giving
// them the same ramp means either hammering the first or freezing the second.
//
// Two rules here exist purely to keep an account out of trouble.
//
//  1. A server hint always WINS when it is longer than our own ramp, and it is
//     never capped below what the server asked for. Our ceiling constrains the
//     ramp we invented, not the wait the provider requested. Capping a two hour
//     reset down to a fifteen minute ceiling is precisely the behavior that
//     turns one 429 into eight.
//
//  2. Every delay carries jitter. Without it, N accounts that failed in the
//     same sweep all wake up in the same millisecond, and the retry lands as
//     one burst instead of a trickle.

import { MAX_RETRY_HINT_MS } from "./retry-hint"

import type { SubscriptionFailureReason } from "./failure-class"

export interface BackoffPolicy {
  /** Wait after the first failure, before the exponential ramp. */
  baseMs: number
  /** Ceiling on OUR ramp. A longer server hint is still honored. */
  maxMs: number
  /** Fraction of the delay that jitter may add, 0 to 1. */
  jitterRatio: number
}

/**
 * Ramp per reason. The quota and billing entries are deliberately long: the
 * window they describe is measured in hours, and an early probe buys nothing
 * but another rejected request against a credential the server already told us
 * is spent.
 */
export const BACKOFF_POLICIES: Readonly<Record<SubscriptionFailureReason, BackoffPolicy>> = {
  "auth-expired": { baseMs: 60_000, maxMs: 30 * 60_000, jitterRatio: 0.2 },
  // Latched by the breaker rather than retried. The long ramp is the floor for
  // the one case a caller ignores the latch.
  "auth-revoked": { baseMs: 6 * 60 * 60_000, maxMs: 24 * 60 * 60_000, jitterRatio: 0.1 },
  "account-quota": { baseMs: 30 * 60_000, maxMs: 6 * 60 * 60_000, jitterRatio: 0.2 },
  "billing-cap": { baseMs: 30 * 60_000, maxMs: 6 * 60 * 60_000, jitterRatio: 0.2 },
  throttled: { baseMs: 30_000, maxMs: 15 * 60_000, jitterRatio: 0.25 },
  concurrency: { baseMs: 5_000, maxMs: 2 * 60_000, jitterRatio: 0.25 },
  // Wide jitter on purpose. Capacity failures hit every client at once, so a
  // narrow band would just reassemble the herd.
  capacity: { baseMs: 45_000, maxMs: 15 * 60_000, jitterRatio: 0.35 },
  "server-error": { baseMs: 20_000, maxMs: 30 * 60_000, jitterRatio: 0.25 },
  network: { baseMs: 10_000, maxMs: 10 * 60_000, jitterRatio: 0.25 },
  // Never retried, so the value only matters if a caller ignores `retryable`.
  "client-error": { baseMs: 60 * 60_000, maxMs: 6 * 60 * 60_000, jitterRatio: 0.1 },
  // An unclassifiable failure is treated as an account cap. Guessing
  // "transient" is the guess that keeps hammering.
  unknown: { baseMs: 30 * 60_000, maxMs: 6 * 60 * 60_000, jitterRatio: 0.2 },
}

/** Exponent ceiling, so a long-lived failure counter cannot overflow the shift. */
const MAX_RAMP_EXPONENT = 20

export interface BackoffInput {
  reason: SubscriptionFailureReason
  /** Consecutive failures INCLUDING the one just observed. Below 1 means none. */
  consecutiveFailures: number
  /** Delay the server asked for, in ms, when it asked for one. */
  retryAfterMs?: number
  /** Deterministic 0 to 1 jitter source. Defaults to `Math.random`. */
  random?: () => number
}

/**
 * How long to wait before this credential may be tried again.
 *
 * A server hint of exactly `0` is an explicit "retry now" and is honored as
 * such: it suppresses our ramp entirely rather than being read as "no hint".
 */
export function backoffDelayMs(input: BackoffInput): number {
  const policy = BACKOFF_POLICIES[input.reason]
  const random = input.random ?? Math.random
  const failures = Math.max(0, Math.floor(input.consecutiveFailures))
  if (failures === 0) return 0

  const hint = normalizeHint(input.retryAfterMs)
  if (hint === 0) return 0

  const ramp = Math.min(
    policy.maxMs,
    policy.baseMs * 2 ** Math.min(failures - 1, MAX_RAMP_EXPONENT)
  )
  // The hint is compared against the ramp but never clipped by `maxMs`. Our
  // ceiling bounds what we invented, not what the provider demanded.
  const base = hint === undefined ? ramp : Math.max(ramp, hint)
  const jittered = base + base * policy.jitterRatio * random()
  return Math.round(Math.min(MAX_RETRY_HINT_MS, jittered))
}

/** Epoch ms this credential becomes eligible again. */
export function blockedUntil(now: number, input: BackoffInput): number {
  return now + backoffDelayMs(input)
}

/**
 * Spread a fixed polling cadence so parallel schedulers do not realign onto the
 * same tick. Used by the usage schedulers, whose cadence is a user setting and
 * therefore identical across every account the user owns and every window they
 * have open.
 *
 * The spread only ever ADDS. A symmetric spread would be the obvious choice,
 * but the callers treat their cadence as a floor (`clampCadence`), and a floor
 * that jitter can undercut is not a floor. Delaying a poll is always safe,
 * so the whole band sits above the configured value.
 */
export function jitterCadenceMs(
  cadenceMs: number,
  ratio = 0.2,
  random: () => number = Math.random
): number {
  if (!Number.isFinite(cadenceMs) || cadenceMs <= 0) return 0
  return Math.round(cadenceMs + cadenceMs * Math.max(0, ratio) * random())
}

function normalizeHint(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined
  return Math.min(MAX_RETRY_HINT_MS, Math.round(value))
}
