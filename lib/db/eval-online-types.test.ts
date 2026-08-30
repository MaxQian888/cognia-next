import { budgetDayKey, budgetRowId, queueDedupeKey } from "./eval-online-types"

describe("budgetDayKey", () => {
  it("keys by UTC day, not local time", () => {
    // A local-time key would make one daily cap mean different windows on two
    // devices in the same workspace.
    expect(budgetDayKey(Date.parse("2026-08-30T23:59:59Z"))).toBe("2026-08-30")
    expect(budgetDayKey(Date.parse("2026-08-31T00:00:00Z"))).toBe("2026-08-31")
  })

  it("is stable across instants within the same UTC day", () => {
    expect(budgetDayKey(Date.parse("2026-08-30T00:00:00Z"))).toBe(
      budgetDayKey(Date.parse("2026-08-30T18:30:00Z"))
    )
  })

  it("sorts lexicographically in date order, which the prune range query relies on", () => {
    const days = [
      budgetDayKey(Date.parse("2026-09-01T00:00:00Z")),
      budgetDayKey(Date.parse("2026-08-30T00:00:00Z")),
      budgetDayKey(Date.parse("2026-12-31T00:00:00Z")),
    ]
    expect([...days].sort()).toEqual(["2026-08-30", "2026-09-01", "2026-12-31"])
  })
})

describe("budgetRowId", () => {
  it("scopes a ledger row to one policy and one day", () => {
    expect(budgetRowId("p1", "2026-08-30")).toBe("p1::2026-08-30")
    expect(budgetRowId("p1", "2026-08-30")).not.toBe(budgetRowId("p2", "2026-08-30"))
    expect(budgetRowId("p1", "2026-08-30")).not.toBe(budgetRowId("p1", "2026-08-31"))
  })
})

describe("queueDedupeKey", () => {
  it("keys on the policy VERSION, so a re-offered trace is the same work item", () => {
    expect(queueDedupeKey("p1@1", "t1")).toBe(queueDedupeKey("p1@1", "t1"))
  })

  it("treats a new policy version as new work on the same trace", () => {
    // The verdict may genuinely differ under an edited policy, so this must NOT
    // dedupe — while a retry under the same version must.
    expect(queueDedupeKey("p1@2", "t1")).not.toBe(queueDedupeKey("p1@1", "t1"))
  })

  it("separates traces under one policy version", () => {
    expect(queueDedupeKey("p1@1", "t2")).not.toBe(queueDedupeKey("p1@1", "t1"))
  })
})
