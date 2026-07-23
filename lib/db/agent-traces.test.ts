/** @jest-environment jsdom */
// Coverage for the agent-trace span CRUD + aggregator layer.

import "fake-indexeddb/auto"
import {
  __clearAgentTracesForTesting,
  aggregateAll,
  aggregateBySession,
  aggregateStatsAll,
  aggregateStatsBySession,
  bulkInsertSpans,
  clearAllSpans,
  countAllSpans,
  deleteSpansForSession,
  insertSpan,
  pruneOlderThan,
  queryBySession,
  queryByTrace,
  queryByWindow,
  queryRecent,
  queryRecentTraces,
  countTraces,
} from "./agent-traces"
import { __resetDbForTesting, getDb, whenSeeded } from "./schema"
import type { AgentTraceSpan } from "@/types/agent-trace/span"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await __clearAgentTracesForTesting()
  // Cold-opening the (now high-version) Dexie schema under fake-indexeddb can
  // exceed the default 5s hook budget on the first test — give it room.
}, 30_000)

function span(over: Partial<AgentTraceSpan>): AgentTraceSpan {
  const id = over.id ?? over.spanId ?? "span-" + Math.random().toString(36).slice(2, 10)
  return {
    id,
    spanId: id,
    traceId: "trace-1",
    startTime: 0,
    operationName: "invoke_agent",
    providerName: "anthropic",
    sessionId: "s1",
    surface: "chat",
    ...over,
  }
}

describe("insertSpan", () => {
  it("writes a span and round-trips", async () => {
    await insertSpan(span({ id: "a", sessionId: "s1", startTime: 100 }))
    const rows = await queryBySession("s1")
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe("a")
  })

  it("is idempotent on id (second insert overwrites)", async () => {
    await insertSpan(span({ id: "a", costUsdEstimate: 0.01 }))
    await insertSpan(span({ id: "a", costUsdEstimate: 0.05 }))
    const rows = await queryBySession("s1")
    expect(rows).toHaveLength(1)
    expect(rows[0].costUsdEstimate).toBe(0.05)
  })

  it("ignores rows without an id", async () => {
    await insertSpan({ ...span({}), id: "" })
    const all = await getDb().agentTraces.toArray()
    expect(all).toHaveLength(0)
  })
})

describe("bulkInsertSpans", () => {
  it("writes multiple spans", async () => {
    await bulkInsertSpans([
      span({ id: "a", startTime: 1 }),
      span({ id: "b", startTime: 2 }),
      span({ id: "c", startTime: 3 }),
    ])
    const rows = await queryBySession("s1")
    expect(rows.map((r) => r.id)).toEqual(["c", "b", "a"])
  })

  it("no-ops on empty input", async () => {
    await bulkInsertSpans([])
    expect((await getDb().agentTraces.toArray()).length).toBe(0)
  })
})

describe("queryBySession", () => {
  beforeEach(async () => {
    await bulkInsertSpans([
      span({ id: "a", sessionId: "s1", startTime: 1 }),
      span({ id: "b", sessionId: "s1", startTime: 2 }),
      span({ id: "c", sessionId: "s2", startTime: 3 }),
    ])
  })

  it("returns rows sorted newest-first", async () => {
    const rows = await queryBySession("s1")
    expect(rows.map((r) => r.id)).toEqual(["b", "a"])
  })

  it("scopes to the requested session", async () => {
    const rows = await queryBySession("s2")
    expect(rows.map((r) => r.id)).toEqual(["c"])
  })

  it("returns [] for an empty / unknown session", async () => {
    expect(await queryBySession("")).toEqual([])
    expect(await queryBySession("unknown")).toEqual([])
  })

  it("respects the limit argument", async () => {
    const rows = await queryBySession("s1", 1)
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe("b")
  })
})

