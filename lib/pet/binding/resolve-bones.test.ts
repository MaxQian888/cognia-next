import { applyCosmeticOverlay, resolveEffectiveBones } from "./resolve-bones"
import type { PetBones, PetCharacterBinding } from "@/types/pet"

function bones(): PetBones {
  return {
    species: "cat",
    rarity: "legendary",
    stars: 5,
    eyes: "dot",
    hat: "crown",
    shiny: true,
    bodyType: "round",
    palette: { primary: "#a", secondary: "#b", accent: "#c" },
    stats: { debugging: 1, patience: 1, chaos: 1, wisdom: 1, snark: 1 },
  }
}

describe("resolveEffectiveBones", () => {
  it("returns the global bones unchanged when there is no binding", () => {
    const g = bones()
    expect(resolveEffectiveBones(g, null)).toBe(g)
  })

  it("overrides only the cosmetic fields, keeping identity fields", () => {
    const binding: PetCharacterBinding = {
      characterId: "c1",
      species: "owl",
      hat: "wizard",
      palette: { primary: "#x", secondary: "#y", accent: "#z" },
      updatedAt: "",
    }
    const out = resolveEffectiveBones(bones(), binding)
    expect(out.species).toBe("owl")
    expect(out.hat).toBe("wizard")
    expect(out.palette.primary).toBe("#x")
    // identity preserved
    expect(out.rarity).toBe("legendary")
    expect(out.shiny).toBe(true)
    expect(out.stars).toBe(5)
    // untouched cosmetic falls back to global
    expect(out.eyes).toBe("dot")
  })
})

describe("applyCosmeticOverlay", () => {
  it("returns bones unchanged for an absent or empty override", () => {
    const g = bones()
    expect(applyCosmeticOverlay(g, null)).toBe(g)
    expect(applyCosmeticOverlay(g, undefined)).toBe(g)
    const out = applyCosmeticOverlay(g, {})
    expect(out).toEqual(g)
  })

  it("overrides only the cosmetic fields and never identity", () => {
    const out = applyCosmeticOverlay(bones(), {
      palette: { primary: "#x", secondary: "#y", accent: "#z" },
      hat: "beanie",
      eyes: "star",
      bodyType: "tall",
    })
    expect(out.palette.primary).toBe("#x")
    expect(out.hat).toBe("beanie")
    expect(out.eyes).toBe("star")
    expect(out.bodyType).toBe("tall")
    // identity untouched
    expect(out.species).toBe("cat")
    expect(out.rarity).toBe("legendary")
    expect(out.stars).toBe(5)
    expect(out.shiny).toBe(true)
    expect(out.stats).toEqual(bones().stats)
  })
})
