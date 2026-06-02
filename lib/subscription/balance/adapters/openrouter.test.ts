import type { BalanceQuery } from "@/types/subscription"

import { openrouterBalanceAdapter as a } from "./openrouter"

const Q: BalanceQuery = {
  accountId: "acc-1",
  providerKey: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  token: "sk-or-test",
}

const FIXTURE = JSON.stringify({ data: { total_credits: 50, total_usage: 12.5 } })

describe("openrouterBalanceAdapter", () => {
  it("matches by providerKey and host", () => {
    expect(a.matches({ providerKey: "openrouter" })).toBe(true)
    expect(a.matches({ baseUrl: "https://openrouter.ai/api/v1" })).toBe(true)
    expect(a.matches({ providerKey: "deepseek" })).toBe(false)
    expect(a.matches({})).toBe(false)
  })

  it("builds the /credits request", () => {
    const req = a.request(Q)
    expect(req.url).toBe("https://openrouter.ai/api/v1/credits")
    expect(req.headers.Authorization).toBe("Bearer sk-or-test")
  })

  it("parses credits with derived remaining", () => {
    const snap = a.parse(200, FIXTURE, Q)
    expect(snap.kind).toBe("credit")
    expect(snap.total).toBe(50)
    expect(snap.used).toBe(12.5)
    expect(snap.remaining).toBe(37.5)
    expect(snap.unit).toBe("USD")
    expect(snap.currency).toBe("USD")
  })

  it("leaves remaining undefined when a field is missing", () => {
    const snap = a.parse(200, JSON.stringify({ data: { total_credits: 50 } }), Q)
    expect(snap.total).toBe(50)
    expect(snap.remaining).toBeUndefined()
  })

  it("errors on non-2xx and on missing data", () => {
    expect(a.parse(500, "{}", Q).error).toBe("HTTP 500")
    expect(a.parse(200, JSON.stringify({ foo: 1 }), Q).error).toBe("no data")
  })
})
