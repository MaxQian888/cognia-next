import type { PetEvent } from "@/types/pet"
import {
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
    expect(emitted.at(-1)?.meta).toEqual({ itemId: "berry", coins: 0 })
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
