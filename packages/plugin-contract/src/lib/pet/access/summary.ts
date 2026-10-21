/**
 * The plugin contract's share of `lib/pet/access/summary.ts`, which re-exports these.
 */
import type { PetCondition, PetMood, PetNeeds, PetStage } from "@/types/pet"

export interface PetSummary {
  hatched: boolean
  name: string | null
  level: number
  stage: PetStage
  xp: number
  mood: PetMood
  needs: Pick<PetNeeds, "energy" | "mood" | "bond">
  condition: PetCondition
  coins: number
}