describe("queryRecent", () => {
  it("returns the N most-recent spans newest-first across sessions", async () => {
    await bulkInsertSpans([
      span({ id: "a", sessionId: "s1", startTime: 10 }),
      span({ id: "b", sessionId: "s2", startTime: 50 }),
      span({ id: "c", sessionId: "s1", startTime: 30 }),
      span({ id: "d", sessionId: "s2", startTime: 70 }),
    ])
    const recent = await queryRecent(3)
    expect(recent.map((r) => r.id)).toEqual(["d", "b", "c"])
  })

  it("returns [] for non-positive limits", async () => {
    await bulkInsertSpans([span({ id: "a", startTime: 1 })])
    expect(await queryRecent(0)).toEqual([])
    expect(await queryRecent(-5)).toEqual([])
  })
})

describe("queryByTrace", () => {
  it("returns spans for a trace ordered oldest-first", async () => {
    await bulkInsertSpans([
      span({ id: "child", traceId: "t1", startTime: 200, parentSpanId: "root" }),
      span({ id: "root", traceId: "t1", startTime: 100 }),
    ])
    const rows = await queryByTrace("t1")
    expect(rows.map((r) => r.id)).toEqual(["root", "child"])
  })

  it("returns [] for empty traceId", async () => {
    expect(await queryByTrace("")).toEqual([])
  })
})

describe("queryByWindow", () => {
  beforeEach(async () => {
    await bulkInsertSpans([
      span({ id: "a", startTime: 100 }),
      span({ id: "b", startTime: 500 }),
      span({ id: "c", startTime: 900 }),
    ])
  })

  it("returns spans in [since, until] oldest-first", async () => {
    const rows = await queryByWindow({ since: 200, until: 900 })
    expect(rows.map((r) => r.id)).toEqual(["b", "c"])
  })

  it("treats until as open-ended when omitted", async () => {
    const rows = await queryByWindow({ since: 0 })
    expect(rows.map((r) => r.id)).toEqual(["a", "b", "c"])
  })

  it("returns [] when the window excludes everything", async () => {
    expect(await queryByWindow({ since: 5000 })).toEqual([])
  })
})

describe("aggregateBySession", () => {
  it("returns zeros on empty input", async () => {
    const summary = await aggregateBySession("nope")
    expect(summary).toEqual({
      totalCost: 0,
      toolCallCount: 0,
      toolFailureCount: 0,
      avgLatencyMs: 0,
      eventTypeCounts: {},
    })
  })

  it("returns zeros on empty sessionId arg", async () => {
    const summary = await aggregateBySession("")
    expect(summary.totalCost).toBe(0)
  })

  it("computes totals, latencies, failures, and timestamps", async () => {
    await bulkInsertSpans([
      span({
        id: "turn",
        operationName: "invoke_agent",
        startTime: 1_000,
        endTime: 1_300,
        durationMs: 300,
        costUsdEstimate: 0.01,
      }),
      span({
        id: "tool-ok",
        operationName: "execute_tool",
        toolName: "list_files",
        startTime: 1_100,
        endTime: 1_150,
        durationMs: 50,
        costUsdEstimate: 0.001,
      }),
      span({
        id: "tool-fail",
        operationName: "execute_tool",
        toolName: "fetch",
        startTime: 1_200,
        endTime: 1_250,
        durationMs: 50,
        errorType: "tool_error",
        errorMessage: "boom",
      }),
    ])
    const summary = await aggregateBySession("s1")
    expect(summary.totalCost).toBeCloseTo(0.011)
    expect(summary.toolCallCount).toBe(2)
    expect(summary.toolFailureCount).toBe(1)
    expect(summary.avgLatencyMs).toBeCloseTo((300 + 50 + 50) / 3)
    expect(summary.firstTimestamp).toBe(1_000)
    expect(summary.lastTimestamp).toBe(1_300)
    expect(summary.eventTypeCounts).toEqual({ invoke_agent: 1, execute_tool: 2 })
  })

  it("uses startTime as lastTimestamp when endTime is missing", async () => {
    await insertSpan(span({ id: "live", startTime: 500 }))
    const summary = await aggregateBySession("s1")
    expect(summary.lastTimestamp).toBe(500)
  })
})

