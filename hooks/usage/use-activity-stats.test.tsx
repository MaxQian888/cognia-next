/**
 * @jest-environment jsdom
 */
import { renderHook } from "@testing-library/react"
import type { SessionUsageRow } from "@/lib/db/session-usage"

// `useLiveQuery` is replaced wholesale: this suite is about the derivation, not
// about Dexie's subscription machinery (which the store tests already cover).
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: jest.fn() }))
jest.mock("@/lib/db/schema", () => ({
  getDb: jest.fn(() => ({ sessionUsage: { toArray: jest.fn(async () => []) } })),
}))

import { useLiveQuery } from "dexie-react-hooks"
import { useActivityStats } from "./use-activity-stats"

const mockLiveQuery = useLiveQuery as jest.Mock

const NOW = new Date(2026, 4, 20, 12).getTime()

function at(day: number, hour = 10): number {
  return new Date(2026, 4, day, hour).getTime()
}

function row(overrides: Partial<SessionUsageRow> = {}): SessionUsageRow {
  return {
    messageId: `m-${Math.random()}`,
    sessionId: "s1",
    at: at(20),
    model: "sonnet",
    inputTokens: 100,
    outputTokens: 50,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0.01,
    durationMs: 1000,
    ...overrides,
  }
}

beforeEach(() => {
  jest.spyOn(Date, "now").mockReturnValue(NOW)
  mockLiveQuery.mockReset()
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe("useActivityStats", () => {
  it("reports loading with zeroed stats until Dexie delivers a snapshot", () => {
    mockLiveQuery.mockReturnValue(undefined)
    const { result } = renderHook(() => useActivityStats(30))
    expect(result.current.loading).toBe(true)
    expect(result.current.stats.turns).toBe(0)
    expect(result.current.daily).toEqual([])
    expect(result.current.models).toEqual([])
  })

  it("derives stats, daily buckets and per-model rows once loaded", () => {
    mockLiveQuery.mockReturnValue([
      row({ messageId: "a", at: at(19) }),
      row({ messageId: "b", at: at(20), sessionId: "s2", model: "opus" }),
    ])
    const { result } = renderHook(() => useActivityStats(30))

    expect(result.current.loading).toBe(false)
    expect(result.current.stats.turns).toBe(2)
    expect(result.current.stats.sessions).toBe(2)
    expect(result.current.daily).toHaveLength(2)
    expect(result.current.models.map((m) => m.model).sort()).toEqual(["opus", "sonnet"])
  })

  it("keeps an empty table distinct from a not-yet-loaded one", () => {
    mockLiveQuery.mockReturnValue([])
    const { result } = renderHook(() => useActivityStats(30))
    expect(result.current.loading).toBe(false)
    expect(result.current.stats.turns).toBe(0)
  })

  it("cuts rows to the trailing window", () => {
    mockLiveQuery.mockReturnValue([
      row({ messageId: "old", at: at(1) }),
      row({ messageId: "new", at: at(20) }),
    ])
    const { result } = renderHook(() => useActivityStats(7))
    expect(result.current.stats.turns).toBe(1)
    expect(result.current.stats.activeDays).toBe(1)
  })

  it("widens the window when a longer range is requested", () => {
    mockLiveQuery.mockReturnValue([
      row({ messageId: "old", at: at(1) }),
      row({ messageId: "new", at: at(20) }),
    ])
    const { result } = renderHook(() => useActivityStats(30))
    expect(result.current.stats.turns).toBe(2)
  })

  it("pins `now` for the lifetime of the panel so the window cannot drift", () => {
    mockLiveQuery.mockReturnValue([row()])
    const { result, rerender } = renderHook(() => useActivityStats(7))
    const first = result.current.now
    // A later render must not re-read the clock — the heatmap grid and the row
    // filter would otherwise disagree about "today" mid-session.
    jest.spyOn(Date, "now").mockReturnValue(NOW + 5 * 86_400_000)
    rerender()
    expect(result.current.now).toBe(first)
  })
})
