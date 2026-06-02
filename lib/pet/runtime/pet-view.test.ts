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
})
