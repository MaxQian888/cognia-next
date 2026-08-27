/**
 * Failed-unlock backoff for the lock screen.
 *
 * The unlock form had no attempt limit at all: a wrong password cost one
 * Argon2id derivation (~50ms on the desktop host) and could be retried as fast
 * as the user could press Enter.
 *
 * Scope, stated plainly: this is a speed bump on the SCREEN, not a
 * cryptographic control. The state lives in this profile's `localStorage`, so
 * anyone who can run code in the page can clear it; the real defence remains
 * the KDF cost and the fact that the vault key is only derivable from the
 * password. What it buys is a bounded typo-spam surface and — via
 * `remainingAttempts` — a lock screen that can warn before it starts stalling.
 *
 * Backoff escalates and does NOT reset on cooldown expiry, only on a successful
 * unlock or after {@link RESET_AFTER_MS} of quiet, so a slow grinder still pays
 * a growing price.
 */

export const FREE_ATTEMPTS = 5
export const BASE_COOLDOWN_MS = 30_000
export const MAX_COOLDOWN_MS = 900_000
/** Quiet period after which the failure count is forgiven. */
export const RESET_AFTER_MS = 1_800_000

const STORAGE_PREFIX = "cognia-account-unlock-throttle:"

export interface UnlockThrottleState {
  failures: number
  lastFailureAt: number
  cooldownUntil: number
}

export interface UnlockThrottleStatus {
  failures: number
  /** Attempts left before the next failure starts a cooldown. */
  remainingAttempts: number
  /** Epoch ms the cooldown ends; 0 when no cooldown is active. */
  cooldownUntil: number
  cooldownMsRemaining: number
  blocked: boolean
}

const EMPTY: UnlockThrottleState = { failures: 0, lastFailureAt: 0, cooldownUntil: 0 }

function storageKey(accountId: string): string {
  return `${STORAGE_PREFIX}${accountId}`
}

function storage(): Storage | null {
  if (typeof window === "undefined") return null
  try {
    return window.localStorage
  } catch {
    // Private-mode / blocked storage: degrade to no throttling rather than
    // making the lock screen unusable.
    return null
  }
}

function parse(raw: string | null): UnlockThrottleState {
  if (!raw) return EMPTY
  try {
    const value = JSON.parse(raw) as Partial<UnlockThrottleState>
    if (
      typeof value?.failures !== "number" ||
      typeof value?.lastFailureAt !== "number" ||
      typeof value?.cooldownUntil !== "number"
    ) {
      return EMPTY
    }
    return {
      failures: Math.max(0, Math.floor(value.failures)),
      lastFailureAt: Math.max(0, value.lastFailureAt),
      cooldownUntil: Math.max(0, value.cooldownUntil),
    }
  } catch {
    return EMPTY
  }
}

/** Pure escalation step — exported so the policy is testable without storage. */
export function nextThrottleState(previous: UnlockThrottleState, now: number): UnlockThrottleState {
  const forgiven = now - previous.lastFailureAt > RESET_AFTER_MS ? EMPTY : previous
  const failures = forgiven.failures + 1
  const overage = failures - FREE_ATTEMPTS
  const cooldownUntil =
    overage >= 0 ? now + Math.min(BASE_COOLDOWN_MS * 2 ** overage, MAX_COOLDOWN_MS) : 0
  return { failures, lastFailureAt: now, cooldownUntil }
}

/** Pure projection of a stored state onto what the lock screen renders. */
export function throttleStatusOf(state: UnlockThrottleState, now: number): UnlockThrottleStatus {
  const current = now - state.lastFailureAt > RESET_AFTER_MS ? EMPTY : state
  const cooldownMsRemaining = Math.max(0, current.cooldownUntil - now)
  return {
    failures: current.failures,
    remainingAttempts: Math.max(0, FREE_ATTEMPTS - current.failures),
    cooldownUntil: cooldownMsRemaining > 0 ? current.cooldownUntil : 0,
    cooldownMsRemaining,
    blocked: cooldownMsRemaining > 0,
  }
}

export function readUnlockThrottle(accountId: string, now = Date.now()): UnlockThrottleStatus {
  return throttleStatusOf(parse(storage()?.getItem(storageKey(accountId)) ?? null), now)
}

export function recordFailedUnlock(accountId: string, now = Date.now()): UnlockThrottleStatus {
  const store = storage()
  const next = nextThrottleState(parse(store?.getItem(storageKey(accountId)) ?? null), now)
  try {
    store?.setItem(storageKey(accountId), JSON.stringify(next))
  } catch {
    // Quota / blocked storage — the in-memory result is still returned so the
    // current screen shows the warning even if it cannot survive a reload.
  }
  return throttleStatusOf(next, now)
}

export function clearUnlockFailures(accountId: string): void {
  try {
    storage()?.removeItem(storageKey(accountId))
  } catch {
    // Nothing to do: a stale entry expires on its own after RESET_AFTER_MS.
  }
}
