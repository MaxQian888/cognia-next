import {
  MAX_COINS_PER_REWARD,
  MAX_XP_PER_REWARD,
  PET_INTERACTION_KINDS,
  PET_REWARDABLE_KINDS,
} from "./limits"
import { PET_DAILY_COIN_BUDGET, PET_DAILY_XP_BUDGET } from "./reward-budget"
import { INTERACTION_COOLDOWN_MS } from "@/lib/pet/interaction/gate"

describe("pet access limits", () => {
  it("lists the seven nurture actions", () => {
    expect(PET_INTERACTION_KINDS).toEqual([
      "fed",
      "played",
      "petted",
      "talked",
      "slept",
      "cleaned",
      "treated",
    ])
  })

  it("rewards the nurture actions plus the two non-care kinds, nothing lifecycle", () => {
    expect(PET_REWARDABLE_KINDS).toEqual([...PET_INTERACTION_KINDS, "workflowRun", "pluginReward"])
    for (const forbidden of ["levelUp", "evolved", "hatched", "achievementUnlocked", "unwell"]) {
      expect(PET_REWARDABLE_KINDS).not.toContain(forbidden)
    }
  })

  it("keeps the per-call ceilings strictly below the daily budgets", () => {
    expect(MAX_XP_PER_REWARD).toBeGreaterThan(0)
    expect(MAX_XP_PER_REWARD).toBeLessThan(PET_DAILY_XP_BUDGET)
    expect(MAX_COINS_PER_REWARD).toBeGreaterThan(0)
    expect(MAX_COINS_PER_REWARD).toBeLessThan(PET_DAILY_COIN_BUDGET)
  })

  it("gives every cooled nurture a place in the interaction vocabulary", () => {
    for (const kind of Object.keys(INTERACTION_COOLDOWN_MS)) {
      expect(PET_INTERACTION_KINDS).toContain(kind)
    }
  })
})
