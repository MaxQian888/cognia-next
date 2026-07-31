import {
  __resetPetAchievementsForTesting,
  buildPluginAchievementId,
  compilePluginAchievement,
  getPluginAchievementDisplay,
  listCompiledPluginAchievements,
  listPetAchievementEntries,
  registerPetAchievement,
  unregisterPetAchievementsByPlugin,
} from "./pet-achievement-registry"
import { createDefaultProfile } from "@/lib/pet/defaults"
import { DEFAULT_CARE_STATE, effectiveStats } from "@/types/pet"
import type { PetAchievementContext, PetBones } from "@/types/pet"
import type { PluginPetAchievementDef } from "@/types/plugin/plugin-pet"

function def(partial: Partial<PluginPetAchievementDef> = {}): PluginPetAchievementDef {
  return {
    id: "quest-master",
    labels: { en: "Quest Master", "zh-CN": "任务大师" },
    icon: "Trophy",
    condition: { type: "counter", kind: "fed", gte: 3 },
    ...partial,
  }
}

function ctx(overrides: {
  counters?: Record<string, number>
  level?: number
  needs?: { energy: number; mood: number; bond: number }
}): PetAchievementContext {
  const bones = {
    species: "cat",
    rarity: "common",
    stars: 1,
    eyes: "dot",
    hat: "none",
    shiny: false,
    bodyType: "round",
    palette: { primary: "#a", secondary: "#b", accent: "#c" },
    stats: { debugging: 1, patience: 1, chaos: 1, wisdom: 1, snark: 1 },
  } as PetBones
  const profile = {
    ...createDefaultProfile("acct", 0),
    level: overrides.level ?? 1,
    needs: { ...(overrides.needs ?? { energy: 50, mood: 50, bond: 50 }), lastTickAt: "" },
  }
  return {
    profile,
    bones,
    activity: [],
    counters: overrides.counters ?? {},
    effectiveStats: effectiveStats(bones.stats),
    care: DEFAULT_CARE_STATE,
  }
}

afterEach(() => {
  __resetPetAchievementsForTesting()
})

describe("pet-achievement-registry", () => {
  it("registers, lists, and unregisters by plugin", () => {
    registerPetAchievement("quest-master", def(), { pluginId: "p1" })
    registerPetAchievement("other", def({ id: "other" }), { pluginId: "p2" })
    expect(listPetAchievementEntries()).toHaveLength(2)
    expect(unregisterPetAchievementsByPlugin("p1")).toBe(1)
    expect(listPetAchievementEntries()).toHaveLength(1)
  })

  it("keeps the incumbent on a cross-plugin id collision (first wins)", () => {
    registerPetAchievement("quest-master", def({ labels: { en: "First" } }), { pluginId: "p1" })
    registerPetAchievement("quest-master", def({ labels: { en: "Second" } }), { pluginId: "p2" })
    // Keys are namespaced by pluginId, so both coexist under distinct keys.
    expect(listPetAchievementEntries()).toHaveLength(2)
  })

  describe("compilePluginAchievement (condition DSL)", () => {
    it("namespaces the runtime id", () => {
      const compiled = compilePluginAchievement(def(), "p1")
      expect(compiled.id).toBe("plugin:p1:quest-master")
      expect(buildPluginAchievementId("p1", "quest-master")).toBe(compiled.id)
    })

    it("interprets counter conditions", () => {
      const compiled = compilePluginAchievement(def(), "p1")
      expect(compiled.isUnlocked(ctx({ counters: { fed: 2 } }))).toBe(false)
      expect(compiled.isUnlocked(ctx({ counters: { fed: 3 } }))).toBe(true)
    })

    it("interprets level conditions", () => {
      const compiled = compilePluginAchievement(def({ condition: { type: "level", gte: 5 } }), "p1")
      expect(compiled.isUnlocked(ctx({ level: 4 }))).toBe(false)
      expect(compiled.isUnlocked(ctx({ level: 5 }))).toBe(true)
    })

    it("interprets need conditions", () => {
      const compiled = compilePluginAchievement(
        def({ condition: { type: "need", need: "bond", gte: 90 } }),
        "p1"
      )
      expect(compiled.isUnlocked(ctx({ needs: { energy: 50, mood: 50, bond: 89 } }))).toBe(false)
      expect(compiled.isUnlocked(ctx({ needs: { energy: 50, mood: 50, bond: 90 } }))).toBe(true)
    })
  })

  it("exposes compiled entries + display metadata for the check loop and UI", () => {
    registerPetAchievement("quest-master", def(), { pluginId: "p1" })
    const compiled = listCompiledPluginAchievements()
    expect(compiled).toHaveLength(1)
    expect(compiled[0].id).toBe("plugin:p1:quest-master")
    const display = getPluginAchievementDisplay("plugin:p1:quest-master")
    expect(display?.def.labels.en).toBe("Quest Master")
    expect(getPluginAchievementDisplay("plugin:p1:nope")).toBeUndefined()
    expect(getPluginAchievementDisplay("hatched")).toBeUndefined()
  })
})
