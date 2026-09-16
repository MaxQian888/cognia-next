jest.mock("@/lib/usage/cost-budget-runtime", () => ({
  readCostBudgetSpend: jest.fn(async () => {
    throw new Error("the default reader must not be reached in these tests")
  }),
}))

import { tenantLimitFor, tightestTenantLimit } from "./tenant-budget"

const spend = async () => ({
  dayUsd: 4,
  monthUsd: 30,
  byProviderDayUsd: { openai: 1.5 },
  byProviderMonthUsd: { openai: 9 },
})

describe("tenantLimitFor", () => {
  it("has no tenant limit when no ceiling is configured, without reading spend", async () => {
    const readSpend = jest.fn(spend)
    expect(await tenantLimitFor(undefined, "openai", readSpend)).toEqual({
      remainingMicrousd: null,
      binding: null,
    })
    expect(await tenantLimitFor({ warnAt: 0.5 }, "openai", readSpend)).toEqual({
      remainingMicrousd: null,
      binding: null,
    })
    expect(readSpend).not.toHaveBeenCalled()
  })

  it("binds to the tightest applicable scope", async () => {
    const limit = await tenantLimitFor(
      { dailyUsd: 10, monthlyUsd: 100, perProviderDailyUsd: { openai: 2, anthropic: 0.1 } },
      "openai",
      spend
    )
    expect(limit.remainingMicrousd).toBe(500_000)
    expect(limit.binding?.scopeKey).toBe("day:openai")
  })

  it("never reports a negative remainder", async () => {
    const limit = await tenantLimitFor({ dailyUsd: 3 }, "openai", spend)
    expect(limit.remainingMicrousd).toBe(0)
    expect(limit.binding?.scopeKey).toBe("day:*")
  })
})

describe("tightestTenantLimit", () => {
  it("takes the tightest limit over every provider a run's roles name, once each", async () => {
    const readSpend = jest.fn(spend)
    const budget = { perProviderDailyUsd: { openai: 2, anthropic: 0.25 } }
    await expect(
      tightestTenantLimit(
        budget,
        ["openai::gpt-5-mini", "openai::gpt-5", "anthropic::claude-sonnet-5", "malformed"],
        readSpend
      )
    ).resolves.toBe(250_000)
    // openai and anthropic, not one read per role.
    expect(readSpend).toHaveBeenCalledTimes(2)
  })

  it("is no limit at all when no provider has a scope", async () => {
    await expect(tightestTenantLimit(undefined, ["openai::gpt-5"], spend)).resolves.toBeNull()
    await expect(
      tightestTenantLimit({ perProviderDailyUsd: { mistral: 1 } }, ["openai::gpt-5"], spend)
    ).resolves.toBeNull()
  })
})
