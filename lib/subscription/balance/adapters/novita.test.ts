import type { BalanceQuery } from "@/types/subscription"

import { novitaBalanceAdapter as a } from "./novita"

const Q: BalanceQuery = {
  accountId: "acc-1",
  providerKey: "novita",
  baseUrl: "https://api.novita.ai/v3/openai",
  token: "sk-test",
}

const FIXTURE = JSON.stringify({
  availableBalance: "1000000",
  cashBalance: "800000",
  creditLimit: "200000",
  pendingCharges: "0",
  outstandingInvoices: "0",
})

describe("novitaBalanceAdapter", () => {
  it("matches by providerKey", () => {
    expect(a.matches({ providerKey: "novita" })).toBe(true)
    expect(a.matches({ providerKey: "deepseek" })).toBe(false)
  })

  it("matches by baseUrl host", () => {
    expect(a.matches({ baseUrl: "https://api.novita.ai/v3/openai" })).toBe(true)
    expect(a.matches({ baseUrl: "https://example.com" })).toBe(false)
    expect(a.matches({})).toBe(false)
  })

  it("requests the fixed billing endpoint with bearer auth", () => {
    const req = a.request(Q)
    expect(req.url).toBe("https://api.novita.ai/openapi/v1/billing/balance/detail")
    expect(req.headers.Authorization).toBe("Bearer sk-test")
  })

  it("converts 1/10000-USD strings to dollars", () => {
    const snap = a.parse(200, FIXTURE, Q)
    expect(snap.kind).toBe("credit")
    expect(snap.remaining).toBe(100)
    expect(snap.currency).toBe("USD")
    expect(snap.error).toBeUndefined()
  })

  it("returns an error snapshot on non-2xx", () => {
    const snap = a.parse(403, JSON.stringify({ message: "forbidden" }), Q)
    expect(snap.error).toBe("HTTP 403")
    expect(snap.remaining).toBeUndefined()
  })

  it("returns an error snapshot when availableBalance is missing", () => {
    const snap = a.parse(200, JSON.stringify({ cashBalance: "1" }), Q)
    expect(snap.error).toBe("no availableBalance")
  })

  it("returns an error snapshot on unparseable body", () => {
    const snap = a.parse(200, "not json", Q)
    expect(snap.error).toBe("HTTP 200")
  })
})
