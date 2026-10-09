import type { PetEvent, PetProfile } from "@/types/pet"
import {
  checkInteractionAccepted,
  MAX_COINS_PER_REWARD,
  MAX_XP_PER_REWARD,
  petSubjectKey,
  remainingPetAllowance,
  requestPetInteraction,
  requestPetReward,
  type PetAccessDeps,
} from "./gate"
import {
  PET_DAILY_COIN_BUDGET,
  PET_DAILY_XP_BUDGET,
  __resetPetBudgetForTesting,
} from "./reward-budget"
import { XP_AWARD } from "@/lib/pet/xp/award-table"
import { COIN_AWARD } from "@/lib/pet/economy/coin-table"

let emitted: Array<Omit<PetEvent, "at">>

const NOW = 1_800_000_000_000

/** A hatched pet with nothing cooling down. */
function hatched(lastAtByKind: Record<string, number> = {}): PetProfile {
  return {
    soul: { name: "Boba", personality: "x", hatchDate: "" },
    interactionGate: { lastAtByKind },
  } as unknown as PetProfile
}

function deps(over: Partial<PetAccessDeps> = {}): PetAccessDeps {
  return {
    isEnabled: () => true,
    role: "main",
    platform: "tauri",
    rateLimiter: { check: () => {} },
    emit: ((e: Omit<PetEvent, "at">) => {
      emitted.push(e)
    }) as PetAccessDeps["emit"],
    decrementInventory: async () => true,
    getProfile: async () => hatched(),
    now: () => NOW,
    ...over,
  }
}

beforeEach(() => {
  emitted = []
  __resetPetBudgetForTesting()
})

describe("availability", () => {
  it("refuses every subject when the pet is switched off", async () => {
    const res = await requestPetInteraction(
      { kind: "user" },
      "fed",
      {},
      deps({ isEnabled: () => false })
    )
    expect(res).toEqual({ ok: false, refusal: { code: "unavailable", reason: "disabled" } })
    expect(emitted).toEqual([])
  })

  it("refuses in a secondary window, the path that used to double-award", async () => {
    const res = await requestPetInteraction({ kind: "user" }, "fed", {}, deps({ role: "overlay" }))
    expect(res).toEqual({
      ok: false,
      refusal: { code: "unavailable", reason: "secondary-window" },
    })
    expect(emitted).toEqual([])
  })
})

describe("kind whitelist", () => {
  it("refuses a kind that is not a nurture", async () => {
    const res = await requestPetInteraction({ kind: "plugin", id: "p1" }, "levelUp", {}, deps())
    expect(res).toEqual({ ok: false, refusal: { code: "kind-not-allowed", kind: "levelUp" } })
    expect(emitted).toEqual([])
  })

  it("refuses a lifecycle kind as a reward", async () => {
    const res = await requestPetReward({ kind: "plugin", id: "p1" }, "evolved", {}, deps())
    expect(res).toEqual({ ok: false, refusal: { code: "kind-not-allowed", kind: "evolved" } })
  })
})

describe("burst limit", () => {
  it("turns a limiter throw into a refusal rather than an exception", async () => {
    const res = await requestPetInteraction(
      { kind: "agent" },
      "fed",
      {},
      deps({
        rateLimiter: {
          check: () => {
            throw new Error("rate limited")
          },
        },
      })
    )
    expect(res.ok).toBe(false)
    // The limiter's own error rides along so a caller with a throwing contract
    // can rethrow it unchanged rather than inventing a new error type.
    expect(res).toMatchObject({ refusal: { code: "rate-limited" } })
    expect((res as { refusal: { cause?: unknown } }).refusal.cause).toBeInstanceOf(Error)
    expect(emitted).toEqual([])
  })
})

describe("user subject", () => {
  it("emits the exact event the command registry emitted before the gate existed", async () => {
    const res = await requestPetInteraction({ kind: "user" }, "fed", {}, deps())
    // No explicit xp/coins overrides: the host award tables still apply, so
    // the tray and hotkey paths keep their existing behavior byte for byte.
    expect(emitted).toEqual([{ source: "user", kind: "fed" }])
    expect(res).toEqual({
      ok: true,
      grantedXp: XP_AWARD.fed,
      grantedCoins: COIN_AWARD.fed,
    })
  })

  it("does not spend the daily ledger", async () => {
    await requestPetInteraction({ kind: "user" }, "fed", {}, deps())
    expect(remainingPetAllowance({ kind: "user" })).toEqual({
      xp: Number.POSITIVE_INFINITY,
      coins: Number.POSITIVE_INFINITY,
    })
  })
})

