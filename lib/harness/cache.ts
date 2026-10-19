/**
 * Rollout reuse (ADR-0237).
 *
 * A rollout is the expensive unit, and the same harness on the same task under
 * the same conditions is the same experiment: a rerun, a resumed run, or a later
 * run whose base has not changed can reuse it instead of paying again.
 *
 * The key covers everything the outcome depends on:
 *
 * - the harness, by content hash (components plus execution configuration),
 * - the task, by input hash (prompt, file hashes, frozen git base, checks),
 * - the environment, by fingerprint (app version, runtime, executor model,
 *   isolation, turn ceiling, probe policy, tool-rule engine version),
 * - the replicate index, so k replicates of one harness stay k experiments.
 *
 * Any change to any of them is a miss. A hit is still refused when the rollout
 * failed for infrastructure reasons, was cancelled, is older than the reuse
 * window (providers drift), or when the snapshot's library skills drifted.
 */

import type { HarnessEvolutionStep } from "@/types/harness/evolution"
import { canonicalHash } from "./snapshot"

/** Rollouts older than this are re-run: models and providers drift. */
export const ROLLOUT_REUSE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export interface RolloutCacheKeyInput {
  harnessContentHash: string
  taskInputHash: string
  environmentFingerprint: string
  /** 1-based replicate number among the rollouts of one harness in one run. */
  replicate: number
}

export async function rolloutCacheKey(input: RolloutCacheKeyInput): Promise<string> {
  const hash = await canonicalHash(input)
  return `hrc1-${hash.slice(0, 40)}`
}

/** Error messages that say the run never got a fair attempt. */
const INFRASTRUCTURE_ERROR =
  /\b(timed? ?out|timeout|aborted|cancel|sidecar|network|ECONN|rate.?limit|overloaded|5\d\d)\b/i

/**
 * Whether a rollout's error says it never got a fair attempt (a timeout, a
 * provider outage, a rate limit). Such a rollout is neither reused nor
 * counted as evidence about its harness.
 */
export function isInfrastructureError(message: string | undefined): boolean {
  return !!message && INFRASTRUCTURE_ERROR.test(message)
}

export type RolloutReuseVerdict = { reuse: true } | { reuse: false; reason: string }

/** Whether a stored rollout may stand in for a new one with the same key. */
export function rolloutReuseVerdict(
  step: Pick<HarnessEvolutionStep, "kind" | "status" | "evidence" | "endedAt" | "cacheKey">,
  key: string,
  now: number,
  options: { maxAgeMs?: number; driftedSkills?: readonly string[] } = {}
): RolloutReuseVerdict {
  if (step.kind !== "rollout") return { reuse: false, reason: "not a rollout" }
  if (step.cacheKey !== key) return { reuse: false, reason: "key mismatch" }
  if (step.status !== "succeeded" || !step.evidence) {
    return { reuse: false, reason: "the rollout did not finish" }
  }
  if (isInfrastructureError(step.evidence.error)) {
    return { reuse: false, reason: "the rollout failed for infrastructure reasons" }
  }
  const age = now - (step.endedAt ?? 0)
  if (age > (options.maxAgeMs ?? ROLLOUT_REUSE_MAX_AGE_MS)) {
    return { reuse: false, reason: "the rollout is older than the reuse window" }
  }
  if (options.driftedSkills?.length) {
    return {
      reuse: false,
      reason: `library skills changed since capture: ${options.driftedSkills.join(", ")}`,
    }
  }
  return { reuse: true }
}

/** The newest reusable rollout among candidates sharing a key, if any. */
export function pickReusableRollout<
  T extends Pick<HarnessEvolutionStep, "kind" | "status" | "evidence" | "endedAt" | "cacheKey">,
>(
  candidates: readonly T[],
  key: string,
  now: number,
  options: { maxAgeMs?: number; driftedSkills?: readonly string[] } = {}
): T | undefined {
  return [...candidates]
    .filter((c) => rolloutReuseVerdict(c, key, now, options).reuse)
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0]
}
