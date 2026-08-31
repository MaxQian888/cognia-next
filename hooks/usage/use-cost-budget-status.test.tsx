/**
 * @jest-environment jsdom
 */
import { renderHook } from "@testing-library/react"

import { useCostBudgetStatus } from "./use-cost-budget-status"
import type { CostBudgetSpend } from "@/lib/usage/cost-budget"

const spendResult: { value: CostBudgetSpend | undefined } = { value: undefined }
const settings: { costBudget?: Record<string, unknown> } = {}

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => spendResult.value,
}))

jest.mock("@/lib/subscription/core/now-ticker", () => ({
  useSubscriptionNow: () => new Date(2026, 4, 20, 12).getTime(),
}))

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) => selector({ settings }),
}))

beforeEach(() => {
  spendResult.value = undefined
  delete settings.costBudget
})

describe("useCostBudgetStatus", () => {
  it("reports unconfigured when the policy holds no positive ceiling", () => {
    settings.costBudget = { dailyUsd: 0, perProviderDailyUsd: { anthropic: 0 } }
    const { result } = renderHook(() => useCostBudgetStatus())
    expect(result.current.configured).toBe(false)
  })

  it("reads configured off the policy, not off the verdicts, while spend loads", () => {
    settings.costBudget = { dailyUsd: 20 }
    const { result } = renderHook(() => useCostBudgetStatus())
    expect(result.current.loading).toBe(true)
    expect(result.current.configured).toBe(true)
    expect(result.current.verdicts).toEqual([])
  })

  it("evaluates every configured scope once spend lands, per-provider included", () => {
    settings.costBudget = { dailyUsd: 20, perProviderMonthlyUsd: { anthropic: 100 } }
    spendResult.value = {
      dayUsd: 5,
      monthUsd: 60,
      byProviderDayUsd: { anthropic: 5 },
      byProviderMonthUsd: { anthropic: 60 },
    }
    const { result } = renderHook(() => useCostBudgetStatus())
    expect(result.current.verdicts.map((v) => v.scopeKey)).toEqual(["day:*", "month:anthropic"])
    expect(result.current.worst?.scopeKey).toBe("month:anthropic")
  })

  it("hands back an empty policy object rather than undefined", () => {
    const { result } = renderHook(() => useCostBudgetStatus())
    expect(result.current.policy).toEqual({})
    expect(result.current.spend).toBeNull()
  })
})
