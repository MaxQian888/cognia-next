/** @jest-environment jsdom */
import {
  __resetPetBudgetForTesting,
  consumePetBudget,
  getRemainingPetBudget,
  PET_DAILY_COIN_BUDGET,
  PET_DAILY_XP_BUDGET,
  type PetBudgetDeps,
} from "./reward-budget"

/** Fresh isolated storage per test (never touches real localStorage). */
function makeDeps(nowMs: number): PetBudgetDeps & { store: Map<string, string> } {
  const store = new Map<string, string>()
  return {
    store,
    now: () => nowMs,
    storage: {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => {
        store.set(k, v)
      },
    },
  }
}

const NOON = new Date("2026-07-02T12:00:00").getTime()
const TOMORROW_NOON = new Date("2026-07-03T12:00:00").getTime()

afterEach(() => {
  __resetPetBudgetForTesting()
  try {
    if (typeof localStorage !== "undefined") localStorage.clear()
  } catch {
    // node test env — memory fallback already cleared
  }
})

describe("getRemainingPetBudget", () => {
  it("starts at the full daily budgets", () => {
    expect(getRemainingPetBudget("p1", makeDeps(NOON))).toEqual({
      xp: PET_DAILY_XP_BUDGET,
      coins: PET_DAILY_COIN_BUDGET,
    })
  })
})

describe("consumePetBudget", () => {
  it("grants within budget and decrements the remainder", () => {
    const deps = makeDeps(NOON)
    expect(consumePetBudget("p1", { xp: 10, coins: 30 }, deps)).toEqual({
      grantedXp: 10,
      grantedCoins: 30,
    })
    expect(getRemainingPetBudget("p1", deps)).toEqual({
      xp: PET_DAILY_XP_BUDGET - 10,
      coins: PET_DAILY_COIN_BUDGET - 30,
    })
  })

  it("clamps a grant at the boundary instead of rejecting", () => {
    const deps = makeDeps(NOON)
    consumePetBudget("p1", { xp: PET_DAILY_XP_BUDGET - 5 }, deps)
    expect(consumePetBudget("p1", { xp: 20 }, deps)).toEqual({ grantedXp: 5, grantedCoins: 0 })
    expect(consumePetBudget("p1", { xp: 1 }, deps)).toEqual({ grantedXp: 0, grantedCoins: 0 })
  })

  it("isolates budgets across plugins", () => {
    const deps = makeDeps(NOON)
    consumePetBudget("p1", { xp: PET_DAILY_XP_BUDGET }, deps)
    expect(consumePetBudget("p2", { xp: 5 }, deps).grantedXp).toBe(5)
  })

  it("resets lazily on the next local day", () => {
    const deps = makeDeps(NOON)
    consumePetBudget("p1", { xp: PET_DAILY_XP_BUDGET, coins: PET_DAILY_COIN_BUDGET }, deps)
    expect(getRemainingPetBudget("p1", deps)).toEqual({ xp: 0, coins: 0 })
    const tomorrow = { ...deps, now: () => TOMORROW_NOON }
    expect(getRemainingPetBudget("p1", tomorrow)).toEqual({
      xp: PET_DAILY_XP_BUDGET,
      coins: PET_DAILY_COIN_BUDGET,
    })
  })

  it("persists across ledger reads (storage round-trip)", () => {
    const deps = makeDeps(NOON)
    consumePetBudget("p1", { xp: 7 }, deps)
    // A second consumer sharing the same storage sees the prior spend.
    const sameStore: PetBudgetDeps = { now: deps.now, storage: deps.storage }
    expect(getRemainingPetBudget("p1", sameStore).xp).toBe(PET_DAILY_XP_BUDGET - 7)
  })

  it("floors fractional requests and ignores negatives / garbage", () => {
    const deps = makeDeps(NOON)
    expect(consumePetBudget("p1", { xp: 3.9, coins: -5 }, deps)).toEqual({
      grantedXp: 3,
      grantedCoins: 0,
    })
    expect(consumePetBudget("p1", { xp: Number.NaN }, deps).grantedXp).toBe(0)
  })

  it("falls back to the in-memory store without a DOM storage", () => {
    // No storage/now injected → memory fallback path.
    const first = consumePetBudget("mem-plugin", { xp: 4 })
    expect(first.grantedXp).toBe(4)
    expect(getRemainingPetBudget("mem-plugin").xp).toBe(PET_DAILY_XP_BUDGET - 4)
  })

  it("recovers from a corrupted ledger", () => {
    // The previous shape of this test read `[...store.keys()][0]` from an
    // EMPTY map and wrote its garbage to the key "unused", so the real day key
    // was never corrupted and `readLedger`'s try/catch was never exercised.
    const deps = makeDeps(NOON)
    consumePetBudget("p1", { xp: 1 }, deps)
    const dayKey = [...deps.store.keys()][0]
    expect(dayKey).toBeDefined()
    deps.store.set(dayKey, "{not json")
    // A ledger it cannot parse is treated as a fresh day, not as a throw.
    expect(consumePetBudget("p1", { xp: 2 }, deps).grantedXp).toBe(2)
    expect(getRemainingPetBudget("p1", deps).xp).toBe(PET_DAILY_XP_BUDGET - 2)
  })
})
