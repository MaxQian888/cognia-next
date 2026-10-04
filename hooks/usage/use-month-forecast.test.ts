/**
 * @jest-environment jsdom
 */
import { renderHook } from "@testing-library/react"

import type { SessionUsageRow } from "@/lib/db/session-usage"
import { useMonthForecast } from "./use-month-forecast"

const NOW = new Date(2026, 4, 20, 12).getTime()
const live: { rows: SessionUsageRow[] | undefined; deps: unknown[] } = { rows: undefined, deps: [] }

jest.mock("@/hooks/data/use-client-live-query", () => ({
  useClientLiveQuery: (_q: unknown, deps: unknown[]) => {
    live.deps = deps
    return live.rows
  },
}))
jest.mock("@/lib/db/schema", () => ({ getDb: jest.fn() }))
jest.mock("@/lib/subscription/core/now-ticker", () => ({
  useSubscriptionNow: () => NOW,
}))

function row(daysBack: number, costUsd: number): SessionUsageRow {
  const d = new Date(NOW)
  d.setDate(d.getDate() - daysBack)
  d.setHours(9, 0, 0, 0)
  return {
    messageId: `m-${daysBack}`,
    sessionId: "s",
    at: d.getTime(),
    inputTokens: 1,
    outputTokens: 1,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd,
    costSource: "sdk",
    costKnown: true,
    durationMs: 0,
  }
}

beforeEach(() => {
  live.rows = undefined
})

describe("useMonthForecast", () => {
  it("is null until the read answers", () => {
    const { result } = renderHook(() => useMonthForecast())
    expect(result.current.forecast).toBeNull()
    expect(result.current.now).toBe(NOW)
  })

  it("keys the live query on the local day, not the clock", () => {
    renderHook(() => useMonthForecast())
    expect(live.deps).toEqual(["2026-05-20"])
  })

  it("projects the month from the rows", () => {
    live.rows = [0, 1, 2, 3, 4, 5, 6, 7].map((d) => row(d, 2))
    const { result } = renderHook(() => useMonthForecast())
    expect(result.current.forecast?.monthToDateUsd).toBe(16)
    expect(result.current.forecast?.basis).toBe("trailing-7d")
    expect(result.current.forecast?.projectedMonthUsd).toBeGreaterThan(16)
  })
})
