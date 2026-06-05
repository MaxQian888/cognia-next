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
  hatched: 2,
  greeting: 3,
  inboundMessage: 2,
  achievementUnlocked: 2,
}

/** Mood-flavoured idle phrases (shown on idle ticks, keyed by mood). */
const IDLE_MOOD_VARIANTS: Record<PetMood, number> = {
  content: 3,
  happy: 3,
  tired: 2,
  lonely: 2,
  grumpy: 2,
}

function indexFromSeed(seed: number, count: number): number {
  // Stable, non-negative index without Math.random.
  return Math.abs(Math.trunc(seed)) % count
}

/**
 * Pick the i18n key for an event's bubble, or null if the kind is silent.
 * `seed` (e.g. `event.at`) makes the choice deterministic.
 */
export function pickBubbleKey(kind: PetEventKind, seed: number): string | null {
  const count = VARIANTS[kind]
  if (!count) return null
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
