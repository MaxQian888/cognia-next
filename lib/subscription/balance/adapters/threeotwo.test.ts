import type { BalanceQuery } from "@/types/subscription"

import { threeOTwoBalanceAdapter as a } from "./threeotwo"

const Q: BalanceQuery = {
  accountId: "acc-1",
  providerKey: "302ai",
  baseUrl: "https://api.302.ai/v1",
  token: "sk-test",
}

describe("threeOTwoBalanceAdapter", () => {
  it("matches by providerKey", () => {
    expect(a.matches({ providerKey: "302ai" })).toBe(true)
    expect(a.matches({ providerKey: "deepseek" })).toBe(false)
  })

  it("matches by baseUrl host", () => {
    expect(a.matches({ baseUrl: "https://api.302.ai/v1" })).toBe(true)
    expect(a.matches({ baseUrl: "https://example.com" })).toBe(false)
  })

  it("requests the dashboard balance endpoint with bearer auth", () => {
    const req = a.request(Q)
    expect(req.url).toBe("https://api.302.ai/dashboard/balance")
    expect(req.headers.Authorization).toBe("Bearer sk-test")
  })

  it("parses data.balance", () => {
    const snap = a.parse(200, JSON.stringify({ data: { balance: "42.50" } }), Q)
    expect(snap.kind).toBe("credit")
    expect(snap.remaining).toBe(42.5)
    expect(snap.currency).toBe("USD")
    expect(snap.error).toBeUndefined()
  })

  it("returns an error snapshot on non-2xx / missing field / bad body", () => {
    expect(a.parse(401, "{}", Q).error).toBe("HTTP 401")
    expect(a.parse(200, JSON.stringify({ data: {} }), Q).error).toBe("no data.balance")
    expect(a.parse(200, JSON.stringify({ ok: true }), Q).error).toBe("no data.balance")
    expect(a.parse(200, "not json", Q).error).toBe("HTTP 200")
  })
})
