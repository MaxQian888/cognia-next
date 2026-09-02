/**
 * What counts as an acceptable PIN or pattern, and how each is turned into
 * bytes.
 *
 * The rejections here are not decoration. A PIN and a pattern have so little
 * entropy to begin with that the common choices are a meaningful fraction of
 * the whole space: `123456` and `000000` alone account for a startling share
 * of real six-digit PINs, and on a 3x3 grid the straight lines and the outline
 * of the square are most of what people actually draw. Refusing those is worth
 * more than any number of extra Argon2 iterations.
 *
 * Canonicalisation matters too. The same PIN typed with a stray space, or the
 * same pattern expressed as a different array type, has to produce the same
 * bytes or a user gets locked out of a credential they entered correctly.
 */

import {
  MAX_PATTERN_LENGTH,
  MAX_PIN_LENGTH,
  MIN_PATTERN_LENGTH,
  MIN_PIN_LENGTH,
  PATTERN_GRID_SIZE,
  type QuickUnlockPolicyError,
} from "./types"

export type PolicyResult = { ok: true } | { ok: false; reason: QuickUnlockPolicyError }

/**
 * PINs refused outright.
 *
 * Not an attempt at a complete blocklist, which would be security theatre.
 * These are the specific shapes that are so over-represented that allowing
 * them would undercut the attempt cap: a constant digit, and a run.
 */
function isTrivialPin(pin: string): boolean {
  if (/^(\d)\1+$/.test(pin)) return true

  // Ascending or descending runs, with wraparound, so `7890` and `3210` are
  // caught alongside `1234`.
  const ascending = pin
    .split("")
    .every((digit, index, all) =>
      index === 0 ? true : (Number(all[index - 1]) + 1) % 10 === Number(digit)
    )
  const descending = pin
    .split("")
    .every((digit, index, all) =>
      index === 0 ? true : (Number(all[index - 1]) + 9) % 10 === Number(digit)
    )
  return ascending || descending
}

/** Validate a PIN against the enrollment policy. */
export function validatePin(raw: string): PolicyResult {
  const pin = raw.trim()
  if (!/^\d*$/.test(pin)) return { ok: false, reason: "pin-not-numeric" }
  if (pin.length < MIN_PIN_LENGTH) return { ok: false, reason: "pin-too-short" }
  if (pin.length > MAX_PIN_LENGTH) return { ok: false, reason: "pin-too-long" }
  if (isTrivialPin(pin)) return { ok: false, reason: "pin-too-simple" }
  return { ok: true }
}

/**
 * Patterns refused outright: the straight lines.
 *
 * On a 3x3 grid the rows, the columns and the two diagonals are what a large
 * share of users draw first, and each is a single stroke that is trivially
 * shoulder-surfed as well as trivially guessed.
 */
const TRIVIAL_PATTERNS: readonly number[][] = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
  [0, 1, 2, 5, 8],
  [0, 1, 2, 3, 4, 5, 6, 7, 8],
  [0, 3, 6, 7, 8, 5, 2, 1],
]

function isTrivialPattern(nodes: readonly number[]): boolean {
  const forward = nodes.join(",")
  const reverse = [...nodes].reverse().join(",")
  return TRIVIAL_PATTERNS.some((candidate) => {
    const key = candidate.join(",")
    return key === forward || key === reverse
  })
}

/** Validate a pattern against the enrollment policy. */
export function validatePattern(nodes: readonly number[]): PolicyResult {
  if (nodes.length < MIN_PATTERN_LENGTH) return { ok: false, reason: "pattern-too-short" }
  if (nodes.length > MAX_PATTERN_LENGTH) return { ok: false, reason: "pattern-too-long" }
  for (const node of nodes) {
    if (!Number.isInteger(node) || node < 0 || node >= PATTERN_GRID_SIZE) {
      return { ok: false, reason: "pattern-out-of-range" }
    }
  }
  if (new Set(nodes).size !== nodes.length) return { ok: false, reason: "pattern-repeats-node" }
  if (isTrivialPattern(nodes)) return { ok: false, reason: "pattern-too-simple" }
  return { ok: true }
}

/**
 * Canonical string for a secret, which is what actually gets hashed or
 * wrapped.
 *
 * Prefixed by method so a PIN of "123456" and a pattern that happened to
 * serialise the same way can never collide, and so a verifier minted for one
 * method can never be satisfied by the other.
 */
export function canonicalizePin(raw: string): string {
  return `pin:${raw.trim()}`
}

export function canonicalizePattern(nodes: readonly number[]): string {
  return `pattern:${nodes.join("-")}`
}

/** Approximate entropy of the secret space, used only to explain the tradeoff. */
export function approximateEntropyBits(method: "pin" | "pattern", length: number): number {
  if (method === "pin") return Math.round(length * Math.log2(10))
  // Ordered selection without replacement from 9 nodes.
  let permutations = 1
  for (let i = 0; i < length; i += 1) permutations *= PATTERN_GRID_SIZE - i
  return Math.round(Math.log2(permutations))
}
