// Pure "apply a PetEvent to the profile" step: award XP, settle interaction
// needs, recompute level/stage, and report any one-shot flourishes (feed/pet,
// level-up, evolution) the UI should play. The controller hook persists the
// result and runs side effects (achievements, bubbles); keeping this pure makes
// the progression rules exhaustively testable.

import type {
  PetCareState,
  PetEvent,
  PetOneShot,
  PetProfile,
  PetStage,
  PetStatKey,
  PetStatProgress,
  PetStreak,
} from "@/types/pet"
import { normalizeCoins, normalizeStatProgress, normalizeStreak } from "@/types/pet"
import {
  applyDecay,
  applyInteraction,
  applyNeedEffect,
  type PetInteractionKind,
} from "@/lib/pet/needs/decay"
import { getPetItem } from "@/lib/pet/economy/item-catalog"
import { levelForXp, stageForLevel } from "@/lib/pet/xp/leveling"
import { xpForEvent } from "@/lib/pet/xp/award-table"
import { coinsForEvent } from "@/lib/pet/economy/coin-table"
import { advanceStreak, coinMultiplier } from "@/lib/pet/economy/streak"
import { statDeltaForEvent } from "@/lib/pet/stats/growth-table"
import { applyStatGrowth, statsGrewKeys } from "@/lib/pet/stats/apply-growth"
import { deriveCareState } from "@/lib/pet/care/condition"

export const INTERACTION_KINDS: ReadonlySet<string> = new Set<string>([
  "fed",
  "played",
  "petted",
  "talked",
  "slept",
  "cleaned",
  "treated",
])

const INTERACTION_ONE_SHOT: Record<string, PetOneShot | null> = {
  fed: "fed",
  petted: "petted",
  played: "happy",
  talked: null,
  slept: "sleepy",
  cleaned: "happy",
  treated: "love",
}

/** Pure signals the controller derives from the activity ledger + event history. */
export interface ApplyEventOpts {
  /** Timestamps of recent XP-bearing events (burst/chaos growth signal). */
  recentEventTs?: number[]
  /** Whether this success immediately followed an error (debugging signal). */
  recoveredFromError?: boolean
}

export interface ApplyEventResult {
  /** `care` is always derived here, so it is guaranteed present on the result. */
  profile: PetProfile & { care: PetCareState }
  /** Flourishes to enqueue, in play order. */
  oneShots: PetOneShot[]
  /** New level if the pet leveled up this event, else null. */
  leveledUpTo: number | null
  /** New stage if the pet evolved this event, else null. */
  evolvedTo: PetStage | null
  /** Accumulated stat growth after this event. */
  statProgress: PetStatProgress
  /** Stat keys that grew this event (drives the "grew" indicator). */
  grewStats: PetStatKey[]
  /** Derived care state after this event. */
  care: PetCareState
  /** True on the well → unwell transition (controller fires the gentle notify). */
  becameUnwell: boolean
  /** True on the unwell → well transition. */
  recovered: boolean
  /** Coins minted by this event (already added into `profile.coins`). */
  coinsEarned: number
}

export function applyPetEvent(
  profile: PetProfile,
  event: PetEvent,
  now: number,
  opts?: ApplyEventOpts
): ApplyEventResult {
  // 1) Needs: interactions settle decay to `now` then add their restore; every
  // OTHER event still settles decay to `now` so the stored needs advance with
  // elapsed time. Without this an `idle`/heartbeat tick would derive care from
  // the un-decayed stored needs and the neglect → unwell transition could never
  // fire from pure time passing (decay was previously only ever persisted by an
  // interaction). Decay is monotonic and timestamp-keyed, so re-settling on
  // frequent events is a no-op beyond advancing `lastTickAt`.
  // An item consumption rides its interaction kind with `meta.itemId`; the
  // item's differentiated restore replaces the base interaction effect (an
  // unknown id falls back to the base table).
  const item = typeof event.meta?.itemId === "string" ? getPetItem(event.meta.itemId) : undefined
  const needs = INTERACTION_KINDS.has(event.kind)
    ? item?.needsEffect
      ? applyNeedEffect(profile.needs, item.needsEffect, now)
      : applyInteraction(profile.needs, event.kind as PetInteractionKind, now)
    : applyDecay(profile.needs, now)

  // 2) XP + derived level/stage.
  const xp = profile.xp + xpForEvent(event.kind, event.xp)
  const level = levelForXp(xp)
  // FUTURE: care.careQuality could bias evolution flavor / branch here.
  const stage: PetStage = profile.soul ? stageForLevel(level) : "egg"

  // 2a) Coins + streak. Only direct user interactions advance the streak;
  // everything coin-bearing still mints (with the streak multiplier applied),
  // and an explicit `meta.coins` (plugin rewards, pre-clamped) wins the table.
  const prevStreak: PetStreak = normalizeStreak(profile.streak)
  const streak =
    INTERACTION_KINDS.has(event.kind) && event.source === "user"
      ? advanceStreak(prevStreak, now)
      : prevStreak
  const explicitCoins = typeof event.meta?.coins === "number" ? event.meta.coins : undefined
  const coinsEarned = Math.floor(
    coinsForEvent(event.kind, explicitCoins) * coinMultiplier(streak.days)
  )
  const coins = normalizeCoins(profile.coins) + coinsEarned

  // 2b) Stat growth (additive on top of the deterministic base bones stats) +
  // care condition derived from the freshly-settled needs.
  const delta = statDeltaForEvent(
    { kind: event.kind, source: event.source, now },
    { recentEventTs: opts?.recentEventTs, recoveredFromError: opts?.recoveredFromError }
  )
  const prevProgress = normalizeStatProgress(profile.statProgress)
  const statProgress = applyStatGrowth(prevProgress, delta)
  const grewStats = statsGrewKeys(prevProgress, statProgress)
  const { care, becameUnwell, recovered } = deriveCareState({ needs, prev: profile.care, now })

  // 3) Flourishes.
  const oneShots: PetOneShot[] = []
  const interactionShot = INTERACTION_ONE_SHOT[event.kind]
  if (interactionShot) oneShots.push(interactionShot)
  if (event.kind === "success" || event.kind === "goalComplete") oneShots.push("happy")

  const leveledUpTo = level > profile.level ? level : null
  if (leveledUpTo) oneShots.push("levelUp")

  let evolvedTo: PetStage | null = null
  if (stage !== profile.stage && profile.stage !== "egg") {
    evolvedTo = stage
    oneShots.push("evolving")
  }

  return {
    profile: {
      ...profile,
      xp,
      level,
      stage,
      needs,
      statProgress,
      care,
      coins,
      streak,
      updatedAt: new Date(now).toISOString(),
    },
    oneShots,
    leveledUpTo,
    evolvedTo,
    statProgress,
    grewStats,
    care,
    becameUnwell,
    recovered,
    coinsEarned,
  }
}
