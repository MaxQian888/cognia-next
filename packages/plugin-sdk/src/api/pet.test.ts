import * as sdk from "./pet"

describe("plugin-sdk: api/pet", () => {
  it("re-exports the manifest helpers, the read side of the registries and the plugin-scoped teardown", () => {
    expect(typeof sdk.definePetAchievement).toBe("function")
    expect(typeof sdk.definePetItem).toBe("function")
    expect(typeof sdk.unregisterPetAchievementsByPlugin).toBe("function")
    expect(typeof sdk.listPetAchievementEntries).toBe("function")
    expect(typeof sdk.buildPluginAchievementId).toBe("function")
    expect(typeof sdk.compilePluginAchievement).toBe("function")
    expect(typeof sdk.listCompiledPluginAchievements).toBe("function")
    expect(typeof sdk.getPluginAchievementDisplay).toBe("function")
    expect(typeof sdk.unregisterPetItemsByPlugin).toBe("function")
    expect(typeof sdk.listPetItemEntries).toBe("function")
    expect(typeof sdk.buildPluginItemId).toBe("function")
    expect(typeof sdk.projectPluginItem).toBe("function")
    expect(typeof sdk.listProjectedPluginItems).toBe("function")
    expect(typeof sdk.getProjectedPluginItem).toBe("function")
    expect(typeof sdk.getPluginItemDisplay).toBe("function")
  })

  it("does not hand authors the host's registration primitives", () => {
    // Items and achievements are contributed through the manifest, which the
    // host validates and registers; a direct register skipped that, and a
    // by-id unregister could remove another plugin's contribution.
    const surface = sdk as Record<string, unknown>
    for (const name of [
      "registerPetItem",
      "registerPetAchievement",
      "unregisterPetItemById",
      "unregisterPetAchievementById",
    ]) {
      expect(surface[name]).toBeUndefined()
    }
  })

  it("publishes the vocabulary, limits and errors ctx.pet enforces", () => {
    expect(sdk.PLUGIN_EMITTABLE_PET_EVENT_KINDS).toContain("pluginReward")
    expect(sdk.PLUGIN_EMITTABLE_PET_EVENT_KINDS).not.toContain("levelUp")
    expect(sdk.MAX_XP_PER_EMIT).toBeGreaterThan(0)
    expect(sdk.MAX_COINS_PER_EMIT).toBeGreaterThan(0)
    expect(new sdk.PetCooldownError("fed", 1000)).toBeInstanceOf(Error)
    expect(new sdk.PetItemKindMismatchError("berry", "petted", "fed").itemKind).toBe("fed")
    expect(new sdk.PetItemNotOwnedError("berry").name).toBe("PetItemNotOwnedError")
    expect(new sdk.PetEventKindNotAllowedError("evolved").name).toBe("PetEventKindNotAllowedError")
  })

  it("definePetAchievement is a typesafe identity helper", () => {
    const achievement = sdk.definePetAchievement({
      id: "quest-master",
      labels: { en: "Quest master" },
      descriptions: { en: "Complete daily quests." },
      icon: "Sparkles",
      condition: { type: "counter", kind: "pluginReward", gte: 3 },
    })

    expect(achievement.id).toBe("quest-master")
    expect(achievement.condition).toEqual({
      type: "counter",
      kind: "pluginReward",
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
