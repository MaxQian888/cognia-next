import { definePetAchievement } from "./define-pet-achievement"

describe("definePetAchievement", () => {
  it("returns the definition unchanged when the required localized label exists", () => {
    const def = {
      id: "social",
      labels: { en: "Social" },
      condition: { type: "level", gte: 5 } as const,
    }

    expect(definePetAchievement(def)).toBe(def)
  })

  it("throws when the achievement omits an English label", () => {
    expect(() =>
      definePetAchievement({
        id: "missing-label",
        labels: { "zh-CN": "缺少英文" },
        condition: { type: "need", need: "bond", gte: 90 },
      })
    ).toThrow(/English label/)
  })

  it("throws when a threshold is negative", () => {
    expect(() =>
      definePetAchievement({
        id: "bad-threshold",
        labels: { en: "Bad threshold" },
        condition: { type: "counter", kind: "pluginReward", gte: -1 },
      })
    ).toThrow(/gte/)
  })

  it("throws for a counter on a kind the activity ledger never records", () => {
    // It would compile, register, and never unlock.
    expect(() =>
      definePetAchievement({
        id: "quest-master",
        labels: { en: "Quest master" },
        condition: { type: "counter", kind: "quest.completed", gte: 3 },
      })
    ).toThrow(/condition\.kind/)
  })

  it("throws for a condition type the host cannot compile", () => {
    expect(() =>
      definePetAchievement({
        id: "mystery",
        labels: { en: "Mystery" },
        condition: { type: "feedCount", gte: 1 } as never,
      })
    ).toThrow(/condition\.type/)
  })
})