describe("aggregateAll", () => {
  it("aggregates across every session", async () => {
    await bulkInsertSpans([
      span({
        id: "a",
        sessionId: "s1",
        costUsdEstimate: 0.1,
        durationMs: 100,
        endTime: 100,
        startTime: 0,
      }),
      span({
        id: "b",
        sessionId: "s2",
        costUsdEstimate: 0.2,
        durationMs: 200,
        endTime: 200,
        startTime: 0,
      }),
    ])
    const summary = await aggregateAll()
    expect(summary.totalCost).toBeCloseTo(0.3)
    expect(summary.avgLatencyMs).toBeCloseTo(150)
  })
})

describe("aggregateStatsAll", () => {
  it("returns zeroed stats when no spans exist", async () => {
    const s = await aggregateStatsAll()
    expect(s.totalSpans).toBe(0)
    expect(s.totalInputTokens).toBe(0)
    expect(s.cacheHitRate).toBe(0)
    expect(s.byModel).toEqual({})
    expect(s.bySurface).toEqual({})
  })

  it("aggregates tokens, cache hit rate, per-model + per-surface counts", async () => {
    await bulkInsertSpans([
      span({
        id: "a",
        operationName: "invoke_agent",
        surface: "chat",
        startTime: 1000,
        endTime: 1100,
        durationMs: 100,
        requestModel: "opus",
        responseModel: "opus",
        costUsdEstimate: 0.05,
        usage: {
          inputTokens: 100,
          outputTokens: 30,
          cacheCreationTokens: 0,
          cacheReadTokens: 200,
        },
      }),
      span({
        id: "b",
        operationName: "invoke_agent",
        surface: "agent-team",
        startTime: 1200,
        endTime: 1300,
        durationMs: 100,
        requestModel: "haiku",
        responseModel: "haiku",
        usage: {
          inputTokens: 50,
          outputTokens: 10,
          cacheCreationTokens: 0,
          cacheReadTokens: 50,
        },
      }),
      span({
        id: "c",
        operationName: "execute_tool",
        surface: "chat",
        startTime: 1400,
        endTime: 1410,
        durationMs: 10,
        errorType: "tool_error",
        errorMessage: "boom",
      }),
    ])
    const s = await aggregateStatsAll()
    expect(s.totalSpans).toBe(3)
    expect(s.totalInputTokens).toBe(150)
    expect(s.totalOutputTokens).toBe(40)
    expect(s.totalCacheReadTokens).toBe(250)
    expect(s.errorCount).toBe(1)
    expect(s.cacheHitRate).toBeCloseTo(250 / (150 + 250))
    expect(s.byModel.opus.spans).toBe(1)
    expect(s.byModel.opus.costUsd).toBeCloseTo(0.05)
    expect(s.byModel.haiku.spans).toBe(1)
    expect(s.byModel["(unknown)"].spans).toBe(1)
    expect(s.bySurface.chat).toBe(2)
    expect(s.bySurface["agent-team"]).toBe(1)
  })

  it("respects the `since` window", async () => {
    await bulkInsertSpans([
      span({
        id: "old",
        startTime: 100,
        usage: { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0 },
      }),
      span({
        id: "new",
        startTime: 5000,
        usage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 },
      }),
    ])
    const s = await aggregateStatsAll({ since: 1000 })
    expect(s.totalSpans).toBe(1)
    expect(s.totalInputTokens).toBe(100)
  })
})

describe("aggregateStatsBySession", () => {
  it("scopes to one session", async () => {
    await bulkInsertSpans([
      span({
        id: "a",
        sessionId: "s1",
        usage: { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0 },
      }),
      span({
        id: "b",
        sessionId: "s2",
        usage: { inputTokens: 99, outputTokens: 9, cacheCreationTokens: 0, cacheReadTokens: 0 },
      }),
    ])
    const s = await aggregateStatsBySession("s1")
    expect(s.totalSpans).toBe(1)
    expect(s.totalInputTokens).toBe(10)
  })

  it("returns the empty summary for an empty sessionId", async () => {
    const s = await aggregateStatsBySession("")
    expect(s.totalSpans).toBe(0)
  })
})

