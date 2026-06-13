import { balanceMeter, deriveWindowStatus, errorLimits, windowMeter } from "./meters"

import type { BalanceSnapshot } from "@/types/subscription"

function bal(over: Partial<BalanceSnapshot> = {}): BalanceSnapshot {
  return {
    fetchedAt: 0,
    providerKey: "moonshot",
    accountId: "a",
    kind: "credit",
    currency: "CNY",
    unit: "CNY",
    remaining: 42,
    raw: {},
    ...over,
  }
}

describe("deriveWindowStatus", () => {
  it("classifies ok / warn / crit / exceeded", () => {
    expect(deriveWindowStatus(10)).toBe("ok")
    expect(deriveWindowStatus(90)).toBe("warn")
    expect(deriveWindowStatus(95)).toBe("warn")
    expect(deriveWindowStatus(100)).toBe("crit")
    expect(deriveWindowStatus(140)).toBe("exceeded")
  })

  it("returns unknown for non-finite", () => {
    expect(deriveWindowStatus(Number.NaN)).toBe("unknown")
  })
})

describe("windowMeter", () => {
  it("rounds the percent and carries the reset + status", () => {
    const m = windowMeter("session", "k.session", { utilization: 21.4, resetAt: 1000 })
    expect(m).toMatchObject({
      id: "session",
      labelKey: "k.session",
      kind: "window",
      usedPct: 21,
      resetAt: 1000,
      status: "ok",
    })
  })
})

describe("balanceMeter", () => {
  it("computes usedPct from used/total", () => {
    const m = balanceMeter(bal({ used: 30, total: 100, remaining: 70 }))
    expect(m.kind).toBe("balance")
    expect(m.usedPct).toBe(30)
    expect(m.status).toBe("ok")
    expect(m.currency).toBe("CNY")
  })

  it("computes usedPct from remaining/total when used is absent", () => {
    const m = balanceMeter(bal({ total: 200, remaining: 50 }))
    expect(m.usedPct).toBe(75)
    expect(m.status).toBe("ok")
  })

  it("flags a nearly-depleted balance as warn", () => {
    const m = balanceMeter(bal({ total: 100, remaining: 5 }))
    expect(m.usedPct).toBe(95)
    expect(m.status).toBe("warn")
  })

  it("leaves usedPct null for remaining-only credit and marks ok", () => {
    const m = balanceMeter(bal({ remaining: 42 }))
    expect(m.usedPct).toBeNull()
    expect(m.status).toBe("ok")
  })

  it("flags a depleted balance as exceeded", () => {
    const m = balanceMeter(bal({ remaining: 0 }))
    expect(m.status).toBe("exceeded")
  })

  it("returns unknown when there is no usable amount", () => {
    const m = balanceMeter(bal({ remaining: undefined }))
    expect(m.status).toBe("unknown")
  })
})

describe("errorLimits", () => {
  it("builds a snapshot carrying just the error", () => {
    const e = errorLimits({ accountId: "a", accountLabel: "L", now: 5 }, "moonshot", "boom")
    expect(e).toEqual({
      provider: "moonshot",
      accountId: "a",
      accountLabel: "L",
      fetchedAt: 5,
      meters: [],
      error: "boom",
    })
  })
})
