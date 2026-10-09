jest.mock("@/lib/ai/generation/utility-client", () => ({
  buildUtilityLlmClient: jest.fn(() => null),
}))
jest.mock("@/lib/db/pet", () => ({ getPetProfile: jest.fn() }))
jest.mock("@/lib/pet/events/pet-event-bus", () => ({ emitPetEvent: jest.fn() }))
jest.mock("./init-pet", () => ({ hatchPet: jest.fn() }))

import { buildUtilityLlmClient } from "@/lib/ai/generation/utility-client"
import { getPetProfile } from "@/lib/db/pet"
import { emitPetEvent } from "@/lib/pet/events/pet-event-bus"
import type { PetProfile } from "@/types/pet"
import { __resetHatchPetForTesting, hatchPetOnce } from "./hatch"
import { hatchPet } from "./init-pet"

const getProfileMock = getPetProfile as jest.Mock
const hatchMock = hatchPet as jest.Mock
const emitMock = emitPetEvent as jest.Mock
const buildMock = buildUtilityLlmClient as jest.Mock

const egg = { id: "global", soul: null } as unknown as PetProfile
const hatched = {
  id: "global",
  soul: { name: "Boba", personality: "x", hatchDate: "" },
} as unknown as PetProfile

beforeEach(() => {
  __resetHatchPetForTesting()
  getProfileMock.mockReset()
  hatchMock.mockReset()
  emitMock.mockReset()
  buildMock.mockClear()
})

describe("hatchPetOnce", () => {
  it("generates the soul with the pet-soul utility client and announces it", async () => {
    getProfileMock.mockResolvedValue(egg)
    hatchMock.mockResolvedValue(hatched)
    const outcome = await hatchPetOnce(null)
    expect(outcome).toEqual({ status: "hatched", profile: hatched })
    expect(buildMock).toHaveBeenCalledWith({
      session: null,
      appSettings: null,
      featureId: "pet-soul",
    })
    expect(emitMock).toHaveBeenCalledWith({ source: "system", kind: "hatched" })
  })

  it("shares one run between concurrent callers (the double-click race)", async () => {
    getProfileMock.mockResolvedValue(egg)
    let finish!: (p: PetProfile) => void
    hatchMock.mockReturnValue(new Promise<PetProfile>((resolve) => (finish = resolve)))
    const first = hatchPetOnce(null)
    const second = hatchPetOnce(null)
    expect(second).toBe(first)
    await Promise.resolve()
    finish(hatched)
    await expect(first).resolves.toEqual({ status: "hatched", profile: hatched })
    expect(hatchMock).toHaveBeenCalledTimes(1)
    expect(emitMock).toHaveBeenCalledTimes(1)
  })

  it("releases the slot once a run settles so a later attempt runs again", async () => {
    getProfileMock.mockResolvedValue(egg)
    hatchMock.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(hatched)
    const failed = await hatchPetOnce(null)
    expect(failed.status).toBe("failed")
    expect(await hatchPetOnce(null)).toEqual({ status: "hatched", profile: hatched })
  })

  it("reports a failure as a value instead of throwing, and announces nothing", async () => {
    getProfileMock.mockResolvedValue(egg)
    const error = new Error("db closed")
    hatchMock.mockRejectedValue(error)
    expect(await hatchPetOnce(null)).toEqual({ status: "failed", error })
    expect(emitMock).not.toHaveBeenCalled()
  })

  it("skips the model call for a pet that already hatched elsewhere", async () => {
    getProfileMock.mockResolvedValue(hatched)
    expect(await hatchPetOnce(null)).toEqual({ status: "already-hatched", profile: hatched })
    expect(buildMock).not.toHaveBeenCalled()
    expect(hatchMock).not.toHaveBeenCalled()
    expect(emitMock).not.toHaveBeenCalled()
  })

  it("reports a missing profile", async () => {
    getProfileMock.mockResolvedValue(undefined)
    expect(await hatchPetOnce(null)).toEqual({ status: "no-profile" })
    expect(hatchMock).not.toHaveBeenCalled()
  })

  it("accepts injected dependencies", async () => {
    const emit = jest.fn()
    const outcome = await hatchPetOnce(null, {
      getProfile: async () => egg,
      buildClient: () => null,
      hatch: async () => hatched,
      emit,
    })
    expect(outcome.status).toBe("hatched")
    expect(emit).toHaveBeenCalledTimes(1)
    expect(buildMock).not.toHaveBeenCalled()
  })
})
