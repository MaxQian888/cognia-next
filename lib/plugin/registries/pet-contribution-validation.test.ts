import {
  MAX_PET_ITEM_PRICE,
  assertValidPetAchievementDef,
  assertValidPetItemDef,
  formatPetContributionIssues,
  validatePetAchievementDef,
  validatePetItemDef,
} from "./pet-contribution-validation"

const ITEM = {
  id: "star-cookie",
  labels: { en: "Star cookie", "zh-CN": "星星饼干" },
  category: "food",
  price: 25,
  consumable: true,
  interactionKind: "fed",
  needsEffect: { energy: 12, mood: 4 },
}

const ACHIEVEMENT = {
  id: "quest-master",
  labels: { en: "Quest master" },
  descriptions: { en: "Claim three quest rewards." },
  icon: "Sparkles",
  condition: { type: "counter", kind: "pluginReward", gte: 3 },
}

const paths = (issues: { path: string }[]) => issues.map((i) => i.path)

describe("validatePetItemDef", () => {
  it("accepts a well-formed consumable and a plain decor item", () => {
    expect(validatePetItemDef(ITEM)).toEqual([])
    expect(
      validatePetItemDef({
        id: "lamp",
        labels: { en: "Lamp" },
        category: "decor",
        price: 40,
        consumable: false,
      })
    ).toEqual([])
  })

  it("rejects a non-object", () => {
    expect(validatePetItemDef(null)).toEqual([{ path: "", message: "must be an object" }])
    expect(validatePetItemDef([])).toHaveLength(1)
  })

  it("rejects unsafe ids", () => {
    for (const id of ["", "has space", "../escape", "-lead", "x".repeat(65), 7]) {
      expect(paths(validatePetItemDef({ ...ITEM, id }))).toContain("id")
    }
  })

  it("requires an English label and string labels", () => {
    expect(paths(validatePetItemDef({ ...ITEM, labels: { "zh-CN": "饼干" } }))).toContain(
      "labels.en"
    )
    expect(paths(validatePetItemDef({ ...ITEM, labels: { en: "  " } }))).toContain("labels.en")
    expect(paths(validatePetItemDef({ ...ITEM, labels: { en: "x", fr: 3 } }))).toContain(
      "labels.fr"
    )
    expect(paths(validatePetItemDef({ ...ITEM, descriptions: "nope" }))).toContain("descriptions")
  })

  it("rejects unknown categories and bad prices", () => {
    expect(paths(validatePetItemDef({ ...ITEM, category: "weapon" }))).toContain("category")
    for (const price of [0, -5, 2.5, Number.NaN, MAX_PET_ITEM_PRICE + 1, "10"]) {
      expect(paths(validatePetItemDef({ ...ITEM, price }))).toContain("price")
    }
  })

  it("requires a boolean consumable flag and an interaction for consumables", () => {
    expect(paths(validatePetItemDef({ ...ITEM, consumable: "yes" }))).toContain("consumable")
    const { interactionKind: _omit, ...noKind } = ITEM
    expect(paths(validatePetItemDef(noKind))).toContain("interactionKind")
    expect(paths(validatePetItemDef({ ...ITEM, interactionKind: "workflowRun" }))).toContain(
      "interactionKind"
    )
  })

  it("bounds needsEffect and refuses it on non-consumables", () => {
    expect(paths(validatePetItemDef({ ...ITEM, needsEffect: { hunger: 5 } }))).toContain(
      "needsEffect.hunger"
    )
    expect(paths(validatePetItemDef({ ...ITEM, needsEffect: { energy: 500 } }))).toContain(
      "needsEffect.energy"
    )
    expect(paths(validatePetItemDef({ ...ITEM, needsEffect: [1] }))).toContain("needsEffect")
    expect(
      paths(
        validatePetItemDef({
          id: "lamp",
          labels: { en: "Lamp" },
          category: "decor",
          price: 40,
          consumable: false,
          needsEffect: { mood: 5 },
        })
      )
    ).toContain("needsEffect")
  })

  it("accepts an absent icon and rejects a blank one", () => {
    const { icon: _none, ...withoutIcon } = { ...ITEM, icon: "Cookie" }
    expect(validatePetItemDef(withoutIcon)).toEqual([])
    expect(paths(validatePetItemDef({ ...ITEM, icon: " " }))).toContain("icon")
  })
})

describe("validatePetAchievementDef", () => {
  it("accepts each condition type", () => {
    expect(validatePetAchievementDef(ACHIEVEMENT)).toEqual([])
    expect(
      validatePetAchievementDef({ ...ACHIEVEMENT, condition: { type: "level", gte: 10 } })
    ).toEqual([])
    expect(
      validatePetAchievementDef({
        ...ACHIEVEMENT,
        condition: { type: "need", need: "bond", gte: 90 },
      })
    ).toEqual([])
  })

  it("rejects a counter on a kind the ledger never records", () => {
    expect(
      paths(
        validatePetAchievementDef({
          ...ACHIEVEMENT,
          condition: { type: "counter", kind: "quest.completed", gte: 3 },
        })
      )
    ).toContain("condition.kind")
  })

  it("rejects condition types the compiler does not know", () => {
    expect(
      paths(validatePetAchievementDef({ ...ACHIEVEMENT, condition: { type: "feedCount", gte: 1 } }))
    ).toContain("condition.type")
    expect(paths(validatePetAchievementDef({ ...ACHIEVEMENT, condition: null }))).toContain(
      "condition"
    )
  })

  it("rejects negative, non-finite or unreachable thresholds", () => {
    for (const gte of [-1, Number.POSITIVE_INFINITY, "3"]) {
      expect(
        paths(validatePetAchievementDef({ ...ACHIEVEMENT, condition: { type: "level", gte } }))
      ).toContain("condition.gte")
    }
    expect(
      paths(
        validatePetAchievementDef({
          ...ACHIEVEMENT,
          condition: { type: "need", need: "mood", gte: 150 },
        })
      )
    ).toContain("condition.gte")
  })

  it("rejects an unknown need", () => {
    expect(
      paths(
        validatePetAchievementDef({
          ...ACHIEVEMENT,
          condition: { type: "need", need: "hunger", gte: 10 },
        })
      )
    ).toContain("condition.need")
  })
})

describe("assertions and formatting", () => {
  it("returns a valid def unchanged", () => {
    expect(assertValidPetItemDef(ITEM, "item")).toBe(ITEM)
    expect(assertValidPetAchievementDef(ACHIEVEMENT, "achievement")).toBe(ACHIEVEMENT)
  })

  it("throws one message naming every problem", () => {
    expect(() =>
      assertValidPetItemDef({ ...ITEM, price: 0, category: "x" }, 'petItems "a"')
    ).toThrow(/petItems "a": category .*; price /)
    expect(() => assertValidPetAchievementDef({ ...ACHIEVEMENT, labels: {} }, "ach")).toThrow(
      /ach: labels\.en/
    )
  })

  it("formats an issue without a path as its bare message", () => {
    expect(formatPetContributionIssues("x", [{ path: "", message: "must be an object" }])).toBe(
      "x: must be an object"
    )
  })
})
