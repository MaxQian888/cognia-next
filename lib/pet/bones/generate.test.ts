import { generateBones } from "./generate"
import { ALL_PET_SPECIES } from "@/lib/pet/skins/species-traits"

describe("generateBones", () => {
  it("is fully deterministic for the same account id", () => {
    expect(generateBones("acct-123")).toEqual(generateBones("acct-123"))
  })

  it("produces a different look for a different account id", () => {
    expect(generateBones("acct-a")).not.toEqual(generateBones("acct-b"))
  })

  it("always yields a structurally valid, in-range pet", () => {
    for (let i = 0; i < 300; i++) {
      const b = generateBones(`acct-${i}`)
      expect(ALL_PET_SPECIES).toContain(b.species)
      expect(["common", "uncommon", "rare", "epic", "legendary"]).toContain(b.rarity)
      expect(b.stars).toBeGreaterThanOrEqual(1)
      expect(b.stars).toBeLessThanOrEqual(5)
      for (const v of Object.values(b.stats)) {
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(100)
      }
      expect(b.palette.primary).toMatch(/^oklch\(/)
    }
  })

  it("gates the legendary-only hat (tinyduck never appears below legendary)", () => {
    for (let i = 0; i < 2000; i++) {
      const b = generateBones(`gate-${i}`)
      if (b.hat === "tinyduck") expect(b.rarity).toBe("legendary")
    }
  })

  it("roughly follows the rarity distribution (common is the majority)", () => {
    const counts: Record<string, number> = {}
    const N = 4000
    for (let i = 0; i < N; i++) {
      const b = generateBones(`dist-${i}`)
      counts[b.rarity] = (counts[b.rarity] ?? 0) + 1
    }
    // Common should dominate; legendary should be rare.
    expect(counts.common / N).toBeGreaterThan(0.5)
    expect((counts.legendary ?? 0) / N).toBeLessThan(0.05)
  })

  it("can produce a shiny pet (1% — present somewhere in a large sample)", () => {
    let shinies = 0
    for (let i = 0; i < 3000; i++) if (generateBones(`shiny-${i}`).shiny) shinies++
    expect(shinies).toBeGreaterThan(0)
  })
})
