// Local bubble template selection. Each event kind maps to a small pool of i18n
// key suffixes under `pet.bubbles.<kind>.<n>`; the widget resolves the chosen key
// via next-intl. Selection is deterministic from a seed (e.g. the event time) so
// the renderer never calls Math.random. Returns null for kinds that should stay
// silent. Zero LLM cost — the opt-in LLM path lives in `bubbles/speak.ts`.

import type { PetEventKind, PetMood } from "@/types/pet"

/** Number of phrase variants authored per kind (must match the i18n bundle). */
const VARIANTS: Partial<Record<PetEventKind, number>> = {
  thinking: 3,
  waiting: 2,
  review: 2,
  success: 3,
  error: 3,
  goalComplete: 3,
  levelUp: 2,
  evolved: 2,
  fed: 3,
  played: 3,
  petted: 3,
  slept: 2,
  cleaned: 2,
  treated: 2,
  hatched: 2,
  greeting: 3,
  inboundMessage: 2,
  achievementUnlocked: 2,
  twinBusy: 2,
  twinMilestone: 2,
}

/** Mood-flavoured idle phrases (shown on idle ticks, keyed by mood). */
const IDLE_MOOD_VARIANTS: Record<PetMood, number> = {
  content: 3,
  happy: 3,
  tired: 2,
  lonely: 2,
  grumpy: 2,
}

/** Kinds with an authored snarky overlay pool (`pet.bubbles.snarky.<kind>.<n>`).
 *  Counts must match the i18n bundle, like `VARIANTS`. */
const SNARK_VARIANTS: Partial<Record<PetEventKind, number>> = {
  fed: 2,
  played: 2,
  petted: 2,
  success: 2,
  error: 2,
}

/** Effective snark stat at/above this unlocks the snarky sprinkle. */
export const SNARK_THRESHOLD = 60

function indexFromSeed(seed: number, count: number): number {
  // Stable, non-negative index without Math.random.
  return Math.abs(Math.trunc(seed)) % count
}

/**
 * Pick the i18n key for an event's bubble, or null if the kind is silent.
 * `seed` (e.g. `event.at`) makes the choice deterministic. A high-snark pet
 * (effective stat ≥ {@link SNARK_THRESHOLD}) swaps in a snarky line ~1 in 3
 * reactions for kinds with an authored snarky pool — same sprinkle cadence as
 * `pickCustomBubble`, still seed-deterministic.
 */
export function pickBubbleKey(
  kind: PetEventKind,
  seed: number,
  stats?: { snark?: number }
): string | null {
  const count = VARIANTS[kind]
  if (!count) return null
  const snarkCount = SNARK_VARIANTS[kind]
  if (
    snarkCount &&
    (stats?.snark ?? 0) >= SNARK_THRESHOLD &&
    Math.abs(Math.trunc(seed)) % 3 === 0
  ) {
    return `bubbles.snarky.${kind}.${indexFromSeed(seed, snarkCount)}`
  }
  return `bubbles.${kind}.${indexFromSeed(seed, count)}`
}

/** Pick a mood-flavoured idle bubble key. */
export function pickIdleBubbleKey(mood: PetMood, seed: number): string {
  const count = IDLE_MOOD_VARIANTS[mood]
  return `bubbles.idle.${mood}.${indexFromSeed(seed, count)}`
}

/**
 * Talk-acknowledgement pool. `talked` is intentionally ABSENT from `VARIANTS`
 * so the generic template subscriber stays silent for it — `use-pet-speak`
 * owns every `talked` bubble (LLM reply, or this template as the degradation
 * path when LLM speak is off / rate-limited / failed).
 */
const TALKED_VARIANTS = 3

export function pickTalkedBubbleKey(seed: number): string {
  return `bubbles.talked.${indexFromSeed(seed, TALKED_VARIANTS)}`
}

/**
 * Maybe pick one of the user's custom catchphrases instead of a template, so
 * they sprinkle in (~1 in 3 reactions) rather than fully replacing the authored
 * pool. Deterministic from `seed` (event time). Returns null to keep the
 * template, or when there are no (non-blank) phrases.
 */
export function pickCustomBubble(phrases: string[] | undefined, seed: number): string | null {
  const usable = (phrases ?? []).map((p) => p.trim()).filter(Boolean)
  if (!usable.length) return null
  const s = Math.abs(Math.trunc(seed))
  if (s % 3 !== 0) return null
  return usable[s % usable.length]
}
