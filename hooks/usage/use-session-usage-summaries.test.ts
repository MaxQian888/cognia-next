/** @jest-environment jsdom */

import { renderHook } from "@testing-library/react"

import type { SessionUsageRow } from "@/lib/db/session-usage"

let usageRows: SessionUsageRow[] = []
const anyOfCalls: string[][] = []
jest.mock("@/hooks/data/use-client-live-query", () => ({
  useClientLiveQuery: (query: () => unknown, _deps: unknown[], initial: unknown) => {
    const out = query()
    return out instanceof Promise ? undefined : (out ?? initial)
  },
}))
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    sessionUsage: {
      where: (index: string) => ({
        anyOf: (ids: string[]) => {
          anyOfCalls.push(ids)
          return {
            toArray: () =>
              usageRows.filter((row) => index === "sessionId" && ids.includes(row.sessionId)),
          }
        },
      }),
    },
  }),
}))

import { useSessionUsageSummaries } from "./use-session-usage-summaries"

function row(sessionId: string, over: Partial<SessionUsageRow> = {}): SessionUsageRow {
  return {
    sessionId,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 10,
    cacheCreationTokens: 0,
    costUsd: 0.01,
    model: "claude-test",
    ...over,
  } as SessionUsageRow
}

beforeEach(() => {
  usageRows = []
  anyOfCalls.length = 0
})

describe("useSessionUsageSummaries", () => {
  it("reads only the rows of the conversations asked for", () => {
    usageRows = [row("a"), row("a"), row("b"), row("other")]
    const { result } = renderHook(() => useSessionUsageSummaries(["b", "a", "a"]))
    expect(anyOfCalls.at(-1)).toEqual(["a", "b"])
    const { summaries, loading } = result.current
    expect(loading).toBe(false)
    expect(summaries.get("a")?.turns).toBe(2)
    expect(summaries.get("a")?.tokens).toBe(320)
    expect(summaries.get("b")?.turns).toBe(1)
    expect(summaries.has("other")).toBe(false)
  })

  it("asks for nothing when there is nothing to show", () => {
    const { result } = renderHook(() => useSessionUsageSummaries([]))
    expect(anyOfCalls).toHaveLength(0)
    expect(result.current.summaries.size).toBe(0)
    expect(result.current.loading).toBe(false)
  })
})
