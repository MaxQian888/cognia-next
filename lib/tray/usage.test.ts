/** @jest-environment jsdom */

import { act, renderHook } from "@testing-library/react"

jest.mock("@/lib/subscription/limits/hooks", () => ({
  useAllConfiguredLimits: jest.fn(),
}))
jest.mock("@/lib/subscription/core/subscription-events", () => ({
  subscribeSubscriptionChanged: jest.fn(() => () => {}),
}))
const budgetWorst: { current: unknown } = { current: null }
jest.mock("@/hooks/usage/use-cost-budget-status", () => ({
  useCostBudgetStatus: () => ({ worst: budgetWorst.current }),
}))
const glanceMock = jest.fn()
jest.mock("@/hooks/usage/use-usage-glance", () => ({
  useUsageGlance: (opts: unknown) => {
    glanceMock(opts)
    return { snapshot: null, refresh: jest.fn() }
  },
}))

import { subscribeSubscriptionChanged } from "@/lib/subscription/core/subscription-events"
import { useAllConfiguredLimits } from "@/lib/subscription/limits/hooks"

import { useTrayUsage } from "./usage"
import { requestTrayUsageRefresh } from "./usage-refresh-bus"

import type { ProviderLimits } from "@/types/subscription"

const useAllConfiguredLimitsMock = useAllConfiguredLimits as jest.Mock
const subscribeSubscriptionChangedMock = subscribeSubscriptionChanged as jest.Mock

describe("useTrayUsage", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    budgetWorst.current = null
    subscribeSubscriptionChangedMock.mockReturnValue(() => {})
  })

  function mockLimits(snapshots: ProviderLimits[] = []) {
    const refresh = jest.fn(() => Promise.resolve())
    useAllConfiguredLimitsMock.mockReturnValue({ snapshots, refreshing: false, refresh })
    return refresh
  }

  it("stays inert while disabled", () => {
    const refresh = mockLimits()
    const { result } = renderHook(() => useTrayUsage(false, 15))
    expect(result.current).toBeNull()
    expect(refresh).not.toHaveBeenCalled()
    expect(subscribeSubscriptionChangedMock).not.toHaveBeenCalled()
  })

  it("refreshes on mount and summarizes the snapshots", () => {
    const refresh = mockLimits([
      {
        provider: "anthropic",
        accountId: "a1",
        accountLabel: "Claude Pro",
        fetchedAt: 123,
        meters: [{ id: "session", kind: "window", usedPct: 10, status: "ok" }],
      },
    ])
    const { result } = renderHook(() => useTrayUsage(true, 0))
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(result.current?.fetchedAt).toBe(123)
    expect(result.current?.accounts[0]?.key).toBe("anthropic:a1")
  })

  it("re-queries on subscription changes, explicit requests, and the interval", () => {
    jest.useFakeTimers()
    try {
      let busListener: (() => void) | undefined
      subscribeSubscriptionChangedMock.mockImplementation((cb: () => void) => {
        busListener = cb
        return () => {}
      })
      const refresh = mockLimits()
      const { unmount } = renderHook(() => useTrayUsage(true, 15))
      expect(refresh).toHaveBeenCalledTimes(1)

      act(() => busListener?.())
      expect(refresh).toHaveBeenCalledTimes(2)

      act(() => requestTrayUsageRefresh())
      expect(refresh).toHaveBeenCalledTimes(3)

      act(() => jest.advanceTimersByTime(15 * 60_000))
      expect(refresh).toHaveBeenCalledTimes(4)

      unmount()
      act(() => jest.advanceTimersByTime(60 * 60_000))
      expect(refresh).toHaveBeenCalledTimes(4)
      // Post-unmount explicit requests must not leak into a dead hook.
      act(() => requestTrayUsageRefresh())
      expect(refresh).toHaveBeenCalledTimes(4)
    } finally {
      jest.useRealTimers()
    }
  })

  it("skips the interval in manual-only mode", () => {
    jest.useFakeTimers()
    try {
      const refresh = mockLimits()
      renderHook(() => useTrayUsage(true, 0))
      expect(refresh).toHaveBeenCalledTimes(1)
      act(() => jest.advanceTimersByTime(24 * 3_600_000))
      expect(refresh).toHaveBeenCalledTimes(1)
    } finally {
      jest.useRealTimers()
    }
  })

  it("folds the tightest budget into the glance, so the budget metric has a number", () => {
    mockLimits()
    budgetWorst.current = {
      scopeKey: "month:*",
      period: "month",
      target: "*",
      usedUsd: 40,
      limitUsd: 50,
      ratio: 0.8,
      level: "warning",
    }
    renderHook(() =>
      useTrayUsage(true, 0, {
        usageMetric: "budget",
        usagePeriod: "today",
        usageScope: "cognia",
        usageAccountKey: null,
      })
    )
    expect(glanceMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        enabled: true,
        budget: { ratio: 0.8, target: "*", period: "month", blocked: false },
      })
    )
  })

  it("keeps the spend feed off under the quota metric", () => {
    mockLimits()
    renderHook(() => useTrayUsage(true, 0))
    expect(glanceMock).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }))
  })
})
