import "fake-indexeddb/auto"

const emitPetEvent = jest.fn()
jest.mock("@/lib/pet/events/pet-event-bus", () => ({
  emitPetEvent: (e: unknown) => emitPetEvent(e),
}))

import { getDb, __resetDbForTesting, whenSeeded } from "@/lib/db/schema"
import { upsertPetProfile } from "@/lib/db/pet"
import { createDefaultProfile } from "@/lib/pet/defaults"
import { dispatchPetSubcommand, parsePetArgs } from "./pet"
import type { PetProfile } from "@/types/pet"

async function seedProfile(patch: Partial<PetProfile> = {}) {
  const profile: PetProfile = {
    ...createDefaultProfile("acct-1", 0),
    soul: { name: "Boba", personality: "curious", hatchDate: "2026-01-01" },
    stage: "baby",
    xp: 150,
    level: 2,
    ...patch,
  }
  await upsertPetProfile(profile)
  return profile
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  await whenSeeded()
  emitPetEvent.mockClear()
})

describe("parsePetArgs", () => {
  it.each([
    ["", "status"],
    ["   ", "status"],
    ["status", "status"],
    ["STATUS extra", "status"],
    ["feed", "feed"],
    ["play", "play"],
    ["pet", "pet"],
    ["sleep", "sleep"],
    ["clean", "clean"],
    ["treat", "treat"],
  ])("parses %j → %s", (args, sub) => {
    expect(parsePetArgs(args)).toEqual({ sub })
  })

  it("rejects unknown subcommands with a usage line", () => {
    const parsed = parsePetArgs("dance")
    expect(parsed).toHaveProperty("error")
    expect((parsed as { error: string }).error).toContain("/pet <status")
  })
})

describe("dispatchPetSubcommand", () => {
  it("explains when no profile exists", async () => {
    const result = await dispatchPetSubcommand("status")
    expect(result.system).toContain("No pet yet")
  })

  it("points an unhatched egg at the console", async () => {
    await seedProfile({ soul: null, stage: "egg" })
    const result = await dispatchPetSubcommand("status")
    expect(result.system).toContain("egg")
  })

  it("renders name, stage, level, needs, and condition", async () => {
    await seedProfile()
    const result = await dispatchPetSubcommand("status", 0)
    expect(result.system).toContain("Boba")
    expect(result.system).toContain("baby")
    expect(result.system).toContain("**Level** 2")
    expect(result.system).toContain("energy")
    expect(result.system).toContain("well")
  })

  it.each([
    ["feed", "fed"],
    ["play", "played"],
    ["pet", "petted"],
    ["sleep", "slept"],
    ["clean", "cleaned"],
    ["treat", "treated"],
  ])("/pet %s emits a user %s event and confirms", async (sub, kind) => {
    await seedProfile()
    const result = await dispatchPetSubcommand(sub)
    expect(emitPetEvent).toHaveBeenCalledWith({ source: "user", kind })
    expect(result.system.length).toBeGreaterThan(0)
  })

  it("refuses interactions while the pet is an egg", async () => {
    await seedProfile({ soul: null, stage: "egg" })
    const result = await dispatchPetSubcommand("feed")
    expect(emitPetEvent).not.toHaveBeenCalled()
    expect(result.system).toContain("hatch")
  })

  it("returns the usage error for garbage", async () => {
    const result = await dispatchPetSubcommand("dance")
    expect(result.system).toContain("Unknown subcommand")
    expect(emitPetEvent).not.toHaveBeenCalled()
  })
})
