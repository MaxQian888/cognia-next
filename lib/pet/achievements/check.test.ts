import { checkAchievements } from "./check"
import { PET_ACHIEVEMENTS, getAchievement } from "./registry"
import { createDefaultProfile } from "@/lib/pet/defaults"
import { DEFAULT_CARE_STATE, effectiveStats } from "@/types/pet"
import type {
  PetAchievementContext,
  PetBones,
  PetCareState,
  PetProfile,
  PetStats,
} from "@/types/pet"

function bones(overrides: Partial<PetBones> = {}): PetBones {
  return {
    species: "cat",
    rarity: "common",
    stars: 1,
    eyes: "dot",
    hat: "none",
    shiny: false,
    bodyType: "round",
    palette: { primary: "#a", secondary: "#b", accent: "#c" },
    stats: { debugging: 1, patience: 1, chaos: 1, wisdom: 1, snark: 1 },
    ...overrides,
  }
}

function ctx(overrides: {
  profile?: Partial<PetProfile>
  bones?: Partial<PetBones>
  counters?: Record<string, number>
  effectiveStats?: Partial<PetStats>
  care?: Partial<PetCareState>
}): PetAchievementContext {
  const b = bones(overrides.bones)
  return {
    profile: { ...createDefaultProfile("acct", 0), ...overrides.profile },
    bones: b,
    activity: [],
    counters: overrides.counters ?? {},
    effectiveStats: { ...effectiveStats(b.stats), ...overrides.effectiveStats },
    care: { ...DEFAULT_CARE_STATE, ...overrides.care },
  }
}

describe("registry", () => {
  it("has unique ids and getAchievement resolves them", () => {
    const ids = PET_ACHIEVEMENTS.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(getAchievement("hatched")?.id).toBe("hatched")
    expect(getAchievement("nope")).toBeUndefined()
  })
})

describe("checkAchievements", () => {
  it("returns newly-qualified achievements only", () => {
    const c = ctx({
      profile: { soul: { name: "Boba", personality: "x", hatchDate: "" }, xp: 10, level: 5 },
    })
    const newly = checkAchievements(c, [])
    expect(newly).toEqual(expect.arrayContaining(["hatched", "first-xp", "juvenile"]))
  })

  it("excludes already-unlocked ids", () => {
    const c = ctx({ profile: { xp: 10 } })
    const newly = checkAchievements(c, ["first-xp"])
    expect(newly).not.toContain("first-xp")
  })

  it("unlocks counter- and bones-based achievements", () => {
    const fedCtx = ctx({ counters: { fed: 50 } })
    expect(checkAchievements(fedCtx, [])).toContain("well-fed")

    const shinyCtx = ctx({ bones: { shiny: true, rarity: "legendary" } })
    const newly = checkAchievements(shinyCtx, [])
    expect(newly).toEqual(expect.arrayContaining(["shiny-owner", "legendary"]))
  })

  it("unlocks the bond achievement at high bond", () => {
    const c = ctx({ profile: { needs: { energy: 0, mood: 0, bond: 95, lastTickAt: "" } } })
    expect(checkAchievements(c, [])).toContain("best-friends")
  })

  it("returns nothing for a brand-new unhatched pet", () => {
    expect(checkAchievements(ctx({}), [])).toEqual([])
  })

  it("unlocks stat-milestone achievements from effective stats", () => {
    const debug = ctx({ effectiveStats: { debugging: 100 } })
    expect(checkAchievements(debug, [])).toContain("master-debugger")

    const zen = ctx({ effectiveStats: { patience: 100 } })
    expect(checkAchievements(zen, [])).toContain("zen-master")

    const chaos = ctx({ effectiveStats: { chaos: 100 } })
    expect(checkAchievements(chaos, [])).toContain("chaos-gremlin")
  })

  it("unlocks nursed-back only after a recovered unwell episode", () => {
    const neverUnwell = ctx({ care: { condition: "well", everUnwell: false } })
    expect(checkAchievements(neverUnwell, [])).not.toContain("nursed-back")

    const recovered = ctx({ care: { condition: "well", everUnwell: true } })
    expect(checkAchievements(recovered, [])).toContain("nursed-back")

    const stillUnwell = ctx({ care: { condition: "unwell", everUnwell: true } })
    expect(checkAchievements(stillUnwell, [])).not.toContain("nursed-back")
  })

  it("unlocks devoted-caretaker at high care quality", () => {
    expect(checkAchievements(ctx({ care: { careQuality: 80 } }), [])).toContain("devoted-caretaker")
    expect(checkAchievements(ctx({ care: { careQuality: 79 } }), [])).not.toContain(
      "devoted-caretaker"
    )
  })
})