describe("plugin and agent subjects", () => {
  it("rides granted amounts as explicit overrides so a drained budget cannot fall through", async () => {
    const res = await requestPetInteraction({ kind: "plugin", id: "p1" }, "played", {}, deps())
    expect(res).toEqual({ ok: true, grantedXp: XP_AWARD.played, grantedCoins: COIN_AWARD.played })
    expect(emitted).toEqual([
      {
        source: "plugin",
        kind: "played",
        xp: XP_AWARD.played,
        meta: { pluginId: "p1", coins: COIN_AWARD.played },
      },
    ])
  })

  it("keys the agent ledger by one identity, not per session", () => {
    expect(petSubjectKey({ kind: "agent" })).toBe("agent")
    expect(petSubjectKey({ kind: "agent", id: "session-123" })).toBe("agent")
    expect(petSubjectKey({ kind: "plugin", id: "p1" })).toBe("p1")
  })

  it("never lets a plugin id land on another subject's ledger", () => {
    // "agent" and "user" are valid plugin ids; bare, they shared the agent's
    // daily ledger and burst bucket.
    expect(petSubjectKey({ kind: "plugin", id: "agent" })).toBe("plugin:agent")
    expect(petSubjectKey({ kind: "plugin", id: "user" })).toBe("plugin:user")
    expect(petSubjectKey({ kind: "plugin", id: "plugin" })).toBe("plugin:plugin")
  })

  it("drains to a successful zero grant rather than refusing", async () => {
    const subject = { kind: "agent" } as const
    for (let i = 0; i < 200; i += 1) {
      await requestPetInteraction(subject, "fed", {}, deps())
    }
    expect(remainingPetAllowance(subject)).toEqual({ xp: 0, coins: 0 })
    const last = await requestPetInteraction(subject, "fed", {}, deps())
    expect(last).toEqual({ ok: true, grantedXp: 0, grantedCoins: 0 })
    // Still a nurture: needs settle and the flourish plays, it just pays nothing.
    expect(emitted.at(-1)).toEqual({
      source: "system",
      kind: "fed",
      xp: 0,
      meta: { coins: 0 },
    })
  })
})

describe("item spending", () => {
  it("refuses an item the subject does not own instead of granting a free upgrade", async () => {
    const res = await requestPetInteraction(
      { kind: "plugin", id: "p1" },
      "fed",
      { itemId: "berry" },
      deps({ decrementInventory: async () => false })
    )
    expect(res).toEqual({ ok: false, refusal: { code: "item-not-owned", itemId: "berry" } })
    expect(emitted).toEqual([])
  })

  it("refuses an unknown item id", async () => {
    const res = await requestPetInteraction(
      { kind: "plugin", id: "p1" },
      "fed",
      { itemId: "not-a-real-item" },
      deps()
    )
    expect(res).toEqual({
      ok: false,
      refusal: { code: "unknown-item", itemId: "not-a-real-item" },
    })
    expect(emitted).toEqual([])
  })

  it("refuses an item used for an interaction it is not for, without spending it", async () => {
    const decrements: string[] = []
    const res = await requestPetInteraction(
      { kind: "plugin", id: "p1" },
      "petted",
      { itemId: "berry" },
      deps({
        decrementInventory: async (id) => {
          decrements.push(id)
          return true
        },
      })
    )
    expect(res).toEqual({
      ok: false,
      refusal: { code: "item-kind-mismatch", itemId: "berry", kind: "petted", itemKind: "fed" },
    })
    expect(decrements).toEqual([])
    expect(emitted).toEqual([])
  })

  it("decrements the owned item exactly once and forwards the id", async () => {
    const decrements: string[] = []
    const res = await requestPetInteraction(
      { kind: "plugin", id: "p1" },
      "fed",
      { itemId: "berry" },
      deps({
        decrementInventory: async (id) => {
          decrements.push(id)
          return true
        },
      })
    )
    expect(res.ok).toBe(true)
    expect(decrements).toEqual(["berry"])
    expect(emitted.at(-1)?.meta).toMatchObject({ itemId: "berry", pluginId: "p1" })
  })
})

