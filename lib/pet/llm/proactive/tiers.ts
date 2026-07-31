// Frequency tiers for the proactive speak engine. A tier maps to three hard
// numbers consumed by the gate + idle trigger; everything is data so the gate
// logic stays a pure function over an injected tuning.

export type ProactiveTier = "quiet" | "normal" | "chatty"

export interface ProactiveTierTuning {
  /** Minimum ms between any two proactive utterances. */
  minGapMs: number
  /** Maximum proactive utterances per local day. */
  dailyCap: number
  /** User-inactivity ms before idle chatter becomes eligible. */
  idleThresholdMs: number
}

const MIN = 60_000

export const PROACTIVE_TIERS: Record<ProactiveTier, ProactiveTierTuning> = {
  quiet: { minGapMs: 30 * MIN, dailyCap: 4, idleThresholdMs: 25 * MIN },
  normal: { minGapMs: 12 * MIN, dailyCap: 10, idleThresholdMs: 12 * MIN },
  chatty: { minGapMs: 4 * MIN, dailyCap: 24, idleThresholdMs: 5 * MIN },
}

export function resolveProactiveTuning(tier: ProactiveTier): ProactiveTierTuning {
  return PROACTIVE_TIERS[tier]
}
