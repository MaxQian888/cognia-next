/**
 * @jest-environment jsdom
 */
import { renderHook } from "@testing-library/react"

import type { SessionUsageRow } from "@/lib/db/session-usage"
import type { SessionUsageSummary } from "@/lib/usage/session-analytics"
import { useSessionCostRank } from "./use-session-cost-rank"

const live: { rows: SessionUsageRow[] | undefined; deps: unknown[] } = { rows: undefined, deps: [] }

jest.mock("@/hooks/data/use-client-live-query", () => ({
  useClientLiveQuery: (_q: unknown, deps: unknown[]) => {
    live.deps = deps
    return live.rows
  },
}))

jest.mock("@/lib/db/schema", () => ({ getDb: jest.fn() }))

function row(sessionId: string, costUsd: number, imported?: boolean): SessionUsageRow {
  return {
    messageId: `${sessionId}-${costUsd}`,
    sessionId,
    at: 1,
    inputTokens: 1,
    outputTokens: 1,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd,
    costSource: "sdk",
    costKnown: true,
    durationMs: 0,
    imported,
  }
}

const target: SessionUsageSummary = {
  sessionId: "me",
  turns: 3,
  tokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 3.5,
  unpricedTurns: 0,
}

const NOW = new Date(2026, 4, 20, 12).getTime()

beforeEach(() => {
  live.rows = undefined
})

describe("useSessionCostRank", () => {
  it("is null until the peer read answers", () => {
    const { result } = renderHook(() => useSessionCostRank(target, NOW))
    expect(result.current).toBeNull()
  })

  it("ranks the caller's summary against local peers, ignoring imported spend", () => {
    live.rows = [1, 2, 3, 4, 5].map((c) => row(`p${c}`, c)).concat(row("ext", 100, true))
    const { result } = renderHook(() => useSessionCostRank(target, NOW))
    expect(result.current).toEqual({ percentile: 60, peers: 5, medianUsd: 3 })
  })

  it("stays idle without a target", () => {
    live.rows = [row("p1", 1)]
    const { result } = renderHook(() => useSessionCostRank(null, NOW))
    expect(result.current).toBeNull()
    expect(live.deps[0]).toBe(false)
  })
})
