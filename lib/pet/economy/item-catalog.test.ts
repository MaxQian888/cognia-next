import { PET_ITEMS, getPetItem, petHatItem } from "./item-catalog"

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

  it("covers the food, toy, care, and decor categories", () => {
    const categories = new Set(PET_ITEMS.map((i) => i.category))
    expect(categories).toContain("food")
    expect(categories).toContain("toy")
    expect(categories).toContain("care")
    expect(categories).toContain("decor")
  })

  it("care items map to the sleep/clean/treat interactions", () => {
    const care = PET_ITEMS.filter((i) => i.category === "care")
    expect(care.length).toBeGreaterThanOrEqual(3)
    const kinds = new Set(care.map((i) => i.interactionKind))
    expect(kinds).toContain("slept")
    expect(kinds).toContain("cleaned")
    expect(kinds).toContain("treated")
  })

  it("petHatItem resolves every purchasable hat and skips free/genetic ones", () => {
    // Each shop hat resolves to its own decor item.
    for (const hat of ["crown", "tophat", "wizard", "halo", "propeller", "beanie"]) {
      const item = petHatItem(hat)
      expect(item?.cosmetic?.hat).toBe(hat)
      expect(item?.category).toBe("decor")
    }
    // Bare-headed and the legendary genetics-only hat have no shop item.
    expect(petHatItem("none")).toBeUndefined()
    expect(petHatItem("tinyduck")).toBeUndefined()
  })

  it("keeps hat-granting decor items one-per-hat", () => {
    const hats = PET_ITEMS.filter((i) => i.cosmetic?.hat).map((i) => i.cosmetic!.hat)
    expect(new Set(hats).size).toBe(hats.length)
  })
})
