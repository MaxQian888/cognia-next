import { computePetView } from "./pet-view"
import { createDefaultProfile } from "@/lib/pet/defaults"
import { generateBones } from "@/lib/pet/bones/generate"
import type { PetCharacterBinding, PetProfile } from "@/types/pet"

function profile(overrides: Partial<PetProfile> = {}): PetProfile {
  return { ...createDefaultProfile("acct-1", 0), ...overrides }
}

describe("computePetView", () => {
  it("derives bones, decayed needs and mood", () => {
    const HOUR = 3_600_000
    const view = computePetView(profile(), null, HOUR)
    expect(view.bones).toEqual(generateBones("acct-1"))
    expect(view.effectiveBones).toEqual(view.bones) // no binding
    expect(view.needs.energy).toBeLessThan(100) // decayed
    expect(["content", "happy", "tired", "lonely", "grumpy"]).toContain(view.mood)
  })

  it("applies a character binding to the render bones only", () => {
    const binding: PetCharacterBinding = { characterId: "c1", species: "dragon", updatedAt: "" }
    const view = computePetView(profile(), binding, 0)
    expect(view.effectiveBones.species).toBe("dragon")
    expect(view.bones.species).not.toBe("dragon") // global bones untouched
  })

  it("exposes effective stats (base bones + earned growth)", () => {
    const base = generateBones("acct-1").stats
    const view = computePetView(
      profile({ statProgress: { debugging: 5, patience: 0, chaos: 0, wisdom: 0, snark: 0 } }),
      null,
      0
    )
    expect(view.effectiveStats.debugging).toBe(Math.min(100, base.debugging + 5))
  })

  it("reads as unwell when needs have decayed low for long enough", () => {
    const start = 1_000_000
    const p = profile({
      needs: { energy: 5, mood: 5, bond: 50, lastTickAt: new Date(start).toISOString() },
      care: {
        lowSince: start,
        condition: "unwell",
        notifiedAt: start,
        everUnwell: true,
        careQuality: 30,
      },
    })
    const view = computePetView(p, null, start + 1000)
    expect(view.condition).toBe("unwell")
  })

  it("reads as well for a healthy pet", () => {
    expect(computePetView(profile(), null, 0).condition).toBe("well")
  })
})
