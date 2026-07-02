import { COIN_AWARD, coinsForEvent } from "./coin-table"

describe("COIN_AWARD", () => {
  it("mints coins for every direct interaction kind", () => {
    for (const kind of [
      "fed",
      "played",
      "petted",
      "talked",
      "slept",
      "cleaned",
      "treated",
    ] as const) {
      expect(COIN_AWARD[kind] ?? 0).toBeGreaterThan(0)
    }
  })

  it("mints nothing for radar / lifecycle / twin kinds", () => {
    for (const kind of [
      "thinking",
      "waiting",
      "idle",
      "error",
      "twinBusy",
      "twinMilestone",
      "hatched",
      "levelUp",
      "evolved",
      "achievementUnlocked",
      "greeting",
      "inboundMessage",
    ] as const) {
      expect(coinsForEvent(kind)).toBe(0)
    }
  })

  it("keeps goalComplete the biggest single mint", () => {
    const max = Math.max(...Object.values(COIN_AWARD))
    expect(COIN_AWARD.goalComplete).toBe(max)
  })
})

describe("coinsForEvent", () => {
  it("resolves from the table when no explicit amount is given", () => {
    expect(coinsForEvent("fed")).toBe(COIN_AWARD.fed)
    expect(coinsForEvent("goalComplete")).toBe(COIN_AWARD.goalComplete)
  })

  it("lets an explicit amount win over the table, floored and clamped ≥ 0", () => {
    expect(coinsForEvent("fed", 10)).toBe(10)
    expect(coinsForEvent("fed", 4.7)).toBe(4)
    expect(coinsForEvent("fed", -3)).toBe(0)
    expect(coinsForEvent("idle", 5)).toBe(5)
  })

  it("ignores a non-finite explicit amount", () => {
    expect(coinsForEvent("fed", Number.NaN)).toBe(COIN_AWARD.fed)
    expect(coinsForEvent("fed", Infinity)).toBe(COIN_AWARD.fed)
  })
})