describe("rewards", () => {
  it("clamps a greedy request to the per-call ceiling", async () => {
    const res = await requestPetReward(
      { kind: "plugin", id: "p1" },
      "workflowRun",
      { xp: 9999, coins: 5 },
      deps()
    )
    expect(res).toEqual({ ok: true, grantedXp: MAX_XP_PER_REWARD, grantedCoins: 5 })
  })

  it("clamps coins per call too, so one call cannot take the whole day", async () => {
    const res = await requestPetReward(
      { kind: "plugin", id: "p1" },
      "pluginReward",
      { xp: 1, coins: 100 },
      deps()
    )
    expect(res).toEqual({ ok: true, grantedXp: 1, grantedCoins: MAX_COINS_PER_REWARD })
    expect(remainingPetAllowance({ kind: "plugin", id: "p1" }).coins).toBe(
      PET_DAILY_COIN_BUDGET - MAX_COINS_PER_REWARD
    )
  })

  it("accepts the neutral pluginReward kind", async () => {
    const res = await requestPetReward(
      { kind: "plugin", id: "p1" },
      "pluginReward",
      { xp: 5, coins: 5 },
      deps()
    )
    expect(res).toEqual({ ok: true, grantedXp: 5, grantedCoins: 5 })
    expect(emitted.at(-1)).toMatchObject({ source: "plugin", kind: "pluginReward", xp: 5 })
  })

  it("never carries an item on a reward (no unowned upgrade through emitEvent)", async () => {
    await requestPetReward(
      { kind: "plugin", id: "p1" },
      "fed",
      { meta: { itemId: "royal-feast" } },
      deps()
    )
    expect(emitted.at(-1)?.meta).not.toHaveProperty("itemId")
  })

  it("limits a care-kind reward by the interaction bucket, not the reward bucket", async () => {
    const ops: string[] = []
    const rateLimiter = { check: (_key: string, op: string) => void ops.push(op) }
    await requestPetReward({ kind: "plugin", id: "p1" }, "fed", {}, deps({ rateLimiter }))
    await requestPetReward({ kind: "plugin", id: "p1" }, "pluginReward", {}, deps({ rateLimiter }))
    expect(ops).toEqual(["pet:interact", "pet:emit"])
  })

  it("starts from the full daily allowance", () => {
    expect(remainingPetAllowance({ kind: "plugin", id: "fresh" })).toEqual({
      xp: PET_DAILY_XP_BUDGET,
      coins: PET_DAILY_COIN_BUDGET,
    })
  })
})

describe("the user exemption is consistent across both entry points", () => {
  it("does not spend the ledger on a reward either, matching what it reports", () => {
    // `remainingPetAllowance` reports an unbounded allowance for a user, so
    // spending one here would make the two halves of the API disagree.
    const subject = { kind: "user" } as const
    expect(remainingPetAllowance(subject).xp).toBe(Number.POSITIVE_INFINITY)
  })

  it("grants the user the full clamped ask without touching the ledger", async () => {
    const res = await requestPetReward({ kind: "user" }, "workflowRun", { xp: 4, coins: 3 }, deps())
    expect(res).toEqual({ ok: true, grantedXp: 4, grantedCoins: 3 })
    expect(remainingPetAllowance({ kind: "user" })).toEqual({
      xp: Number.POSITIVE_INFINITY,
      coins: Number.POSITIVE_INFINITY,
    })
  })

  it("still clamps the user to the per-call ceiling", async () => {
    const res = await requestPetReward({ kind: "user" }, "workflowRun", { xp: 9999 }, deps())
    expect(res).toMatchObject({ grantedXp: MAX_XP_PER_REWARD })
  })
})

describe("event meta is sanitized by whatever emits it", () => {
  it("strips free-form text before it reaches the bus", async () => {
    // The sanitizer used to sit in `pet-api.ts` right before its own emit.
    // When the emit moved in here it was left behind at one caller, leaving
    // the gate's `meta` parameter an unfiltered path onto the bus for the
    // callers that arrived after.
    await requestPetReward(
      { kind: "agent" },
      "workflowRun",
      { meta: { itemId: "berry", userText: "secret words", nested: { x: 1 } } },
      deps()
    )
    // A reward carries no item (see "never carries an item on a reward").
    expect(emitted.at(-1)?.meta).toEqual({ coins: 0 })
  })

  it("keeps the id-shaped keys it is meant to carry", async () => {
    await requestPetReward(
      { kind: "plugin", id: "p1" },
      "workflowRun",
      { meta: { goalId: "g1", level: 4, stage: "adult" } },
      deps()
    )
    expect(emitted.at(-1)?.meta).toMatchObject({
      goalId: "g1",
      level: 4,
      stage: "adult",
      pluginId: "p1",
    })
  })
})

