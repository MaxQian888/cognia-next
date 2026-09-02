/**
 * Quick unlock: PIN, pattern and passkey.
 *
 * The single most important thing about this module is what these methods are
 * NOT. They are convenience factors layered on top of the account password,
 * never replacements for it, and the code is shaped so that distinction cannot
 * quietly erode:
 *
 *   - The password is the only factor that stands alone. Every enrollment
 *     below is created from an already-unlocked session, and the password
 *     remains available on the lock screen at all times.
 *   - A PIN is around 20 bits and a 3x3 pattern is under 19 in practice.
 *     Neither survives offline enumeration on its own, so neither is ever the
 *     sole input to a key. Both are combined with a high-entropy DEVICE PEPPER
 *     that never leaves the machine: the OS keyring on the desktop host, and a
 *     non-extractable WebCrypto key in a browser. An attacker holding a copy of
 *     the database but not the device cannot mount the guessing attack at all.
 *   - Every quick method carries a HARD attempt cap, not merely a backoff.
 *     Exhausting it disables that method and requires the password. A backoff
 *     alone only slows an online attacker, and 20 bits is not enough to slow.
 *   - A quick method is never a recovery path. Losing the password is still
 *     recovered with the recovery key, and forgetting a PIN costs the PIN.
 *
 * A passkey is different in kind and is treated as such: its secret comes from
 * an authenticator via the WebAuthn PRF extension, so it is full-entropy and
 * needs no pepper. It is still enrolled the same way and still cannot replace
 * the password, because an authenticator can be lost.
 */

/** The quick-unlock methods a user can enroll. */
export type QuickUnlockMethod = "pin" | "pattern" | "passkey"

export const QUICK_UNLOCK_METHODS: readonly QuickUnlockMethod[] = ["pin", "pattern", "passkey"]

/** PIN length bounds. Six is the floor everyone recognises from a phone. */
export const MIN_PIN_LENGTH = 6
export const MAX_PIN_LENGTH = 12

/**
 * Pattern bounds, in nodes touched on the 3x3 grid.
 *
 * Five is the floor rather than four because the four-node patterns are
 * overwhelmingly the four corners or one edge, and the real-world distribution
 * of short patterns is far worse than the combinatorics suggest.
 */
export const MIN_PATTERN_LENGTH = 5
export const MAX_PATTERN_LENGTH = 9

/** Nodes on the pattern grid, indexed 0..8 in reading order. */
export const PATTERN_GRID_SIZE = 9

/**
 * Attempts allowed before a quick method is disabled and the password is
 * required. Deliberately small: the whole security argument for a 20-bit
 * secret is that only a handful of guesses are ever possible.
 */
export const MAX_QUICK_UNLOCK_ATTEMPTS = 5

/** Why a quick-unlock secret was rejected at enrollment. */
export type QuickUnlockPolicyError =
  | "pin-too-short"
  | "pin-too-long"
  | "pin-not-numeric"
  | "pin-too-simple"
  | "pattern-too-short"
  | "pattern-too-long"
  | "pattern-repeats-node"
  | "pattern-out-of-range"
  | "pattern-too-simple"

/**
 * One enrolled method on one account.
 *
 * Stored as a non-indexed field on `LocalAccountRecord`, so adding it needs no
 * account-registry version bump, exactly as `avatarDataUrl` did.
 *
 * The `verifier` shape is deliberately opaque here. On the desktop host it is
 * an Argon2id verifier minted and checked in Rust with a keyring-held pepper,
 * and the renderer never sees the pepper. In a browser it is a wrapped copy of
 * the vault master key. Both are written by their own runtime and read back by
 * the same one, so this layer only has to carry them.
 */
export interface QuickUnlockEnrollment {
  method: QuickUnlockMethod
  /** Opaque, runtime-specific credential material. Never logged. */
  verifier: Record<string, unknown>
  createdAt: number
  /**
   * Failed attempts since the last success. At
   * {@link MAX_QUICK_UNLOCK_ATTEMPTS} the method is locked out and only the
   * password will open the account.
   */
  failedAttempts: number
  /**
   * Set when the attempt cap was exhausted. The enrollment is kept rather than
   * deleted so the lock screen can say "PIN disabled after too many attempts"
   * instead of silently losing a method the user configured.
   */
  lockedOutAt?: number
  /** Last successful use, shown in settings so a stale method is visible. */
  lastUsedAt?: number
}

/** Whether this enrollment can currently be offered on the lock screen. */
export function isEnrollmentUsable(enrollment: QuickUnlockEnrollment): boolean {
  return (
    enrollment.lockedOutAt === undefined && enrollment.failedAttempts < MAX_QUICK_UNLOCK_ATTEMPTS
  )
}

/** Attempts left before this method locks itself out. */
export function attemptsRemaining(enrollment: QuickUnlockEnrollment): number {
  if (enrollment.lockedOutAt !== undefined) return 0
  return Math.max(0, MAX_QUICK_UNLOCK_ATTEMPTS - enrollment.failedAttempts)
}

/** Record a failure, locking the method out when the cap is reached. */
export function withFailedAttempt(
  enrollment: QuickUnlockEnrollment,
  now: number
): QuickUnlockEnrollment {
  const failedAttempts = enrollment.failedAttempts + 1
  return {
    ...enrollment,
    failedAttempts,
    lockedOutAt:
      failedAttempts >= MAX_QUICK_UNLOCK_ATTEMPTS ? (enrollment.lockedOutAt ?? now) : undefined,
  }
}

/** Record a success, clearing the failure count. */
export function withSuccessfulAttempt(
  enrollment: QuickUnlockEnrollment,
  now: number
): QuickUnlockEnrollment {
  return { ...enrollment, failedAttempts: 0, lockedOutAt: undefined, lastUsedAt: now }
}

/**
 * Re-enable a locked-out method.
 *
 * Only ever called from an ALREADY UNLOCKED session, because proving the
 * password is exactly what earns the reset. There is no lock-screen path to
 * this, which is the point: otherwise the cap would be a speed bump rather
 * than a cap.
 */
export function withLockoutCleared(enrollment: QuickUnlockEnrollment): QuickUnlockEnrollment {
  return { ...enrollment, failedAttempts: 0, lockedOutAt: undefined }
}
