import type { BalanceQuery } from "@/types/subscription"

import { openrouterBalanceAdapter as a } from "./openrouter"

const Q: BalanceQuery = {
  accountId: "acc-1",
  providerKey: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  token: "sk-or-test",
}

// /api/v1/key shape — works with the ordinary inference key (unlike /credits,
// which needs a management key).
const FIXTURE = JSON.stringify({
  data: { usage: 12.5, limit: 50, limit_remaining: 37.5, is_free_tier: false },
})

describe("openrouterBalanceAdapter", () => {
  it("matches by providerKey and host", () => {
    expect(a.matches({ providerKey: "openrouter" })).toBe(true)
    expect(a.matches({ baseUrl: "https://openrouter.ai/api/v1" })).toBe(true)
    expect(a.matches({ providerKey: "deepseek" })).toBe(false)
    expect(a.matches({})).toBe(false)
  })

  it("builds the /key request (works with the inference key, not /credits)", () => {
    const req = a.request(Q)
    expect(req.url).toBe("https://openrouter.ai/api/v1/key")
    // The Anthropic relay preset baseUrl ("…/api", no "/v1") resolves the same.
    expect(a.request({ ...Q, baseUrl: "https://openrouter.ai/api" }).url).toBe(
      "https://openrouter.ai/api/v1/key"
    )
    expect(req.headers.Authorization).toBe("Bearer sk-or-test")
  })

  it("parses usage / limit / limit_remaining", () => {
    const snap = a.parse(200, FIXTURE, Q)
    expect(snap.kind).toBe("credit")
    expect(snap.total).toBe(50)
    expect(snap.used).toBe(12.5)
    expect(snap.remaining).toBe(37.5)
    expect(snap.unit).toBe("USD")
    expect(snap.currency).toBe("USD")
  })

  it("leaves total/remaining undefined for an uncapped (null limit) key", () => {
    const snap = a.parse(
      200,
      JSON.stringify({ data: { usage: 12.5, limit: null, limit_remaining: null } }),
      Q
    )
    expect(snap.used).toBe(12.5)
    expect(snap.total).toBeUndefined()
    expect(snap.remaining).toBeUndefined()
  })

  it("errors on non-2xx and on missing data", () => {
    expect(a.parse(500, "{}", Q).error).toBe("HTTP 500")
    expect(a.parse(200, JSON.stringify({ foo: 1 }), Q).error).toBe("no data")
  })
})
