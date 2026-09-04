/** @jest-environment jsdom */
/**
 * Tests for the Pet Plugin API (`ctx.pet`).
 *
 * Covers the capability no-op gate, permission gating (pet:read /
 * pet:interact), the PII-safe summary projection, the emittable-kind
 * whitelist + per-call/daily clamps, event sanitization, and rate limits.
 *
 * `interact` and `emitEvent` spend ONE daily budget: the cases below pin that
 * a nurture debits the ledger, and that a drained budget makes it a no-op
 * REWARD (needs still settle) rather than a no-op interaction or an error.
 */

import {
  createPetAPI,
  MAX_XP_PER_EMIT,
  PetEventKindNotAllowedError,
  PLUGIN_EMITTABLE_PET_EVENT_KINDS,
} from "./pet-api"
import {
  __resetPetBudgetForTesting,
  consumePetBudget,
  PET_DAILY_COIN_BUDGET,
  PET_DAILY_XP_BUDGET,
} from "./pet-budget"
import { applyPetEvent } from "@/lib/pet/runtime/apply-event"
import { COIN_AWARD } from "@/lib/pet/economy/coin-table"
import { XP_AWARD } from "@/lib/pet/xp/award-table"
import { getPermissionGuard, resetPermissionGuard } from "@/lib/plugin/security"
import { PermissionError } from "@/lib/plugin/security/permission-guard"
import { getPluginRateLimiter, RateLimitError } from "@/lib/plugin/security/rate-limiter"
import type { PetEvent, PetProfile } from "@/types/pet"

// --- mock the Dexie data layer ------------------------------------------
let profileValue: PetProfile | undefined
jest.mock("@/lib/db/pet", () => ({
  getPetProfile: async () => profileValue,
}))

// --- mock the event bus ---------------------------------------------------
const emitPetEvent = jest.fn()
type Subscriber = (event: PetEvent) => void
const subscribers = new Set<Subscriber>()
jest.mock("@/lib/pet/events/pet-event-bus", () => ({
  emitPetEvent: (e: unknown) => emitPetEvent(e),
  getPetEventBus: () => ({
    subscribe: (cb: Subscriber) => {
      subscribers.add(cb)
      return () => subscribers.delete(cb)
    },
  }),
}))

function deliver(event: PetEvent) {
  for (const cb of subscribers) cb(event)
}

import { createDefaultProfile } from "@/lib/pet/defaults"

const PLUGIN = "pet-plugin"

function makeProfile(patch: Partial<PetProfile> = {}): PetProfile {
  return {
    ...createDefaultProfile("acct-1", 0),
    soul: { name: "Boba", personality: "x", hatchDate: "" },
    stage: "baby",
    xp: 150,
    level: 2,
    coins: 12,
    ...patch,
  }
}

function grantedApi() {
  getPermissionGuard().registerPlugin(PLUGIN, ["pet:read", "pet:interact"])
  return createPetAPI({ pluginId: PLUGIN, capabilities: ["pet"] })
}

beforeEach(() => {
  jest.clearAllMocks()
  subscribers.clear()
  resetPermissionGuard()
  __resetPetBudgetForTesting()
  // The budget ledger writes through the real (jsdom) localStorage.
  localStorage.clear()
  getPluginRateLimiter().reset(PLUGIN)
  profileValue = makeProfile()
})

describe("capability gate", () => {
  it("is a warn-once no-op without the 'pet' capability", async () => {
    getPermissionGuard().registerPlugin(PLUGIN, ["pet:read", "pet:interact"])
    const api = createPetAPI({ pluginId: PLUGIN, capabilities: [] })
    expect(await api.getView()).toBeNull()
    expect(api.getRemainingBudget()).toEqual({ xp: 0, coins: 0 })
    await api.interact("fed")
    expect(await api.emitEvent("fed", { xp: 5 })).toEqual({ grantedXp: 0, grantedCoins: 0 })
    expect(emitPetEvent).not.toHaveBeenCalled()
    const dispose = api.onEvent(() => {})
    expect(subscribers.size).toBe(0)
    dispose()
  })
})

