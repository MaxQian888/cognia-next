// Visual mapping for growth stages. Pure — the renderer uses these to scale the
// creature as it evolves and to know when to draw an egg instead of a body.

import type { PetStage } from "@/types/pet"

/** Whole-creature scale factor per stage (egg handled separately). */
export function stageScale(stage: PetStage): number {
  switch (stage) {
    case "egg":
      return 0.7
    case "baby":
      return 0.78
    case "juvenile":
      return 0.9
    case "adult":
      return 1
    case "elder":
      return 1.06
  }
}

/** The egg stage renders a shell, not the creature body. */
export function isEggStage(stage: PetStage): boolean {
  return stage === "egg"
}
