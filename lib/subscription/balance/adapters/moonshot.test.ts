import type { BalanceQuery } from "@/types/subscription"

import { moonshotBalanceAdapter as a } from "./moonshot"

const Q: BalanceQuery = {
  accountId: "acc-1",
  providerKey: "moonshot",
  baseUrl: "https://api.moonshot.cn/v1",
  token: "sk-moon-test",
}

const FIXTURE = JSON.stringify({
  code: 0,
  status: true,
  data: { available_balance: 49.58894, voucher_balance: 46.58893, cash_balance: 3.00001 },
})

describe("moonshotBalanceAdapter", () => {
  it("matches by providerKey and host", () => {
    expect(a.matches({ providerKey: "moonshot" })).toBe(true)
    expect(a.matches({ baseUrl: "https://api.moonshot.cn/v1" })).toBe(true)
    expect(a.matches({ baseUrl: "https://api.moonshot.ai/v1" })).toBe(true)
    expect(a.matches({ providerKey: "deepseek" })).toBe(false)
    expect(a.matches({})).toBe(false)
  })

  it("builds the /users/me/balance request", () => {
    const req = a.request(Q)
    expect(req.url).toBe("https://api.moonshot.cn/v1/users/me/balance")
    // The Anthropic relay preset baseUrl ("…cn/anthropic") resolves the same.
    expect(a.request({ ...Q, baseUrl: "https://api.moonshot.cn/anthropic" }).url).toBe(
      "https://api.moonshot.cn/v1/users/me/balance"
    )
    expect(req.headers.Authorization).toBe("Bearer sk-moon-test")
  })

  it("parses available_balance as remaining (CNY for the .cn console)", () => {
    const snap = a.parse(200, FIXTURE, Q)
    expect(snap.kind).toBe("credit")
    expect(snap.remaining).toBeCloseTo(49.58894)
    expect(snap.currency).toBe("CNY")
    expect(snap.unit).toBe("CNY")
  })

  it("tags USD for the international .ai / kimi.ai host", () => {
    const aiQ: BalanceQuery = { ...Q, baseUrl: "https://api.moonshot.ai/v1" }
    const snap = a.parse(200, FIXTURE, aiQ)
    expect(snap.currency).toBe("USD")
    expect(snap.unit).toBe("USD")
    const kimiQ: BalanceQuery = { ...Q, baseUrl: "https://platform.kimi.ai/v1" }
    expect(a.parse(200, FIXTURE, kimiQ).currency).toBe("USD")
  })

  it("defaults to CNY when no baseUrl is available", () => {
    const snap = a.parse(200, FIXTURE, { ...Q, baseUrl: undefined as unknown as string })
    expect(snap.currency).toBe("CNY")
  })

  it("errors on non-2xx and missing data", () => {
    expect(a.parse(401, "{}", Q).error).toBe("HTTP 401")
    expect(a.parse(200, JSON.stringify({ code: 0 }), Q).error).toBe("no data")
    // available_balance absent (data present) → cannot derive remaining.
    expect(a.parse(200, JSON.stringify({ data: {} }), Q).remaining).toBeUndefined()
  })
})
