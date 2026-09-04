import type { PetProfile } from "@/types/pet"
import { makePetProfile } from "@/lib/storybook/fixtures/pet-core"
import {
  PET_TOOL_NAMES,
  buildPetManifestEntries,
  isPetBuiltinTool,
  runPetBuiltinTool,
  type PetToolDeps,
} from "./pet-builtin-tools"

const NOW = Date.UTC(2026, 5, 29, 9, 0)

let profile: PetProfile | undefined
let said: Array<{ text: string; opts: unknown }>
let interactions: Array<{ kind: string; opts: unknown }>
let overlayOpened: boolean
let consoleOpened: Array<string | undefined>

function deps(over: Partial<PetToolDeps> = {}): PetToolDeps {
  return {
    getProfile: async () => profile,
    summarize: (p) => ({ hatched: p.soul !== null, name: p.soul?.name ?? null, level: p.level }),
    interact: async (kind, opts) => {
      interactions.push({ kind, opts })
      return { ok: true, grantedXp: 3, grantedCoins: 2 }
    },
    reward: async () => ({ ok: true, grantedXp: 5, grantedCoins: 4 }),
    say: (text, opts) => {
      said.push({ text, opts })
      return { ok: true, text, clearsAt: NOW + 6000 }
    },
    openOverlay: async () => overlayOpened,
    openConsole: (tab) => {
      consoleOpened.push(tab)
      return true
    },
    listActivity: async () => [{ kind: "fed", ts: 1 }],
    listAchievements: async () => [{ id: "first-xp" }],
    listInventory: async () => [{ id: "berry", qty: 2 }],
    bubblesMuted: () => false,
    isAvailable: () => true,
    now: () => NOW,
    ...over,
  }
}

beforeEach(() => {
  profile = makePetProfile()
  said = []
  interactions = []
  overlayOpened = true
  consoleOpened = []
})

describe("the manifest", () => {
  it("ships exactly the five declared tools under one plugin id", () => {
    expect(buildPetManifestEntries().map((e) => e.name)).toEqual([...PET_TOOL_NAMES])
  })

  it("closes every schema so a typo is rejected rather than ignored", () => {
    for (const entry of buildPetManifestEntries()) {
      expect(entry.jsonSchema.additionalProperties).toBe(false)
      expect(entry.description.length).toBeGreaterThan(40)
    }
  })

  it("recognizes its own tools and nothing else", () => {
    expect(isPetBuiltinTool("pet_status")).toBe(true)
    expect(isPetBuiltinTool("artifact_create")).toBe(false)
  })
})

describe("pet_status", () => {
  it("reads the pet without any extra sections by default", async () => {
    const res = (await runPetBuiltinTool("pet_status", {}, deps())) as Record<string, unknown>
    expect(res.ok).toBe(true)
    expect(res.hatched).toBe(true)
    expect(res.activity).toBeUndefined()
  })

  it("fetches only the sections asked for", async () => {
    const res = (await runPetBuiltinTool(
      "pet_status",
      { include: ["activity", "inventory"] },
      deps()
    )) as Record<string, unknown>
    expect(res.activity).toHaveLength(1)
    expect(res.inventory).toHaveLength(1)
    expect(res.achievements).toBeUndefined()
  })

  it("reports an unhatched egg as a SUCCESS so the agent can say so", async () => {
    profile = makePetProfile({ soul: null, stage: "egg" })
    const res = (await runPetBuiltinTool("pet_status", {}, deps())) as Record<string, unknown>
    expect(res.ok).toBe(true)
    expect(res.hatched).toBe(false)
  })

  it("fails cleanly when the pet was never set up on this device", async () => {
    profile = undefined
    expect(await runPetBuiltinTool("pet_status", {}, deps())).toMatchObject({
      ok: false,
      code: "pet_uninitialized",
    })
  })
})

describe("pet_care", () => {
  it("maps the agent's verb onto the event kind and reads the pet back after", async () => {
    const res = (await runPetBuiltinTool("pet_care", { action: "feed" }, deps())) as Record<
      string,
      unknown
    >
    expect(interactions).toEqual([{ kind: "fed", opts: {} }])
    expect(res).toMatchObject({ ok: true, action: "feed", kind: "fed", grantedXp: 3 })
  })

  it("refuses an unknown action instead of guessing", async () => {
    expect(await runPetBuiltinTool("pet_care", { action: "scold" }, deps())).toMatchObject({
      ok: false,
      code: "invalid_arguments",
    })
    expect(interactions).toEqual([])
  })

  it("refuses to nurture an egg and points at hatching", async () => {
    profile = makePetProfile({ soul: null, stage: "egg" })
    const res = (await runPetBuiltinTool("pet_care", { action: "feed" }, deps())) as {
      code: string
      error: string
    }
    expect(res.code).toBe("pet_unhatched")
    expect(res.error).toMatch(/hatch/i)
    expect(interactions).toEqual([])
  })

  it("turns a cooldown refusal into a rate_limited result, never a throw", async () => {
    const res = await runPetBuiltinTool(
      "pet_care",
      { action: "feed" },
      deps({ interact: async () => ({ ok: false, refusal: { code: "rate-limited" } }) })
    )
    expect(res).toMatchObject({ ok: false, code: "rate_limited" })
  })

  it("surfaces an unowned item as item_not_owned", async () => {
    const res = await runPetBuiltinTool(
      "pet_care",
      { action: "feed", itemId: "berry" },
      deps({
        interact: async () => ({
          ok: false,
          refusal: { code: "item-not-owned", itemId: "berry" },
        }),
      })
    )
    expect(res).toMatchObject({ ok: false, code: "item_not_owned" })
  })

  it("says the pet is switched off rather than pretending it worked", async () => {
    const res = await runPetBuiltinTool(
      "pet_care",
      { action: "feed" },
      deps({
        interact: async () => ({
          ok: false,
          refusal: { code: "unavailable", reason: "disabled" },
        }),
      })
    )
    expect(res).toMatchObject({ ok: false, code: "pet_disabled" })
  })
})

