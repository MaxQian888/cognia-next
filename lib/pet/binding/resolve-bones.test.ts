import { resolveEffectiveBones } from "./resolve-bones"
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
