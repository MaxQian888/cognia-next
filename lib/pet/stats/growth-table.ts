// Pure mapping from a work event to per-stat growth deltas. The pet grows its
// five stats BECAUSE you use the app: completing goals builds patience/wisdom,
// recovering from errors builds debugging, rapid bursts breed chaos, inbound
// connector chatter sharpens snark. Deltas are small integers/fractions so a
// stat takes hundreds of events to cap — matching the lazy "check in a few times
// a day" nurture cadence. Burst + error-recovery signals are injected via `ctx`
// so the function stays pure (no ledger I/O, no clock read beyond `input.now`).

import type { PetEventKind, PetEventSource, PetStatProgress } from "@/types/pet"
import { STAT_KEYS, ZERO_STAT_PROGRESS } from "@/types/pet"

/** Window over which a flurry of events counts as a "burst" (chaos growth). */
export const CHAOS_BURST_WINDOW_MS = 60_000
/** Event count within the window that tips growth into chaos. */
export const CHAOS_BURST_COUNT = 5
/** Extra debugging when a success immediately follows an error. */
export const ERROR_RECOVERY_DEBUGGING = 1.0
/** Chaos awarded once a burst is detected. */
export const BURST_CHAOS = 1.0

export interface StatGrowthInput {
  kind: PetEventKind
  source: PetEventSource
  now: number
}

export interface StatGrowthContext {
  /** Timestamps of recent XP-bearing events (for the burst/chaos signal). */
  recentEventTs?: number[]
  /** Whether this success immediately followed an error (debugging signal). */
  recoveredFromError?: boolean
}

/** Base per-kind growth. Kinds not listed grow nothing on their own. */
export const STAT_GROWTH_TABLE: Partial<Record<PetEventKind, Partial<PetStatProgress>>> = {
  error: { debugging: 0.5, chaos: 0.3 },
  success: { debugging: 0.3, wisdom: 0.3 },
  goalComplete: { patience: 1.5, wisdom: 1.0 },
  goalProgress: { patience: 0.5 },
  teamRun: { debugging: 0.4, patience: 0.2, chaos: 0.2, wisdom: 0.3 },
  workflowRun: { patience: 0.3, wisdom: 0.4 },
  scheduledRun: { patience: 0.6, wisdom: 0.2 },
  inboundMessage: { snark: 0.5 },
  // scheduledRunStarting / scheduledRunDue are reminder cues, not completed work
  // — they grow no stats on their own (absent → statDeltaForEvent returns zeros).
}

/** Compute the stat growth a single event produces. Pure. */
export function statDeltaForEvent(
  input: StatGrowthInput,
  ctx?: StatGrowthContext
): PetStatProgress {
  const out: PetStatProgress = { ...ZERO_STAT_PROGRESS }
  const row = STAT_GROWTH_TABLE[input.kind]
  if (row) {
    for (const k of STAT_KEYS) out[k] += row[k] ?? 0
  }
  if (input.kind === "success" && ctx?.recoveredFromError) {
    out.debugging += ERROR_RECOVERY_DEBUGGING
  }
  if (ctx?.recentEventTs && ctx.recentEventTs.length) {
    const inWindow = ctx.recentEventTs.filter((t) => input.now - t <= CHAOS_BURST_WINDOW_MS).length
    if (inWindow >= CHAOS_BURST_COUNT) out.chaos += BURST_CHAOS
  }
  return out
}
