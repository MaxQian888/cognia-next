/** @jest-environment jsdom */
import "fake-indexeddb/auto"

const emitPetEvent = jest.fn()
jest.mock("@/lib/pet/events/pet-event-bus", () => ({
  emitPetEvent: (e: unknown) => emitPetEvent(e),
}))

// The live default path resolves the host through this module. Flipped per
// test; everything else in it stays real.
let mockPlatform: "tauri" | "web" | "mobile" = "web"
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  detectPlatform: () => mockPlatform,
  isTauri: () => mockPlatform === "tauri",
}))

import { getDb, __resetDbForTesting, whenSeeded } from "@/lib/db/schema"
import { upsertPetProfile } from "@/lib/db/pet"
import { createDefaultProfile } from "@/lib/pet/defaults"
import { dispatchPetSubcommand, parsePetArgs, type PetCommandDeps } from "./pet"
import type { PetAccessResult, PetInteractionKind } from "@/lib/pet/access/gate"
import type { PetProfile } from "@/types/pet"

/** A desktop main window with the pet on, and a recording gate. */
function desktop(result: PetAccessResult = { ok: true, grantedXp: 3, grantedCoins: 1 }) {
  const calls: PetInteractionKind[] = []
  const deps: PetCommandDeps = {
    availability: () => ({ available: true }),
    interact: async (kind) => {
      calls.push(kind)
      return result
    },
  }
  return { deps, calls }
}

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
  mockPlatform = "web"
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
    const result = await dispatchPetSubcommand("status", Date.now(), desktop().deps)
    expect(result.system).toContain("No pet yet")
  })

  it("points an unhatched egg at the console", async () => {
    await seedProfile({ soul: null, stage: "egg" })
    const result = await dispatchPetSubcommand("status", Date.now(), desktop().deps)
    expect(result.system).toContain("egg")
  })

  it("renders name, stage, level, needs, and condition", async () => {
    await seedProfile()
    const result = await dispatchPetSubcommand("status", 0, desktop().deps)
    expect(result.system).toContain("Boba")
    expect(result.system).toContain("baby")
    expect(result.system).toContain("**Level** 2")
    expect(result.system).toContain("energy")
    expect(result.system).toContain("well")
  })

  it("includes coins and streak lines only when present on the profile", async () => {
    await seedProfile()
    const withoutEconomy = await dispatchPetSubcommand("status", 0, desktop().deps)
    expect(withoutEconomy.system).not.toContain("Coins")
    expect(withoutEconomy.system).not.toContain("streak")

    await seedProfile({ coins: 42, streak: { days: 3, lastDay: "2026-07-01" } })
    const withEconomy = await dispatchPetSubcommand("status", 0, desktop().deps)
    expect(withEconomy.system).toContain("**Coins**: 42")
    expect(withEconomy.system).toContain("3 day(s)")
  })

  it.each([
    ["feed", "fed"],
    ["play", "played"],
    ["pet", "petted"],
    ["sleep", "slept"],
    ["clean", "cleaned"],
    ["treat", "treated"],
  ])("/pet %s drives a %s interaction through the gate and confirms", async (sub, kind) => {
    await seedProfile()
    const { deps, calls } = desktop()
    const result = await dispatchPetSubcommand(sub, Date.now(), deps)
    expect(calls).toEqual([kind])
    // The gate is the only door: nothing reaches the bus from here directly.
    expect(emitPetEvent).not.toHaveBeenCalled()
    expect(result.system.length).toBeGreaterThan(0)
  })

  it("refuses interactions while the pet is an egg", async () => {
    await seedProfile({ soul: null, stage: "egg" })
    const { deps, calls } = desktop()
    const result = await dispatchPetSubcommand("feed", Date.now(), deps)
    expect(calls).toEqual([])
    expect(result.system).toContain("hatch")
  })

  it("returns the usage error for garbage", async () => {
    const result = await dispatchPetSubcommand("dance")
    expect(result.system).toContain("Unknown subcommand")
    expect(emitPetEvent).not.toHaveBeenCalled()
  })

  it.each(["status", "feed"])(
    "says the pet lives in the desktop app on a host that cannot run it (%s)",
    async (sub) => {
      await seedProfile()
      const interact = jest.fn()
      const result = await dispatchPetSubcommand(sub, 0, {
        availability: () => ({ available: false, reason: "unsupported-host" }),
        interact,
      })
      expect(result.system).toContain("desktop app")
      expect(result.system).not.toContain("Boba")
      expect(interact).not.toHaveBeenCalled()
    }
  )

  it("points a secondary window at the main window", async () => {
    const result = await dispatchPetSubcommand("feed", 0, {
      availability: () => ({ available: false, reason: "secondary-window" }),
    })
    expect(result.system).toContain("main Cognia window")
  })

  it("shows a switched-off pet's record, with a note that nothing reacts", async () => {
    await seedProfile()
    const result = await dispatchPetSubcommand("status", 0, {
      availability: () => ({ available: false, reason: "disabled" }),
    })
    expect(result.system).toContain("Boba")
    expect(result.system).toContain("switched off")
  })

  it("refuses care for a switched-off pet instead of confirming into the void", async () => {
    await seedProfile()
    const interact = jest.fn()
    const result = await dispatchPetSubcommand("feed", 0, {
      availability: () => ({ available: false, reason: "disabled" }),
      interact,
    })
    expect(result.system).toContain("switched off")
    expect(result.system).not.toContain("Fed")
    expect(interact).not.toHaveBeenCalled()
  })

  it("reports the wait while the action is still cooling, without asking the gate", async () => {
    const now = 1_000_000
    await seedProfile({ interactionGate: { lastAtByKind: { fed: now - 500 } } })
    const { deps, calls } = desktop()
    const result = await dispatchPetSubcommand("feed", now, deps)
    expect(result.system).toContain("again in 1s")
    expect(calls).toEqual([])
  })

  it("lets a cooled-down action through", async () => {
    const now = 1_000_000
    await seedProfile({ interactionGate: { lastAtByKind: { fed: now - 60_000 } } })
    const { deps, calls } = desktop()
    await dispatchPetSubcommand("feed", now, deps)
    expect(calls).toEqual(["fed"])
  })

  it.each([
    [{ code: "rate-limited" }, "give it a moment"],
    [{ code: "kind-not-allowed", kind: "fed" }, "not a pet action"],
    [{ code: "item-not-owned", itemId: "berry" }, "berry"],
    [{ code: "unknown-item", itemId: "rock" }, "rock"],
    [{ code: "unavailable", reason: "disabled" }, "switched off"],
    [{ code: "unavailable", reason: "unsupported-host" }, "desktop app"],
  ] as const)("maps the gate refusal %j to an honest reply", async (refusal, text) => {
    await seedProfile()
    const { deps } = desktop({ ok: false, refusal })
    const result = await dispatchPetSubcommand("feed", Date.now(), deps)
    expect(result.system).toContain(text)
    expect(result.system).not.toContain("Fed your pet")
  })

  it("on the desktop, the live default path reaches the bus through the real gate", async () => {
    mockPlatform = "tauri"
    await seedProfile()
    const result = await dispatchPetSubcommand("feed")
    expect(emitPetEvent).toHaveBeenCalledWith({ source: "user", kind: "fed" })
    expect(result.system).toContain("Fed your pet")
  })

  it("on the web, the live default path refuses without touching the bus", async () => {
    await seedProfile()
    const result = await dispatchPetSubcommand("feed")
    expect(emitPetEvent).not.toHaveBeenCalled()
    expect(result.system).toContain("desktop app")
  })
})
