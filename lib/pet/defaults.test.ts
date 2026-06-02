import { createDefaultNeeds, createDefaultProfile, DEFAULT_NEED_DECAY } from "./defaults"

describe("createDefaultNeeds", () => {
  it("starts energy/mood full and bond at zero with an ISO tick", () => {
    const n = createDefaultNeeds(1000)
    expect(n).toEqual({ energy: 100, mood: 100, bond: 0, lastTickAt: new Date(1000).toISOString() })
  })
})

describe("createDefaultProfile", () => {
  it("creates an egg-stage level-1 profile with no soul", () => {
    const p = createDefaultProfile("acct-9", 2000)
    expect(p).toMatchObject({
      id: "global",
      soul: null,
      xp: 0,
      level: 1,
      stage: "egg",
      accountFingerprint: "acct-9",
    })
    expect(p.createdAt).toBe(new Date(2000).toISOString())
    expect(p.updatedAt).toBe(new Date(2000).toISOString())
  })
})

describe("DEFAULT_NEED_DECAY", () => {
  it("drains energy faster than mood faster than bond", () => {
    expect(DEFAULT_NEED_DECAY.energy.perHour).toBeGreaterThan(DEFAULT_NEED_DECAY.mood.perHour)
    expect(DEFAULT_NEED_DECAY.mood.perHour).toBeGreaterThan(DEFAULT_NEED_DECAY.bond.perHour)
  })
})
