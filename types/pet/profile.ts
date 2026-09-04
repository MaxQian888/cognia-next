// The persisted pet record. A single global row (id = "global") backs the
// "global mascot"; per-character appearance overrides live separately in
// `PetCharacterBinding`. Bones are NOT stored here — they are recomputed from the
// account id and merged over the soul-derived view at load time.

import type { PetCosmeticOverride } from "./bones"
import type { PetCareState } from "./care"
import type { PetStreak } from "./economy"
import type { PetNeeds } from "./needs"
import type { ProactiveState } from "./proactive"
import type { PetInteractionGateState } from "./interaction-gate"
import type { PetSoul } from "./soul"
import type { PetStatProgress } from "./stats"

/** Growth stages, unlocked by level thresholds. Drives the evolution morph. */
export type PetStage = "egg" | "baby" | "juvenile" | "adult" | "elder"

/**
 * Care-quality tier stamped at the moment of an evolution: sustained neglect
 * yields a muted "plain" look, devoted care a "radiant" accent. Cosmetic layer
 * only — bones stay deterministic and untouched.
 */
export type PetEvolutionFlavor = "plain" | "normal" | "radiant"

export interface PetProfile {
  /** Singleton primary key. */
  id: "global"
  /** Null until the egg is hatched (Soul generated + persisted). */
  soul: PetSoul | null
  /** Cumulative experience points. */
  xp: number
  /** Derived from xp via the level curve; cached for cheap reads. */
  level: number
  /** Derived from level via stage thresholds; cached for the renderer. */
  stage: PetStage
  /** The nurture needs (with lazy-decay bookkeeping). */
  needs: PetNeeds
  /**
   * Which account identifier the current bones derive from. If the active
   * account changes, this drift is detected so we can re-hatch intentionally
   * rather than silently swap identities.
   */
  accountFingerprint: string
  /**
   * Proactive-speak counters (non-indexed; absent until the engine first
   * speaks). Advanced via `lib/pet/llm/proactive/scheduler-state.ts`.
   */
  proactiveState?: ProactiveState
  /**
   * Per-kind nurture cooldown (non-indexed; absent until the first accepted
   * interaction). Persisted rather than held in the zustand store because that
   * store is per-window and per-session, so the main window, the overlay and
   * the popup each kept their own copy and reset it on reload. Advanced via
   * `lib/pet/interaction/gate.ts`.
   */
  interactionGate?: PetInteractionGateState
  /**
   * Additive stat growth earned by working alongside the pet (non-indexed;
   * absent until the first growth). Effective stats = base bones + this.
   * Advanced via `lib/pet/stats/*`.
   */
  statProgress?: PetStatProgress
  /**
   * Persistent care condition + rolling care quality (non-indexed; absent until
   * first derived). Advanced via `lib/pet/care/condition.ts`.
   */
  care?: PetCareState
  /**
   * User-chosen cosmetic restyle applied over the genetic bones at render time
   * (non-indexed; absent = pure genetics). Only the non-identity visuals can be
   * overridden — see `PetCosmeticOverride`.
   */
  cosmetic?: PetCosmeticOverride
  /**
   * Coin balance earned alongside XP (non-indexed; absent = 0). Advanced by
   * `applyPetEvent`; spent via `lib/pet/economy/shop.ts`.
   */
  coins?: number
  /**
   * Daily-care streak cache (non-indexed; absent until the first counted
   * interaction). Advanced by `applyPetEvent`; backfilled once from the
   * activity ledger for legacy profiles.
   */
  streak?: PetStreak
  /**
   * Care-quality flavor stamped at the LAST evolution (non-indexed; absent =
   * normal). Set by `applyPetEvent` from `flavorForCareQuality`.
   */
  evolutionFlavor?: PetEvolutionFlavor
  createdAt: string
  updatedAt: string
}

/** One row in the append-only activity ledger (XP + interaction history). */
export interface PetActivityRow {
  /** Auto-increment primary key. */
  id?: number
  /** The event kind that produced this entry. */
  kind: string
  /** Source subsystem (chat/goal/...) or "user" for direct interactions. */
  source: string
  /** XP awarded by this entry (0 if none). */
  xp: number
  /** Epoch ms. */
  ts: number
}