describe("permission gating", () => {
  it("fails closed without pet:read on reads", () => {
    getPermissionGuard().registerPlugin(PLUGIN, ["pet:interact"])
    const api = createPetAPI({ pluginId: PLUGIN, capabilities: ["pet"] })
    // The guard's fast path throws synchronously (no confirm tier involved).
    expect(() => api.getView()).toThrow(PermissionError)
    expect(() => api.getRemainingBudget()).toThrow(PermissionError)
  })

  it("fails closed without pet:interact on interactions", () => {
    getPermissionGuard().registerPlugin(PLUGIN, ["pet:read"])
    const api = createPetAPI({ pluginId: PLUGIN, capabilities: ["pet"] })
    expect(() => api.interact("fed")).toThrow(PermissionError)
    expect(() => api.emitEvent("fed")).toThrow(PermissionError)
    expect(emitPetEvent).not.toHaveBeenCalled()
  })
})

describe("getView / getSummary", () => {
  it("projects a PII-safe summary (no fingerprint/bones/soul internals)", async () => {
    const api = grantedApi()
    const view = await api.getView()
    expect(view).toMatchObject({
      hatched: true,
      name: "Boba",
      level: 2,
      stage: "baby",
      xp: 150,
      coins: 12,
    })
    expect(Object.keys(view!).sort()).toEqual(
      ["coins", "condition", "hatched", "level", "mood", "name", "needs", "stage", "xp"].sort()
    )
    expect(JSON.stringify(view)).not.toContain("acct-1")
  })

  it("returns null before the profile exists and 0 coins for legacy rows", async () => {
    const api = grantedApi()
    profileValue = undefined
    expect(await api.getView()).toBeNull()
    profileValue = makeProfile({ coins: undefined })
    expect((await api.getSummary())?.coins).toBe(0)
  })
})

describe("interact", () => {
  it("emits a plugin-sourced interaction with the plugin id and explicit rewards", async () => {
    const api = grantedApi()
    await api.interact("played")
    expect(emitPetEvent).toHaveBeenCalledWith({
      source: "plugin",
      kind: "played",
      xp: XP_AWARD.played,
      meta: { pluginId: PLUGIN, coins: COIN_AWARD.played },
    })
    await api.interact("fed", { itemId: "berry" })
    expect(emitPetEvent).toHaveBeenCalledWith({
      source: "plugin",
      kind: "fed",
      xp: XP_AWARD.fed,
      meta: { pluginId: PLUGIN, itemId: "berry", coins: COIN_AWARD.fed },
    })
  })

  it("spends the same daily ledger as emitEvent", async () => {
    const api = grantedApi()
    expect(api.getRemainingBudget()).toEqual({
      xp: PET_DAILY_XP_BUDGET,
      coins: PET_DAILY_COIN_BUDGET,
    })
    const granted = await api.interact("played")
    expect(granted).toEqual({ grantedXp: XP_AWARD.played, grantedCoins: COIN_AWARD.played })
    // The regression pin: this used to stay at a full 50/100 forever, because
    // interact never called consumePetBudget and fell through to the tables.
    expect(api.getRemainingBudget()).toEqual({
      xp: PET_DAILY_XP_BUDGET - XP_AWARD.played!,
      coins: PET_DAILY_COIN_BUDGET - COIN_AWARD.played!,
    })
    // An emitEvent reward draws down the very same remainder.
    await api.emitEvent("workflowRun", { xp: 5, coins: 5 })
    expect(api.getRemainingBudget()).toEqual({
      xp: PET_DAILY_XP_BUDGET - XP_AWARD.played! - 5,
      coins: PET_DAILY_COIN_BUDGET - COIN_AWARD.played! - 5,
    })
  })

  it("grants nothing once the daily budget is drained, without throwing", async () => {
    const api = grantedApi()
    // Drain the ledger directly: the pet:interact bucket caps at 10 calls, so
    // draining 50 XP through interact() would hit the rate limit first and
    // test the wrong thing.
    consumePetBudget(PLUGIN, { xp: PET_DAILY_XP_BUDGET, coins: PET_DAILY_COIN_BUDGET })
    expect(api.getRemainingBudget()).toEqual({ xp: 0, coins: 0 })

    await expect(api.interact("played")).resolves.toEqual({ grantedXp: 0, grantedCoins: 0 })
    // Still emitted — with explicit 0s, so it cannot fall through to the
    // host award tables (played would otherwise be worth 4 XP / 3 coins).
    expect(emitPetEvent).toHaveBeenCalledWith({
      source: "plugin",
      kind: "played",
      xp: 0,
      meta: { pluginId: PLUGIN, coins: 0 },
    })
  })

  it("still settles needs at zero budget (a no-op reward, not a no-op nurture)", async () => {
    const api = grantedApi()
    consumePetBudget(PLUGIN, { xp: PET_DAILY_XP_BUDGET, coins: PET_DAILY_COIN_BUDGET })
    await api.interact("fed")
    const emitted = emitPetEvent.mock.calls.at(-1)![0] as Omit<PetEvent, "at">

    // Run the event the drained API actually produced through the REAL
    // progression step. `lastTickAt === now` so decay contributes nothing and
    // the only movement is the `fed` restore (energy +25, mood +4).
    const now = Date.UTC(2026, 0, 2, 12, 0, 0)
    const profile = makeProfile({
      needs: { energy: 50, mood: 40, bond: 10, lastTickAt: new Date(now).toISOString() },
    })
    const result = applyPetEvent(profile, { ...emitted, at: now }, now)

    expect(result.profile.needs.energy).toBe(75)
    expect(result.profile.needs.mood).toBe(44)
    // ...and the reward really is zero: no XP, no coins, no level-up dividend.
    expect(result.profile.xp).toBe(profile.xp)
    expect(result.coinsEarned).toBe(0)
    expect(result.profile.coins).toBe(profile.coins)
    expect(result.oneShots).toContain("fed")
  })

  it("rejects non-interaction kinds", async () => {
    const api = grantedApi()
    await expect(api.interact("levelUp" as never)).rejects.toThrow(PetEventKindNotAllowedError)
  })

  it("rate-limits repeated interactions", async () => {
    const api = grantedApi()
    // Bucket capacity is 10; the 11th call in a burst throws.
    for (let i = 0; i < 10; i++) await api.interact("petted")
    await expect(api.interact("petted")).rejects.toThrow(RateLimitError)
  })
})

