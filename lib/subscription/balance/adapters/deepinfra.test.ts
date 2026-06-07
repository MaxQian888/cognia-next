import type { BalanceQuery } from "@/types/subscription"

import { deepinfraBalanceAdapter as a } from "./deepinfra"

const Q: BalanceQuery = {
  accountId: "acc-1",
  providerKey: "deepinfra",
  baseUrl: "https://api.deepinfra.com/v1/openai",
  token: "sk-test",
}

describe("deepinfraBalanceAdapter", () => {
  it("matches by providerKey", () => {
    expect(a.matches({ providerKey: "deepinfra" })).toBe(true)
    expect(a.matches({ providerKey: "novita" })).toBe(false)
  })

  it("matches by baseUrl host", () => {
    expect(a.matches({ baseUrl: "https://api.deepinfra.com/v1/openai" })).toBe(true)
    expect(a.matches({ baseUrl: "https://example.com" })).toBe(false)
  })

  it("requests /v1/me with bearer auth", () => {
    const req = a.request(Q)
    expect(req.url).toBe("https://api.deepinfra.com/v1/me")
    expect(req.headers.Authorization).toBe("Bearer sk-test")
  })

  it("inverts stripe_balance sign (negative = spendable)", () => {
    const snap = a.parse(
      200,
      JSON.stringify({ checklist: { stripe_balance: -12.5, recent: 1.2 } }),
      Q
    )
    expect(snap.kind).toBe("credit")
    expect(snap.remaining).toBe(12.5)
    expect(snap.currency).toBe("USD")
    expect(snap.error).toBeUndefined()
  })

  it("surfaces money-owed as a negative remaining", () => {
    const snap = a.parse(200, JSON.stringify({ checklist: { stripe_balance: 3 } }), Q)
    expect(snap.remaining).toBe(-3)
  })

  it("returns an error snapshot on non-2xx", () => {
    const snap = a.parse(401, JSON.stringify({ detail: "unauthorized" }), Q)
    expect(snap.error).toBe("HTTP 401")
  })

  it("returns an error snapshot when checklist.stripe_balance is missing", () => {
    const snap = a.parse(200, JSON.stringify({ checklist: {} }), Q)
    expect(snap.error).toBe("no checklist.stripe_balance")
    const snap2 = a.parse(200, JSON.stringify({ uid: "x" }), Q)
    expect(snap2.error).toBe("no checklist.stripe_balance")
  })

  it("returns an error snapshot on unparseable body", () => {
    const snap = a.parse(200, "not json", Q)
    expect(snap.error).toBe("HTTP 200")
  })
})
