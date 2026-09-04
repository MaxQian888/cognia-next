/**
 * Staged-rollout eligibility.
 *
 * The device contributes exactly one number to the control plane: a stable
 * bucket in 0 to 9999. It is generated once from local randomness and is
 * deliberately NOT derived from the account id, the paired-device id, or the
 * diagnostics installation id, so a rollout cohort cannot be joined back to a
 * user across those planes.
 */

import type { UpdateCandidate, UpdateRollout } from "@cognia/agent-config-types"

export const ROLLOUT_BUCKET_COUNT = 10_000

/** Generate a fresh device bucket from crypto randomness when available. */
export function generateRolloutBucket(random: () => number = Math.random): number {
  const cryptoRef = globalThis.crypto
  if (cryptoRef && typeof cryptoRef.getRandomValues === "function") {
    const buf = new Uint32Array(1)
    cryptoRef.getRandomValues(buf)
    return buf[0] % ROLLOUT_BUCKET_COUNT
  }
  return Math.floor(random() * ROLLOUT_BUCKET_COUNT) % ROLLOUT_BUCKET_COUNT
}

/** Normalize a persisted bucket, regenerating anything out of range. */
export function normalizeRolloutBucket(value: unknown, random?: () => number): number {
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < ROLLOUT_BUCKET_COUNT
  ) {
    return value
  }
  return generateRolloutBucket(random)
}

export type RolloutVerdict = "offered" | "not-yet" | "paused" | "revoked"

/**
 * Decide whether a rollout window currently offers this device the candidate.
 *
 * `manual` marks a user-initiated check. It bypasses the percentage gate only.
 * A paused or revoked rollout still refuses, and so do the channel,
 * compatibility and signature gates that run outside this function.
 */
export function rolloutVerdict(
  rollout: UpdateRollout | undefined,
  bucket: number,
  options: { manual?: boolean } = {}
): RolloutVerdict {
  if (!rollout) return "offered"
  if (rollout.revoked) return "revoked"
  if (rollout.paused) return "paused"
  if (options.manual) return "offered"
  const percentage = Math.max(0, Math.min(100, rollout.percentage))
  const threshold = (percentage / 100) * ROLLOUT_BUCKET_COUNT
  return bucket < threshold ? "offered" : "not-yet"
}

/** Filter a candidate list down to what this device may currently install. */
export function eligibleCandidates(
  candidates: readonly UpdateCandidate[],
  bucket: number,
  options: { manual?: boolean } = {}
): UpdateCandidate[] {
  return candidates.filter((c) => rolloutVerdict(c.rollout, bucket, options) === "offered")
}