describe("pet_say", () => {
  it("speaks in the pet's voice with an optional flourish", async () => {
    const res = await runPetBuiltinTool(
      "pet_say",
      { text: "nice commit!", emotion: "love" },
      deps()
    )
    expect(said).toEqual([
      { text: "nice commit!", opts: { emotion: "love", durationMs: undefined } },
    ])
    expect(res).toMatchObject({ ok: true, text: "nice commit!" })
  })

  it("drops an emotion outside the flourish vocabulary rather than failing", async () => {
    await runPetBuiltinTool("pet_say", { text: "hi", emotion: "smug" }, deps())
    expect(said[0].opts).toMatchObject({ emotion: undefined })
  })

  it("refuses text over the cap instead of truncating the agent's words", async () => {
    const res = await runPetBuiltinTool("pet_say", { text: "x".repeat(201) }, deps())
    expect(res).toMatchObject({ ok: false, code: "invalid_arguments" })
    expect(said).toEqual([])
  })

  it("reports a PII refusal distinctly, so the agent learns not to retry it", async () => {
    const res = await runPetBuiltinTool(
      "pet_say",
      { text: "your SSN" },
      deps({ say: () => ({ ok: false, reason: "pii" }) })
    )
    expect(res).toMatchObject({ ok: false, code: "pii_blocked" })
  })

  it("stays quiet when the user muted the pet's bubbles", async () => {
    const res = await runPetBuiltinTool(
      "pet_say",
      { text: "hello" },
      deps({ bubblesMuted: () => true })
    )
    expect(res).toMatchObject({ ok: false, code: "bubbles_muted" })
    expect(said).toEqual([])
  })

  it("gives an egg no voice", async () => {
    profile = makePetProfile({ soul: null })
    expect(await runPetBuiltinTool("pet_say", { text: "hi" }, deps())).toMatchObject({
      ok: false,
      code: "pet_unhatched",
    })
  })
})

describe("pet_reward", () => {
  it("grants a milestone reward", async () => {
    const res = await runPetBuiltinTool("pet_reward", { kind: "goalComplete", xp: 5 }, deps())
    expect(res).toMatchObject({ ok: true, kind: "goalComplete", grantedXp: 5, grantedCoins: 4 })
  })

  it("refuses a lifecycle kind the controller owns", async () => {
    expect(await runPetBuiltinTool("pet_reward", { kind: "levelUp" }, deps())).toMatchObject({
      ok: false,
      code: "invalid_arguments",
    })
  })

  it("reports an exhausted budget as a success that granted zero", async () => {
    const res = await runPetBuiltinTool(
      "pet_reward",
      { kind: "workflowRun", xp: 10 },
      deps({ reward: async () => ({ ok: true, grantedXp: 0, grantedCoins: 0 }) })
    )
    expect(res).toMatchObject({ ok: true, grantedXp: 0, grantedCoins: 0 })
  })
})

describe("pet_show", () => {
  it("opens the console on a named tab by default", async () => {
    const res = await runPetBuiltinTool("pet_show", { tab: "shop" }, deps())
    expect(consoleOpened).toEqual(["shop"])
    expect(res).toMatchObject({ ok: true, target: "console", tab: "shop" })
  })

  it("ignores a tab that is not a real console tab", async () => {
    await runPetBuiltinTool("pet_show", { tab: "not-a-tab" }, deps())
    expect(consoleOpened).toEqual([undefined])
  })

  it("raises the overlay when asked", async () => {
    const res = await runPetBuiltinTool("pet_show", { target: "overlay" }, deps())
    expect(res).toMatchObject({ ok: true, target: "overlay", opened: true })
  })

  it("refuses when the pet is switched off, instead of reporting a window it never opened", async () => {
    // Nothing subscribes to the console request with the pet off, and the
    // overlay branch would recreate the exact window the master switch
    // destroys. It used to return `opened: true` either way.
    const res = await runPetBuiltinTool(
      "pet_show",
      { target: "console" },
      deps({ isAvailable: () => false })
    )
    expect(res).toMatchObject({ ok: false, code: "pet_disabled" })
    expect(consoleOpened).toEqual([])
  })

  it("explains that the floating pet needs the desktop app", async () => {
    overlayOpened = false
    expect(await runPetBuiltinTool("pet_show", { target: "overlay" }, deps())).toMatchObject({
      ok: false,
      code: "overlay_unavailable",
    })
  })
})

describe("the failure envelope", () => {
  it("never throws, even when a dependency does", async () => {
    const res = await runPetBuiltinTool(
      "pet_status",
      {},
      deps({
        getProfile: async () => {
          throw new Error("dexie exploded")
        },
      })
    )
    expect(res).toMatchObject({ ok: false, error: "dexie exploded" })
  })

  it("rejects a name it does not own", async () => {
    expect(await runPetBuiltinTool("pet_teleport", {}, deps())).toMatchObject({
      ok: false,
      code: "invalid_arguments",
    })
  })
})
