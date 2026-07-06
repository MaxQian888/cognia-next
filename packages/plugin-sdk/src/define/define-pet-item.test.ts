import { definePetItem } from "./define-pet-item"

describe("definePetItem", () => {
  it("returns the definition unchanged when the item is valid", () => {
    const def = {
      id: "star-cookie",
      labels: { en: "Star cookie" },
      category: "food" as const,
      price: 25,
      consumable: true,
      interactionKind: "fed" as const,
      needsEffect: { energy: 10 },
    }

    expect(definePetItem(def)).toBe(def)
  })

  it("throws when the item omits an English label", () => {
    expect(() =>
      definePetItem({
        id: "missing-label",
        labels: { "zh-CN": "缺少英文" },
        category: "toy",
        price: 10,
        consumable: false,
      })
    ).toThrow(/English label/)
  })

  it("throws when price is not positive", () => {
    expect(() =>
      definePetItem({
        id: "free",
        labels: { en: "Free" },
        category: "decor",
        price: 0,
        consumable: false,
      })
    ).toThrow(/price/)
  })
})
