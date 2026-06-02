import { xpForEvent, XP_AWARD } from "./award-table"

describe("xpForEvent", () => {
  it("prefers an explicit value", () => {
    expect(xpForEvent("fed", 99)).toBe(99)
    expect(xpForEvent("fed", 0)).toBe(0)
  })

  it("falls back to the award table", () => {
    expect(xpForEvent("goalComplete")).toBe(25)
    expect(xpForEvent("thinking")).toBe(0)
  })

  it("defaults unknown weights to 0", () => {
    // @ts-expect-error — exercising the fallback branch
    expect(xpForEvent("nonexistent")).toBe(0)
  })

  it("rewards goal completion the most", () => {
    const values = Object.values(XP_AWARD) as number[]
    expect(Math.max(...values)).toBe(XP_AWARD.goalComplete)
  })
})
