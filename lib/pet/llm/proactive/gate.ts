// The single chokepoint every proactive utterance must pass BEFORE any LLM
// call. Check order is deliberate: DND (cheapest, user-sacred) → daily cap
// (with day rollover) → min gap. Pure — the caller supplies the clock, the
// tuning, the persisted counters, and the precomputed DND flag.

import type { ProactiveTierTuning } from "./tiers"
import { localDayKey, type ProactiveState } from "./scheduler-state"

export type GateRefusal = "dnd" | "dailyCap" | "minGap"

export interface CanSpeakInput {
  nowMs: number
  tuning: ProactiveTierTuning
  state: ProactiveState
  /** Precomputed "quiet hours / DND active right now" flag. */
  dndActive: boolean
  tz?: string
}

export type CanSpeakResult = { ok: true } | { ok: false; reason: GateRefusal }

export function canSpeak(input: CanSpeakInput): CanSpeakResult {
  if (input.dndActive) return { ok: false, reason: "dnd" }

  const day = localDayKey(input.nowMs, input.tz)
  const spokenToday = input.state.dayKey === day ? input.state.spokenToday : 0
  if (spokenToday >= input.tuning.dailyCap) return { ok: false, reason: "dailyCap" }

  if (
    input.state.lastSpokeAtMs !== null &&
    input.nowMs - input.state.lastSpokeAtMs < input.tuning.minGapMs
  ) {
    return { ok: false, reason: "minGap" }
  }

  return { ok: true }
}
