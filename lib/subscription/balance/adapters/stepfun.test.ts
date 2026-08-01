import type { BalanceQuery } from "@/types/subscription"

import { stepfunBalanceAdapter as adapter } from "./stepfun"

const QUERY: BalanceQuery = {
  accountId: "acc-stepfun",
  providerKey: "stepfun",
  baseUrl: "https://api.stepfun.com/v1",
  token: "sk-stepfun-test",
}

describe("stepfunBalanceAdapter", () => {
  it("matches the provider key and official API host", () => {
    expect(adapter.matches({ providerKey: "stepfun" })).toBe(true)
    expect(adapter.matches({ baseUrl: "https://api.stepfun.com/v1" })).toBe(true)
    expect(adapter.matches({ providerKey: "openrouter" })).toBe(false)
  })

  it("builds the documented account request", () => {
    expect(adapter.request(QUERY)).toEqual({
      url: "https://api.stepfun.com/v1/accounts",
      headers: {
        Authorization: "Bearer sk-stepfun-test",
        Accept: "application/json",
      },
    })
  })

  it("preserves CNY as the native unit and parses numeric strings", () => {
    const snapshot = adapter.parse(
      200,
      JSON.stringify({
        object: "account",
        type: "prepaid",
        balance: "18.75",
        total_cash_balance: 20,
        total_voucher_balance: "5.5",
      }),
      QUERY
    )

    expect(snapshot).toMatchObject({
      kind: "credit",
      currency: "CNY",
      unit: "CNY",
      remaining: 18.75,
      total: 25.5,
    })
  })

  it("returns actionable errors for status, malformed JSON, and missing balance", () => {
    expect(adapter.parse(401, '{"error":"invalid token"}', QUERY).error).toBe("HTTP 401")
    expect(adapter.parse(200, "not-json", QUERY).error).toBe("invalid response")
    expect(adapter.parse(200, '{"object":"account"}', QUERY).error).toBe("no balance")
  })
})
