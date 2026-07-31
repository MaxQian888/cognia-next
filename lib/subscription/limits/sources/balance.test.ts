import { balanceLimitsSource } from "./balance"

import type { LimitsSourceContext } from "@/types/subscription"

function ctx(over: Partial<LimitsSourceContext> = {}): LimitsSourceContext {
  return {
    provider: "opencode",
    accountId: "acc-1",
    accountLabel: "Kimi",
    token: "sk-kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    providerKey: "moonshot",
    authedGet: async () => JSON.stringify({ code: 0, data: { available_balance: 88.5 } }),
    now: 42,
    ...over,
  }
}

describe("balanceLimitsSource", () => {
  it("matches when a balance adapter resolves the preset", () => {
    expect(balanceLimitsSource.matches({ providerKey: "moonshot" })).toBe(true)
    expect(balanceLimitsSource.matches({ baseUrl: "https://api.moonshot.cn/v1" })).toBe(true)
    expect(balanceLimitsSource.matches({ providerKey: "no-such-provider" })).toBe(false)
  })

  it("projects a balance adapter result into a credit meter", async () => {
    const authedGet = jest.fn(ctx().authedGet)
    const snap = await balanceLimitsSource.fetch(ctx({ authedGet }))
    expect(authedGet).toHaveBeenCalledWith("https://api.moonshot.cn/v1/users/me/balance", {
      Authorization: "Bearer sk-kimi",
      Accept: "application/json",
    })
    expect(snap?.provider).toBe("moonshot")
    expect(snap?.meters).toHaveLength(1)
    expect(snap?.meters[0]).toMatchObject({
      id: "credit",
      kind: "balance",
      remaining: 88.5,
      currency: "CNY",
    })
  })

  it("returns null when token or baseUrl is missing", async () => {
    expect(await balanceLimitsSource.fetch(ctx({ token: null }))).toBeNull()
    expect(await balanceLimitsSource.fetch(ctx({ baseUrl: undefined }))).toBeNull()
  })

  it("returns null when no adapter matches", async () => {
    expect(
      await balanceLimitsSource.fetch(ctx({ providerKey: "groq", baseUrl: "https://api.groq.com" }))
    ).toBeNull()
  })

  it("surfaces a transport error as an error snapshot", async () => {
    const snap = await balanceLimitsSource.fetch(
      ctx({
        authedGet: async () => {
          throw new Error("network down")
        },
      })
    )
    expect(snap?.error).toBe("network down")
    expect(snap?.meters).toHaveLength(0)
  })

  it("surfaces a parser error as an error snapshot", async () => {
    const snap = await balanceLimitsSource.fetch(ctx({ authedGet: async () => "{}" }))
    expect(snap?.error).toBeTruthy()
    expect(snap?.meters).toHaveLength(0)
  })
})
