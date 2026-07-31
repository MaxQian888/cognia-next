import {
  registerPetItem,
  __resetPetItemsForTesting,
} from "@/lib/plugin/registries/pet-item-registry"
import {
  registerPetAchievement,
  __resetPetAchievementsForTesting,
} from "@/lib/plugin/registries/pet-achievement-registry"
import {
  isPluginPetId,
  pickLocalized,
  pluginAchievementText,
  pluginItemText,
} from "./plugin-display"

afterEach(() => {
  __resetPetItemsForTesting()
  __resetPetAchievementsForTesting()
})

describe("pickLocalized", () => {
  it("prefers the exact locale tag", () => {
    expect(pickLocalized({ en: "Cookie", "zh-CN": "饼干" }, "zh-CN")).toBe("饼干")
  })

  it("falls back to the base language, then en", () => {
    expect(pickLocalized({ en: "Cookie", zh: "饼干" }, "zh-CN")).toBe("饼干")
    expect(pickLocalized({ en: "Cookie" }, "zh-CN")).toBe("Cookie")
  })

  it("returns undefined for an absent record", () => {
    expect(pickLocalized(undefined, "en")).toBeUndefined()
  })
})

describe("isPluginPetId", () => {
  it("detects namespaced plugin ids", () => {
    expect(isPluginPetId("plugin:p1:star-cookie")).toBe(true)
    expect(isPluginPetId("berry")).toBe(false)
  })
})

describe("pluginItemText", () => {
  it("resolves labels and descriptions for a registered plugin item", () => {
    registerPetItem(
      "star-cookie",
      {
        id: "star-cookie",
        labels: { en: "Star Cookie", "zh-CN": "星星饼干" },
        descriptions: { en: "A crunchy star." },
        category: "food",
        price: 10,
        consumable: true,
      },
      { pluginId: "p1" }
    )
    expect(pluginItemText("plugin:p1:star-cookie", "zh-CN")).toEqual({
      title: "星星饼干",
      description: "A crunchy star.",
    })
  })

  it("falls back to the local id when labels are empty and null description", () => {
    registerPetItem(
      "mystery",
      {
        id: "mystery",
        labels: {} as Record<string, string>,
        category: "toy",
        price: 5,
        consumable: true,
      },
      { pluginId: "p1" }
    )
    expect(pluginItemText("plugin:p1:mystery", "en")).toEqual({
      title: "mystery",
      description: null,
    })
  })

  it("returns undefined for static ids and unregistered plugin ids", () => {
    expect(pluginItemText("berry", "en")).toBeUndefined()
    expect(pluginItemText("plugin:gone:item", "en")).toBeUndefined()
  })
})

describe("pluginAchievementText", () => {
  it("resolves labels for a registered plugin achievement", () => {
    registerPetAchievement(
      "quest-streak",
      {
        id: "quest-streak",
        labels: { en: "Quest Streak" },
        descriptions: { en: "Complete quests 7 days in a row." },
        condition: { type: "level", gte: 1 },
      },
      { pluginId: "p1" }
    )
    expect(pluginAchievementText("plugin:p1:quest-streak", "en")).toEqual({
      title: "Quest Streak",
      description: "Complete quests 7 days in a row.",
    })
  })

  it("returns undefined for static ids", () => {
    expect(pluginAchievementText("hatched", "en")).toBeUndefined()
  })
})
