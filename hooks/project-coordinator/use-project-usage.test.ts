/** @jest-environment jsdom */
import { renderHook } from "@testing-library/react"
import type { ChatSession } from "@cognia/agent-config-types"
import type { SessionUsageRow } from "@/lib/db/session-usage"

const liveResult: { value: unknown } = { value: undefined }
const queries: Array<() => Promise<unknown>> = []

jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: (query: () => Promise<unknown>) => {
    queries.push(query)
    return liveResult.value
  },
}))

const listUsage = jest.fn()
const getSessions = jest.fn()
jest.mock("@/lib/db/session-usage", () => ({
  listLocalUsageForProjectSince: (...args: unknown[]) => listUsage(...args),
}))
jest.mock("@/lib/db/sessions", () => ({
  getSessionsByIds: (...args: unknown[]) => getSessions(...args),
}))

import {
  projectUsageWindowStart,
  summarizeProjectUsage,
  useProjectUsage,
} from "./use-project-usage"

function row(id: string, sessionId: string, over: Partial<SessionUsageRow> = {}): SessionUsageRow {
  return {
    messageId: id,
    sessionId,
    at: new Date(2026, 8, 20, 10).getTime(),
    model: "claude-sonnet-5",
    inputTokens: 100,
    outputTokens: 50,
    cacheCreationTokens: 0,
    cacheReadTokens: 10,
    costUsd: 0.5,
    costKnown: true,
    costSource: "sdk",
    durationMs: 0,
    ...over,
  }
}

beforeEach(() => {
  liveResult.value = undefined
  queries.length = 0
  listUsage.mockReset()
  getSessions.mockReset()
})

describe("projectUsageWindowStart", () => {
  it("opens the window at local midnight, counting today as one day", () => {
    const now = new Date(2026, 8, 29, 15, 30).getTime()
    expect(projectUsageWindowStart(now, 1)).toBe(new Date(2026, 8, 29).getTime())
    expect(projectUsageWindowStart(now, 30)).toBe(new Date(2026, 7, 31).getTime())
    expect(projectUsageWindowStart(now, 0)).toBe(new Date(2026, 8, 29).getTime())
  })
})

describe("summarizeProjectUsage", () => {
  it("totals, buckets by session and model, and indexes the sessions", () => {
    const usage = summarizeProjectUsage(
      [
        row("a", "s1"),
        row("b", "s1", { costUsd: 1 }),
        row("c", "s2", { model: "claude-haiku-4-5" }),
      ],
      [{ id: "s1", title: "Coordinator", projectRole: "coordinator" } as ChatSession]
    )
    expect(usage.totals).toMatchObject({ costUsd: 2, turns: 3, unpricedTurns: 0 })
    expect(usage.totals.tokens).toBe(480)
    expect(usage.bySession.map((s) => s.sessionId)).toEqual(["s1", "s2"])
    expect(usage.byModel.map((m) => m.model)).toEqual(["claude-sonnet-5", "claude-haiku-4-5"])
    expect(usage.daily).toHaveLength(1)
    expect(usage.sessions.get("s1")?.title).toBe("Coordinator")
  })

  it("is all zero for an empty window", () => {
    expect(summarizeProjectUsage([], []).totals).toEqual({
      costUsd: 0,
      turns: 0,
      tokens: 0,
      unpricedTurns: 0,
    })
  })
})

describe("useProjectUsage", () => {
  it("is undefined while loading", () => {
    const { result } = renderHook(() => useProjectUsage("p1", 30, Date.now()))
    expect(result.current).toBeUndefined()
  })

  it("reads the project's window and the sessions it names", async () => {
    const now = new Date(2026, 8, 29, 12).getTime()
    listUsage.mockResolvedValue([row("a", "s1"), row("b", "s1")])
    getSessions.mockResolvedValue([])
    liveResult.value = { rows: [row("a", "s1")], sessions: [] }
    const { result } = renderHook(() => useProjectUsage("p1", 30, now))
    expect(result.current?.totals.turns).toBe(1)
    await expect(queries[0]()).resolves.toMatchObject({ sessions: [] })
    expect(listUsage).toHaveBeenCalledWith("p1", projectUsageWindowStart(now, 30))
    expect(getSessions).toHaveBeenCalledWith(["s1"])
  })
})