describe("the controller's own state is consulted before anything is spent", () => {
  it("refuses a cooling action for a plugin, spending neither ledger nor item", async () => {
    const decrements: string[] = []
    const res = await requestPetInteraction(
      { kind: "plugin", id: "p1" },
      "fed",
      { itemId: "berry" },
      deps({
        // Fed 500ms ago; `fed` cools for 1500ms.
        getProfile: async () => hatched({ fed: NOW - 500 }),
        decrementInventory: async (id) => {
          decrements.push(id)
          return true
        },
      })
    )
    expect(res).toEqual({
      ok: false,
      refusal: { code: "cooling-down", kind: "fed", retryAfterMs: 1000 },
    })
    expect(decrements).toEqual([])
    expect(emitted).toEqual([])
    expect(remainingPetAllowance({ kind: "plugin", id: "p1" })).toEqual({
      xp: PET_DAILY_XP_BUDGET,
      coins: PET_DAILY_COIN_BUDGET,
    })
  })

  it("refuses a cooling care-kind reward the same way", async () => {
    const res = await requestPetReward(
      { kind: "agent" },
      "treated",
      { xp: 5, coins: 5 },
      deps({ getProfile: async () => hatched({ treated: NOW - 1000 }) })
    )
    expect(res).toEqual({
      ok: false,
      refusal: { code: "cooling-down", kind: "treated", retryAfterMs: 9000 },
    })
    expect(remainingPetAllowance({ kind: "agent" }).coins).toBe(PET_DAILY_COIN_BUDGET)
  })

  it("lets an ambient reward kind through regardless of cooldowns", async () => {
    const res = await requestPetReward(
      { kind: "plugin", id: "p1" },
      "pluginReward",
      { xp: 2 },
      deps({ getProfile: async () => null })
    )
    expect(res.ok).toBe(true)
  })

  it("refuses nurturing an egg", async () => {
    const res = await requestPetInteraction(
      { kind: "plugin", id: "p1" },
      "played",
      {},
      deps({ getProfile: async () => ({ soul: null }) as unknown as PetProfile })
    )
    expect(res).toEqual({ ok: false, refusal: { code: "not-hatched" } })
  })

  it("refuses before a profile exists", async () => {
    const res = await requestPetInteraction(
      { kind: "agent" },
      "played",
      {},
      deps({ getProfile: async () => undefined })
    )
    expect(res).toEqual({ ok: false, refusal: { code: "uninitialized" } })
  })

  it("leaves the user path to the controller (its cooldown bubble answers)", async () => {
    const getProfile = jest.fn(async () => hatched({ fed: NOW - 100 }))
    const res = await requestPetInteraction({ kind: "user" }, "fed", {}, deps({ getProfile }))
    expect(res.ok).toBe(true)
    expect(getProfile).not.toHaveBeenCalled()
  })

  it("accepts once the cooldown has elapsed", async () => {
    const res = await requestPetInteraction(
      { kind: "plugin", id: "p1" },
      "fed",
      {},
      deps({ getProfile: async () => hatched({ fed: NOW - 1500 }) })
    )
    expect(res.ok).toBe(true)
  })
})

describe("checkInteractionAccepted (the subject-free precheck)", () => {
  const at = (profile: PetProfile | undefined | null) => ({
    getProfile: async () => profile,
    now: () => NOW,
  })

  it("reports the remaining cooldown for a cooling kind", async () => {
    expect(await checkInteractionAccepted("fed", at(hatched({ fed: NOW - 500 })))).toEqual({
      code: "cooling-down",
      kind: "fed",
      retryAfterMs: 1000,
    })
  })

  it("accepts a kind whose cooldown has elapsed", async () => {
    expect(await checkInteractionAccepted("fed", at(hatched({ fed: NOW - 1500 })))).toBeNull()
  })

  it("passes ambient kinds without reading the profile", async () => {
    const getProfile = jest.fn(async () => undefined)
    expect(await checkInteractionAccepted("talked", { getProfile, now: () => NOW })).toBeNull()
    expect(getProfile).not.toHaveBeenCalled()
  })

  it("refuses an egg and a missing profile", async () => {
    expect(
      await checkInteractionAccepted("fed", at({ soul: null } as unknown as PetProfile))
    ).toEqual({ code: "not-hatched" })
    expect(await checkInteractionAccepted("fed", at(undefined))).toEqual({
      code: "uninitialized",
    })
  })
})

describe("a user spending an item", () => {
  it("is refused on cooldown before the item is decremented", async () => {
    const decrements: string[] = []
    const res = await requestPetInteraction(
      { kind: "user" },
      "fed",
      { itemId: "berry" },
      deps({
        getProfile: async () => hatched({ fed: NOW - 100 }),
        decrementInventory: async (id) => {
          decrements.push(id)
          return true
        },
      })
    )
    expect(res).toEqual({
      ok: false,
      refusal: { code: "cooling-down", kind: "fed", retryAfterMs: 1400 },
    })
    expect(decrements).toEqual([])
    expect(emitted).toEqual([])
  })

  it("spends and emits once the controller would accept", async () => {
    const res = await requestPetInteraction({ kind: "user" }, "fed", { itemId: "berry" }, deps())
    expect(res.ok).toBe(true)
    expect(emitted).toEqual([{ source: "user", kind: "fed", meta: { itemId: "berry" } }])
  })
})
