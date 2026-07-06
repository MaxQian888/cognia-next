import { PET_ITEMS, getPetItem } from "./item-catalog"

describe("PET_ITEMS catalog invariants", () => {
  it("has unique ids and getPetItem resolves them", () => {
    const ids = PET_ITEMS.map((i) => i.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(getPetItem("berry")?.id).toBe("berry")
    expect(getPetItem("nope")).toBeUndefined()
  })

  it("prices every item above zero", () => {
    for (const item of PET_ITEMS) expect(item.price).toBeGreaterThan(0)
  })

  it("gives every consumable an interaction kind and a needs effect", () => {
    for (const item of PET_ITEMS.filter((i) => i.consumable)) {
      expect(item.interactionKind).toBeDefined()
      expect(item.needsEffect).toBeDefined()
      expect(Object.keys(item.needsEffect!).length).toBeGreaterThan(0)
    }
  })

  it("gives every decor item a cosmetic override and no consumption", () => {
    const decor = PET_ITEMS.filter((i) => i.category === "decor")
    expect(decor.length).toBeGreaterThan(0)
    for (const item of decor) {
      expect(item.consumable).toBe(false)
      expect(item.cosmetic).toBeDefined()
    }
  })

  it("covers the food and toy categories", () => {
    const categories = new Set(PET_ITEMS.map((i) => i.category))
    expect(categories).toContain("food")
    expect(categories).toContain("toy")
  })
})
