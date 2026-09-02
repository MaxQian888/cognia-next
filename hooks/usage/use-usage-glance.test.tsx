/**
 * The scheduling policy is what these tests pin: local spend is reactive with
 * no polling, external scanning happens only in the all-tools scope, and a
 * disabled hook does nothing at all.
 */

const refreshExternalUsageIndex = jest.fn(async () => ({
  sources: [],
  startedAt: 0,
  finishedAt: 0,
}))
const resolveScanInput = jest.fn(async () => ({ fs: {}, home: "/h" }))
let liveRows: unknown[] | undefined = []
let liveStates: unknown[] = []

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (fn: () => unknown) => {
    // The two subscriptions are distinguished by call order inside the hook:
    // rows first, source states second. Both closures are inert here.
    void fn
    const call = (globalThis as { __liveCall?: number }).__liveCall ?? 0
    ;(globalThis as { __liveCall?: number }).__liveCall = call + 1
    return call % 2 === 0 ? liveRows : liveStates
  },
}))
jest.mock("@/lib/usage/external-usage-index", () => ({
  refreshExternalUsageIndex: (...a: unknown[]) => refreshExternalUsageIndex(...(a as [])),
}))
jest.mock("@/lib/session-import", () => ({
  resolveScanInput: (...a: unknown[]) => resolveScanInput(...(a as [])),
}))
jest.mock("@/lib/subscription/core/now-ticker", () => ({
  useSubscriptionNow: () => new Date(2026, 5, 5, 12, 0, 0).getTime(),
}))

import { act, renderHook, waitFor } from "@testing-library/react"

import { useUsageGlance } from "./use-usage-glance"
import type { SessionUsageRow } from "@/lib/db/session-usage"
import type { UsageGlanceQuery } from "@/lib/usage/usage-glance"

const NOON = new Date(2026, 5, 5, 12, 0, 0).getTime()

const row = (over: Partial<SessionUsageRow> = {}): SessionUsageRow => ({
  messageId: "m1",
  sessionId: "s1",
  at: NOON,
  model: "m",
  providerId: "p",
  inputTokens: 1000,
  outputTokens: 500,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  costUsd: 2,
  durationMs: 0,
  costSource: "sdk",
  costKnown: true,
  ...over,
})

const cognia: UsageGlanceQuery = { period: "today", scope: "cognia", metric: "spend" }
const allTools: UsageGlanceQuery = { ...cognia, scope: "all-tools" }

beforeEach(() => {
  refreshExternalUsageIndex.mockClear()
  resolveScanInput.mockClear()
  liveRows = []
  liveStates = []
  ;(globalThis as { __liveCall?: number }).__liveCall = 0
})

describe("useUsageGlance", () => {
  it("projects the live rows without any polling", () => {
    liveRows = [row(), row({ messageId: "m2" })]
    const { result } = renderHook(() => useUsageGlance({ query: cognia }))
    expect(result.current.snapshot?.knownCostUsd).toBeCloseTo(4, 6)
    expect(result.current.loading).toBe(false)
  })

  it("reports loading until the first read lands", () => {
    liveRows = undefined
    const { result } = renderHook(() => useUsageGlance({ query: cognia }))
    expect(result.current.snapshot).toBeNull()
    expect(result.current.loading).toBe(true)
  })

  it("is completely inert when disabled", async () => {
    const { result } = renderHook(() => useUsageGlance({ query: allTools, enabled: false }))
    expect(result.current.snapshot).toBeNull()
    expect(result.current.loading).toBe(false)
    await act(async () => {
      await result.current.refresh()
    })
    expect(refreshExternalUsageIndex).not.toHaveBeenCalled()
  })

  it("never touches the filesystem in the Cognia scope", async () => {
    renderHook(() => useUsageGlance({ query: cognia }))
    await act(async () => {})
    expect(refreshExternalUsageIndex).not.toHaveBeenCalled()
  })

  it("scans once on entering the all-tools scope", async () => {
    renderHook(() => useUsageGlance({ query: allTools }))
    await waitFor(() => expect(refreshExternalUsageIndex).toHaveBeenCalledTimes(1))
    // Not forced: the orchestrator's freshness TTL decides what to re-read.
    expect(refreshExternalUsageIndex.mock.calls[0][1]).toBeUndefined()
  })

  it("forces a re-read on an explicit refresh", async () => {
    const { result } = renderHook(() => useUsageGlance({ query: allTools }))
    await waitFor(() => expect(refreshExternalUsageIndex).toHaveBeenCalled())
    refreshExternalUsageIndex.mockClear()
    await act(async () => {
      await result.current.refresh()
    })
    expect(refreshExternalUsageIndex).toHaveBeenCalledWith(expect.anything(), { force: true })
  })

  it("single-flights concurrent refreshes", async () => {
    const { result } = renderHook(() => useUsageGlance({ query: allTools }))
    await waitFor(() => expect(refreshExternalUsageIndex).toHaveBeenCalled())
    refreshExternalUsageIndex.mockClear()
    await act(async () => {
      await Promise.all([result.current.refresh(), result.current.refresh()])
    })
    expect(refreshExternalUsageIndex).toHaveBeenCalledTimes(1)
  })

  it("survives a scan that throws, leaving the indexed rows in place", async () => {
    refreshExternalUsageIndex.mockRejectedValueOnce(new Error("disk gone"))
    liveRows = [row()]
    const { result } = renderHook(() => useUsageGlance({ query: allTools }))
    await act(async () => {})
    expect(result.current.snapshot?.knownCostUsd).toBeCloseTo(2, 6)
  })

  it("labels the all-tools answer partial when a source could not be read", async () => {
    liveRows = [row()]
    liveStates = [{ sourceId: "codex", status: "unavailable" }]
    const { result } = renderHook(() => useUsageGlance({ query: allTools }))
    await waitFor(() => expect(result.current.snapshot?.freshness).toBe("partial"))
  })

  it("calls the Cognia scope fresh, since nothing external is involved", () => {
    liveRows = [row()]
    const { result } = renderHook(() => useUsageGlance({ query: cognia }))
    expect(result.current.snapshot?.freshness).toBe("fresh")
  })

  it("passes the quota and budget folds straight through", () => {
    liveRows = []
    const { result } = renderHook(() =>
      useUsageGlance({
        query: cognia,
        quota: { worstUsedPct: 42, worstAccountKey: "a", resetAt: null },
        budget: { ratio: 0.5, target: "*", period: "day", blocked: false },
      })
    )
    expect(result.current.snapshot?.quota?.worstUsedPct).toBe(42)
    expect(result.current.snapshot?.budget?.ratio).toBe(0.5)
  })
})
