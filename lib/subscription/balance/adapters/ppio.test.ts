import type { BalanceQuery } from "@/types/subscription"

import { ppioBalanceAdapter as a } from "./ppio"

const Q: BalanceQuery = {
  accountId: "acc-1",
  providerKey: "ppio",
  baseUrl: "https://api.ppio.com/v3/openai",
  token: "sk-test",
}

describe("ppioBalanceAdapter", () => {
  it("matches by providerKey incl. the legacy ppinfra spelling", () => {
    expect(a.matches({ providerKey: "ppio" })).toBe(true)
    expect(a.matches({ providerKey: "ppinfra" })).toBe(true)
    expect(a.matches({ providerKey: "novita" })).toBe(false)
  })

  it("matches by both host spellings", () => {
    expect(a.matches({ baseUrl: "https://api.ppio.com/v3/openai" })).toBe(true)
    expect(a.matches({ baseUrl: "https://api.ppinfra.com/v3/openai" })).toBe(true)
    expect(a.matches({ baseUrl: "https://example.com" })).toBe(false)
  })

  it("requests the fixed billing endpoint with bearer auth", () => {
    const req = a.request(Q)
    expect(req.url).toBe("https://api.ppio.com/openapi/v1/billing/balance/detail")
    expect(req.headers.Authorization).toBe("Bearer sk-test")
  })

  it("converts 1/10000-CNY strings to yuan", () => {
    const snap = a.parse(200, JSON.stringify({ availableBalance: "250000" }), Q)
    expect(snap.remaining).toBe(25)
    expect(snap.currency).toBe("CNY")
    expect(snap.error).toBeUndefined()
  })

  it("returns an error snapshot on non-2xx / missing field / bad body", () => {
    expect(a.parse(500, "{}", Q).error).toBe("HTTP 500")
    expect(a.parse(200, JSON.stringify({ cashBalance: "1" }), Q).error).toBe("no availableBalance")
    expect(a.parse(200, "not json", Q).error).toBe("HTTP 200")
  })
})
