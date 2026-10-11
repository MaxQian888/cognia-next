import { computePetView } from "@/lib/pet/runtime/pet-view"
import type { PetProfile } from "@/types/pet"

import { buildPetSlice } from "./build-pet"

jest.mock("@/lib/pet/runtime/pet-view", () => ({ computePetView: jest.fn() }))

const computePetViewMock = computePetView as jest.Mock

const NOW = 1_800_000_000_000
const profile = { id: "global" } as unknown as PetProfile

const DISABLED = {
  updatedAt: NOW,
  enabled: false,
  mood: null,
  condition: null,
  energy: 0,
  moodLevel: 0,
  bond: 0,
}

beforeEach(() => {
  computePetViewMock.mockReset()
})

describe("buildPetSlice", () => {
  it("is disabled with zeros when the pet is off", () => {
    expect(buildPetSlice(false, profile, NOW)).toEqual(DISABLED)
    expect(computePetViewMock).not.toHaveBeenCalled()
  })

  it.each([[null], [undefined]])("is disabled with zeros when the profile is %j", (p) => {
    expect(buildPetSlice(true, p, NOW)).toEqual(DISABLED)
    expect(computePetViewMock).not.toHaveBeenCalled()
  })

  it("reads mood, condition and rounded needs from computePetView", () => {
    computePetViewMock.mockReturnValue({
      mood: "happy",
      condition: "well",
      needs: { energy: 61.4, mood: 72.5, bond: 10.49 },
    })
    expect(buildPetSlice(true, profile, NOW)).toEqual({
      updatedAt: NOW,
      enabled: true,
      mood: "happy",
      condition: "well",
      energy: 61,
      moodLevel: 73,
      bond: 10,
    })
  })

  it("passes the profile, no binding and now to computePetView", () => {
    computePetViewMock.mockReturnValue({
      mood: "tired",
      condition: "unwell",
      needs: { energy: 0, mood: 0, bond: 0 },
    })
    buildPetSlice(true, profile, NOW)
    expect(computePetViewMock).toHaveBeenCalledWith(profile, null, NOW)
  })

  it("keeps an unwell, lonely pet's state", () => {
    computePetViewMock.mockReturnValue({
      mood: "lonely",
      condition: "unwell",
      needs: { energy: 3.2, mood: 0.4, bond: 99.6 },
    })
    expect(buildPetSlice(true, profile, NOW)).toMatchObject({
      mood: "lonely",
      condition: "unwell",
      energy: 3,
      moodLevel: 0,
      bond: 100,
    })
  })
})