describe("emitEvent", () => {
  it("rejects lifecycle kinds", async () => {
    const api = grantedApi()
    for (const kind of ["hatched", "levelUp", "evolved", "achievementUnlocked", "unwell"]) {
      await expect(api.emitEvent(kind as never)).rejects.toThrow(PetEventKindNotAllowedError)
    }
    expect(PLUGIN_EMITTABLE_PET_EVENT_KINDS).not.toContain("levelUp")
  })

  it("clamps XP per call and rides explicit overrides on the event", async () => {
    const api = grantedApi()
    const granted = await api.emitEvent("workflowRun", { xp: 999, coins: 3 })
    expect(granted).toEqual({ grantedXp: MAX_XP_PER_EMIT, grantedCoins: 3 })
    expect(emitPetEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "plugin",
        kind: "workflowRun",
        xp: MAX_XP_PER_EMIT,
        meta: expect.objectContaining({ pluginId: PLUGIN, coins: 3 }),
      })
    )
  })

  it("clamps against the daily budget across calls", async () => {
    const api = grantedApi()
    let total = 0
    // Drain the 50-XP budget in 10-XP bites; keep under the rate cap of 20.
    for (let i = 0; i < 6; i++) {
      total += (await api.emitEvent("fed", { xp: 10 })).grantedXp
    }
    expect(total).toBe(PET_DAILY_XP_BUDGET)
  })

  it("always sets explicit xp/coins so host award tables can't be farmed", async () => {
    const api = grantedApi()
    await api.emitEvent("fed") // no reward requested
    expect(emitPetEvent).toHaveBeenCalledWith(
      expect.objectContaining({ xp: 0, meta: expect.objectContaining({ coins: 0 }) })
    )
  })

  it("strips free-form meta down to the id-shaped whitelist", async () => {
    const api = grantedApi()
    await api.emitEvent("fed", {
      meta: { itemId: "berry", userText: "secret words", nested: { x: 1 } },
    })
    const emitted = emitPetEvent.mock.calls.at(-1)![0] as PetEvent
    expect(emitted.meta).toEqual({ itemId: "berry", pluginId: PLUGIN, coins: 0 })
  })
})

describe("onEvent", () => {
  it("forwards sanitized events and strips userText", () => {
    const api = grantedApi()
    const seen: unknown[] = []
    const dispose = api.onEvent((e) => seen.push(e))
    deliver({
      source: "user",
      kind: "talked",
      xp: 2,
      meta: { userText: "my private message", goalId: "g1" },
      at: 111,
    })
    expect(seen).toEqual([
      { source: "user", kind: "talked", xp: 2, meta: { goalId: "g1" }, at: 111 },
    ])
    dispose()
    deliver({ source: "user", kind: "fed", at: 222 })
    expect(seen).toHaveLength(1)
  })

  it("swallows subscriber errors", () => {
    const api = grantedApi()
    api.onEvent(() => {
      throw new Error("subscriber boom")
    })
    expect(() => deliver({ source: "user", kind: "fed", at: 1 })).not.toThrow()
  })
})
