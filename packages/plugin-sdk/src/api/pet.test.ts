import * as sdk from "./pet"

describe("plugin-sdk: api/pet", () => {
  it("re-exports the pet manifest helpers and overlay registries", () => {
    expect(typeof sdk.definePetAchievement).toBe("function")
    expect(typeof sdk.definePetItem).toBe("function")
    expect(typeof sdk.registerPetAchievement).toBe("function")
    expect(typeof sdk.unregisterPetAchievementById).toBe("function")
    expect(typeof sdk.unregisterPetAchievementsByPlugin).toBe("function")
    expect(typeof sdk.listPetAchievementEntries).toBe("function")
    expect(typeof sdk.buildPluginAchievementId).toBe("function")
    expect(typeof sdk.compilePluginAchievement).toBe("function")
    expect(typeof sdk.listCompiledPluginAchievements).toBe("function")
    expect(typeof sdk.getPluginAchievementDisplay).toBe("function")
    expect(typeof sdk.registerPetItem).toBe("function")
    expect(typeof sdk.unregisterPetItemById).toBe("function")
    expect(typeof sdk.unregisterPetItemsByPlugin).toBe("function")
    expect(typeof sdk.listPetItemEntries).toBe("function")
    expect(typeof sdk.buildPluginItemId).toBe("function")
    expect(typeof sdk.projectPluginItem).toBe("function")
    expect(typeof sdk.listProjectedPluginItems).toBe("function")
    expect(typeof sdk.getProjectedPluginItem).toBe("function")
    expect(typeof sdk.getPluginItemDisplay).toBe("function")
  })

  it("definePetAchievement is a typesafe identity helper", () => {
    const achievement = sdk.definePetAchievement({
      id: "quest-master",
      labels: { en: "Quest master" },
      descriptions: { en: "Complete daily quests." },
      icon: "Sparkles",
      condition: { type: "counter", kind: "quest.completed", gte: 3 },
    })

    expect(achievement.id).toBe("quest-master")
    expect(achievement.condition).toEqual({
      type: "counter",
      kind: "quest.completed",
      gte: 3,
    })
  })

  it("definePetItem normalizes item definitions through the public API", () => {
    const item = sdk.definePetItem({
      id: "star-cookie",
      labels: { en: "Star cookie" },
      category: "food",
      price: 25,
      consumable: true,
      interactionKind: "fed",
      needsEffect: { energy: 12, mood: 4 },
    })

    expect(item.id).toBe("star-cookie")
    expect(item.needsEffect).toEqual({ energy: 12, mood: 4 })
  })

  it("projects namespaced ids using the stable host helpers", () => {
    expect(sdk.buildPluginAchievementId("plugin-a", "quest-master")).toBe(
      "plugin:plugin-a:quest-master"
    )
    expect(sdk.buildPluginItemId("plugin-a", "star-cookie")).toBe("plugin:plugin-a:star-cookie")
  })
})
