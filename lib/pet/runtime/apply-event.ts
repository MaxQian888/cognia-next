// Pure "apply a PetEvent to the profile" step: award XP, settle interaction
// needs, recompute level/stage, and report any one-shot flourishes (feed/pet,
// level-up, evolution) the UI should play. The controller hook persists the
// result and runs side effects (achievements, bubbles); keeping this pure makes
// the progression rules exhaustively testable.

import type { PetEvent, PetOneShot, PetProfile, PetStage } from "@/types/pet"
import { applyInteraction } from "@/lib/pet/needs/decay"
import { levelForXp, stageForLevel } from "@/lib/pet/xp/leveling"
import { xpForEvent } from "@/lib/pet/xp/award-table"

const INTERACTION_KINDS = new Set(["fed", "played", "petted", "talked"])

const INTERACTION_ONE_SHOT: Record<string, PetOneShot | null> = {
  fed: "fed",
  petted: "petted",
  played: "happy",
  talked: null,
}

export interface ApplyEventResult {
  profile: PetProfile
  /** Flourishes to enqueue, in play order. */
  oneShots: PetOneShot[]
  /** New level if the pet leveled up this event, else null. */
  leveledUpTo: number | null
  /** New stage if the pet evolved this event, else null. */
  evolvedTo: PetStage | null
}

export function applyPetEvent(profile: PetProfile, event: PetEvent, now: number): ApplyEventResult {
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
  const stage: PetStage = profile.soul ? stageForLevel(level) : "egg"

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
      updatedAt: new Date(now).toISOString(),
    },
    oneShots,
    leveledUpTo,
    evolvedTo,
  }
}
