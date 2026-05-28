/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import { act, renderHook, waitFor } from "@testing-library/react"
import { useAgentTraceAsLogs } from "./use-agent-trace-logs"
import { __clearAgentTracesForTesting, bulkInsertSpans } from "@/lib/db/agent-traces"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import type { AgentTraceSpan } from "@/types/agent-trace/span"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await __clearAgentTracesForTesting()
})

function span(over: Partial<AgentTraceSpan>): AgentTraceSpan {
  const id = over.id ?? "span-" + Math.random().toString(36).slice(2, 8)
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

describe("useAgentTraceAsLogs", () => {
  it("returns the empty list before any rows exist", async () => {
    const { result } = renderHook(() => useAgentTraceAsLogs())
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.logs).toEqual([])
    expect(result.current.error).toBeNull()
  })

  it("returns spans converted to StructuredLogEntry shape, newest-first", async () => {
    await bulkInsertSpans([
      span({ id: "a", startTime: 100 }),
      span({ id: "b", startTime: 200 }),
      span({ id: "c", startTime: 50 }),
    ])
    const { result } = renderHook(() => useAgentTraceAsLogs())
    await waitFor(() => expect(result.current.logs.length).toBe(3))
    expect(result.current.logs.map((l) => l.id)).toEqual(["b", "a", "c"])
    expect(result.current.logs[0].module).toBe("agent.trace")
  })

  it("returns empty array when enabled=false", async () => {
    await bulkInsertSpans([span({ id: "a", startTime: 1 })])
    const { result } = renderHook(() => useAgentTraceAsLogs({ enabled: false }))
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.logs).toEqual([])
  })

  it("respects maxLogs", async () => {
    await bulkInsertSpans([
      span({ id: "a", startTime: 1 }),
      span({ id: "b", startTime: 2 }),
      span({ id: "c", startTime: 3 }),
    ])
    const { result } = renderHook(() => useAgentTraceAsLogs({ maxLogs: 2 }))
    await waitFor(() => expect(result.current.logs.length).toBe(2))
    expect(result.current.logs.map((l) => l.id)).toEqual(["c", "b"])
  })

  it("clamps invalid maxLogs to default", async () => {
    await bulkInsertSpans([span({ id: "a", startTime: 1 })])
    const { result } = renderHook(() => useAgentTraceAsLogs({ maxLogs: -1 }))
    await waitFor(() => expect(result.current.logs.length).toBe(1))
  })

  it("re-renders when new spans are inserted (live query)", async () => {
    const { result } = renderHook(() => useAgentTraceAsLogs())
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.logs).toEqual([])
    await act(async () => {
      await bulkInsertSpans([span({ id: "live", startTime: 500 })])
    })
    await waitFor(() => expect(result.current.logs.length).toBe(1))
    expect(result.current.logs[0].id).toBe("live")
  })

  it("keeps logs referentially stable when nothing changes", async () => {
    await bulkInsertSpans([span({ id: "a", startTime: 1 })])
    const { result, rerender } = renderHook(() => useAgentTraceAsLogs())
    await waitFor(() => expect(result.current.logs.length).toBe(1))
    const first = result.current.logs
    rerender()
    expect(result.current.logs).toBe(first)
  })
})
