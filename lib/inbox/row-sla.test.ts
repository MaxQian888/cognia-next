import { remainingMinutes, rowSlaState, SLA_NEAR_DUE_MS } from "./row-sla"

const NOW = 1_000_000_000

describe("rowSlaState", () => {
  it("is quiet without a deadline or once resolved", () => {
    expect(rowSlaState(undefined, NOW)).toBeNull()
    expect(rowSlaState({ nextResponseDueAt: undefined }, NOW)).toBeNull()
    expect(rowSlaState({ nextResponseDueAt: NOW - 1, status: "resolved" }, NOW)).toBeNull()
  })

  it("flags an overdue reply", () => {
    expect(rowSlaState({ nextResponseDueAt: NOW - 1, status: "open" }, NOW)).toEqual({
      kind: "overdue",
    })
  })

  it("flags a reply due inside the near-due window", () => {
    expect(rowSlaState({ nextResponseDueAt: NOW + 5 * 60_000 }, NOW)).toEqual({
      kind: "nearDue",
      remainingMs: 5 * 60_000,
    })
    expect(rowSlaState({ nextResponseDueAt: NOW + SLA_NEAR_DUE_MS }, NOW)).toEqual({
      kind: "nearDue",
      remainingMs: SLA_NEAR_DUE_MS,
    })
  })

  it("stays quiet for a deadline further out", () => {
    expect(rowSlaState({ nextResponseDueAt: NOW + SLA_NEAR_DUE_MS + 1 }, NOW)).toBeNull()
  })
})

describe("remainingMinutes", () => {
  it("rounds up and never reports zero", () => {
    expect(remainingMinutes(1)).toBe(1)
    expect(remainingMinutes(60_000)).toBe(1)
    expect(remainingMinutes(60_001)).toBe(2)
    expect(remainingMinutes(0)).toBe(1)
  })
})
