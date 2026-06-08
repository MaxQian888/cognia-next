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
} from "@/types/pet"
import { normalizeStatProgress } from "@/types/pet"
import { applyInteraction } from "@/lib/pet/needs/decay"
import { levelForXp, stageForLevel } from "@/lib/pet/xp/leveling"
import { xpForEvent } from "@/lib/pet/xp/award-table"
import { statDeltaForEvent } from "@/lib/pet/stats/growth-table"
import { applyStatGrowth, statsGrewKeys } from "@/lib/pet/stats/apply-growth"
import { deriveCareState } from "@/lib/pet/care/condition"

const INTERACTION_KINDS = new Set(["fed", "played", "petted", "talked"])

const INTERACTION_ONE_SHOT: Record<string, PetOneShot | null> = {
  fed: "fed",
  petted: "petted",
  played: "happy",
  talked: null,
}

/** Pure signals the controller derives from the activity ledger + event history. */
export interface ApplyEventOpts {
  /** Timestamps of recent XP-bearing events (burst/chaos growth signal). */
  recentEventTs?: number[]
  /** Whether this success immediately followed an error (debugging signal). */
  recoveredFromError?: boolean
}

export interface ApplyEventResult {
  profile: PetProfile
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
}

export function applyPetEvent(
  profile: PetProfile,
  event: PetEvent,
  now: number,
  opts?: ApplyEventOpts
): ApplyEventResult {
  // 1) Needs: only direct interactions change them here (decay is lazy on read).
  const needs =
    INTERACTION_KINDS.has(event.kind) && event.kind !== "talked"
      ? applyInteraction(profile.needs, event.kind as "fed" | "played" | "petted", now)
      : event.kind === "talked"
        ? applyInteraction(profile.needs, "talked", now)
        : profile.needs

  // 2) XP + derived level/stage.
  const xp = profile.xp + xpForEvent(event.kind, event.xp)
  const level = levelForXp(xp)
  // FUTURE: care.careQuality could bias evolution flavor / branch here.
  const stage: PetStage = profile.soul ? stageForLevel(level) : "egg"

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
  }
}
