import type { BalanceQuery } from "@/types/subscription"

import { deepseekBalanceAdapter as a } from "./deepseek"

const Q: BalanceQuery = {
  accountId: "acc-1",
  providerKey: "deepseek",
  baseUrl: "https://api.deepseek.com/v1",
  token: "sk-test",
}

const FIXTURE = JSON.stringify({
  is_available: true,
  balance_infos: [
    {
      currency: "CNY",
      total_balance: "110.00",
      granted_balance: "10.00",
      topped_up_balance: "100.00",
    },
  ],
})

describe("deepseekBalanceAdapter", () => {
  it("matches by providerKey", () => {
    expect(a.matches({ providerKey: "deepseek" })).toBe(true)
    expect(a.matches({ providerKey: "openrouter" })).toBe(false)
  })

  it("matches by baseUrl host", () => {
    expect(a.matches({ baseUrl: "https://api.deepseek.com/v1" })).toBe(true)
    expect(a.matches({ baseUrl: "https://example.com" })).toBe(false)
    expect(a.matches({})).toBe(false)
  })

  it("builds the root-level /user/balance request, stripping /v1", () => {
    const req = a.request(Q)
    expect(req.url).toBe("https://api.deepseek.com/user/balance")
    expect(req.headers.Authorization).toBe("Bearer sk-test")
  })

  it("parses a credit snapshot with currency", () => {
    const snap = a.parse(200, FIXTURE, Q)
    expect(snap.kind).toBe("credit")
    expect(snap.remaining).toBe(110)
    expect(snap.currency).toBe("CNY")
    expect(snap.unit).toBe("CNY")
    expect(snap.error).toBeUndefined()
    expect(snap.raw).toMatchObject({ is_available: true })
  })

  it("returns an error snapshot on non-2xx", () => {
    const snap = a.parse(401, JSON.stringify({ error: "unauthorized" }), Q)
    expect(snap.error).toBe("HTTP 401")
    expect(snap.remaining).toBeUndefined()
  })

  it("returns an error snapshot when balance_infos is missing", () => {
    const snap = a.parse(200, JSON.stringify({ is_available: false }), Q)
    expect(snap.error).toBe("no balance_infos")
  })

  it("returns an error snapshot on unparseable body", () => {
    const snap = a.parse(200, "not json", Q)
    expect(snap.error).toBe("HTTP 200")
  })
})
