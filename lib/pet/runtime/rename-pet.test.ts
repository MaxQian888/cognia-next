const getPetProfile = jest.fn()
const patchPetProfile = jest.fn()
jest.mock("@/lib/db/pet", () => ({
  getPetProfile: () => getPetProfile(),
  patchPetProfile: (patch: unknown, now?: number) => patchPetProfile(patch, now),
}))

import { renamePet, sanitizePetName, isValidPetName, MAX_PET_NAME } from "./rename-pet"
import type { PetProfile } from "@/types/pet"

const baseProfile = (name: string | null): PetProfile =>
  ({
    id: "global",
    soul: name ? { name, personality: "p", hatchDate: "h" } : null,
    xp: 0,
    level: 1,
    stage: name ? "baby" : "egg",
    needs: { energy: 50, mood: 50, bond: 50, lastTickAt: "2026-01-01T00:00:00.000Z" },
    accountFingerprint: "acct",
    createdAt: "c",
    updatedAt: "u",
  }) as PetProfile

beforeEach(() => {
  getPetProfile.mockReset()
  patchPetProfile.mockReset()
})

describe("sanitizePetName / isValidPetName", () => {
  it("collapses whitespace, trims, and clamps to the cap", () => {
    expect(sanitizePetName("  Sir   Boba  ")).toBe("Sir Boba")
    expect(sanitizePetName("x".repeat(40))).toHaveLength(MAX_PET_NAME)
  })
  it("rejects blank names", () => {
    expect(isValidPetName("   ")).toBe(false)
    expect(isValidPetName("Boba")).toBe(true)
  })
})

describe("renamePet", () => {
  it("persists a sanitized new name via patchPetProfile", async () => {
    getPetProfile.mockResolvedValue(baseProfile("Boba"))
    patchPetProfile.mockResolvedValue(baseProfile("Mochi"))
    const res = await renamePet("  Mochi  ", 123)
    expect(patchPetProfile).toHaveBeenCalledWith(
      { soul: { name: "Mochi", personality: "p", hatchDate: "h" } },
      123
    )
    expect(res?.soul?.name).toBe("Mochi")
  })

  it("is a no-op for a blank name", async () => {
    expect(await renamePet("   ")).toBeUndefined()
    expect(getPetProfile).not.toHaveBeenCalled()
    expect(patchPetProfile).not.toHaveBeenCalled()
  })

  it("is a no-op when there is no profile or no soul yet", async () => {
    getPetProfile.mockResolvedValueOnce(undefined)
    expect(await renamePet("Mochi")).toBeUndefined()
    getPetProfile.mockResolvedValueOnce(baseProfile(null))
    expect(await renamePet("Mochi")).toBeUndefined()
    expect(patchPetProfile).not.toHaveBeenCalled()
  })

  it("skips the write when the name is unchanged", async () => {
    const profile = baseProfile("Boba")
    getPetProfile.mockResolvedValue(profile)
    const res = await renamePet("Boba")
    expect(res).toBe(profile)
    expect(patchPetProfile).not.toHaveBeenCalled()
  })
})