describe("deleteSpansForSession", () => {
  it("drops only the matching session", async () => {
    await bulkInsertSpans([span({ id: "a", sessionId: "s1" }), span({ id: "b", sessionId: "s2" })])
    await deleteSpansForSession("s1")
    const remaining = await getDb().agentTraces.toArray()
    expect(remaining.map((r) => r.id)).toEqual(["b"])
  })

  it("no-ops on empty sessionId", async () => {
    await bulkInsertSpans([span({ id: "a" })])
    await deleteSpansForSession("")
    expect((await getDb().agentTraces.toArray()).length).toBe(1)
  })
})

describe("pruneOlderThan", () => {
  it("deletes rows older than the cutoff and returns the count", async () => {
    await bulkInsertSpans([
      span({ id: "old", startTime: 100 }),
      span({ id: "newish", startTime: 1_000 }),
    ])
    const deleted = await pruneOlderThan(500)
    expect(deleted).toBe(1)
    const remaining = await getDb().agentTraces.toArray()
    expect(remaining.map((r) => r.id)).toEqual(["newish"])
  })

  it("returns 0 for non-finite or non-positive cutoff", async () => {
    expect(await pruneOlderThan(0)).toBe(0)
    expect(await pruneOlderThan(Number.NaN)).toBe(0)
  })
})

describe("countAllSpans / clearAllSpans", () => {
  it("counts every stored span", async () => {
    expect(await countAllSpans()).toBe(0)
    await bulkInsertSpans([span({ id: "a" }), span({ id: "b" })])
    expect(await countAllSpans()).toBe(2)
  })

  it("clears all spans and returns how many were removed", async () => {
    await bulkInsertSpans([span({ id: "a" }), span({ id: "b" }), span({ id: "c" })])
    const removed = await clearAllSpans()
    expect(removed).toBe(3)
    expect(await countAllSpans()).toBe(0)
  })

  it("returns 0 when clearing an empty table", async () => {
    expect(await clearAllSpans()).toBe(0)
  })
})

describe("queryRecentTraces", () => {
  /** One chatty trace (many spans) plus several quiet ones. */
  async function seed() {
    await bulkInsertSpans([
      // trace-chatty: 5 spans, most recent overall
      ...Array.from({ length: 5 }, (_, i) =>
        span({ id: `chatty-${i}`, traceId: "trace-chatty", sessionId: "s1", startTime: 100 + i })
      ),
      span({ id: "q1", traceId: "trace-b", sessionId: "s2", startTime: 50 }),
      span({ id: "q2", traceId: "trace-c", sessionId: "s3", startTime: 30 }),
      span({ id: "q3", traceId: "trace-d", sessionId: "s4", startTime: 10 }),
    ])
  }

  it("counts TRACES, not spans", async () => {
    // `queryRecent(2)` returns two spans of the chatty trace, so anything that
    // groups by trace afterwards sees a single row. This is the bug that
    // collapsed the eval trace-analysis list.
    await seed()
    expect(new Set((await queryRecent(2)).map((r) => r.traceId)).size).toBe(1)
    expect(new Set((await queryRecentTraces(2)).map((r) => r.traceId)).size).toBe(2)
  })

  it("returns every span of each selected trace, newest trace first", async () => {
    await seed()
    const rows = await queryRecentTraces(2)
    expect(rows.filter((r) => r.traceId === "trace-chatty")).toHaveLength(5)
    expect(rows.filter((r) => r.traceId === "trace-b")).toHaveLength(1)
    expect(rows[0].traceId).toBe("trace-chatty")
  })

  it("pages by trace", async () => {
    await seed()
    const page2 = await queryRecentTraces(2, 2)
    expect(new Set(page2.map((r) => r.traceId))).toEqual(new Set(["trace-c", "trace-d"]))
  })

  it("returns nothing past the end, or for a zero limit", async () => {
    await seed()
    expect(await queryRecentTraces(2, 99)).toEqual([])
    expect(await queryRecentTraces(0)).toEqual([])
  })

  it("counts distinct traces", async () => {
    expect(await countTraces()).toBe(0)
    await seed()
    expect(await countTraces()).toBe(4)
  })
})
