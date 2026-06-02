import { getSpeciesTraits, ALL_PET_SPECIES } from "./species-traits"

describe("species traits", () => {
  it("defines traits for all 18 species", () => {
    expect(ALL_PET_SPECIES).toHaveLength(18)
  })

  it("returns a complete, well-formed trait set for every species", () => {
    for (const species of ALL_PET_SPECIES) {
      const t = getSpeciesTraits(species)
      expect(t.roundness).toBeGreaterThanOrEqual(0)
      expect(t.roundness).toBeLessThanOrEqual(1)
      expect(typeof t.cheeks).toBe("boolean")
      expect(t.ears).toBeDefined()
      expect(t.tail).toBeDefined()
      expect(t.face).toBeDefined()
    }
  })

  it("gives the blob max roundness and the robot the least", () => {
    expect(getSpeciesTraits("blob").roundness).toBe(1)
    expect(getSpeciesTraits("robot").roundness).toBeLessThan(getSpeciesTraits("blob").roundness)
  })
})
