/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import { renderHook, act, waitFor } from "@testing-library/react"

import { useAgentTraceAnalytics } from "./use-agent-trace-analytics"
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

describe("useAgentTraceAnalytics", () => {
  it("returns null summary when sessionId is absent", async () => {
    const { result } = renderHook(() => useAgentTraceAnalytics())
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.sessionSummary).toBeNull()
    expect(result.current.error).toBeNull()
  })

  it("aggregates spans for a session and exposes a refresh no-op", async () => {
    await bulkInsertSpans([
      span({
        id: "a",
        sessionId: "s1",
        operationName: "execute_tool",
        toolName: "list_files",
        startTime: 100,
        endTime: 150,
        durationMs: 50,
        costUsdEstimate: 0.001,
      }),
      span({
        id: "b",
        sessionId: "s1",
        operationName: "execute_tool",
        startTime: 200,
        endTime: 250,
        durationMs: 50,
        errorType: "tool_error",
        errorMessage: "boom",
      }),
      span({
        id: "c",
        sessionId: "s2",
        operationName: "invoke_agent",
        startTime: 1000,
        durationMs: 50,
      }),
    ])
    const { result } = renderHook(() => useAgentTraceAnalytics({ sessionId: "s1" }))
    await waitFor(() => expect(result.current.sessionSummary).not.toBeNull())
    const summary = result.current.sessionSummary!
    expect(summary.toolCallCount).toBe(2)
    expect(summary.toolFailureCount).toBe(1)
    expect(summary.totalCost).toBeCloseTo(0.001)
    expect(summary.eventTypeCounts.execute_tool).toBe(2)

    await act(async () => {
      await result.current.refresh()
    })
    // refresh is a no-op; summary stays.
    expect(result.current.sessionSummary).toBe(summary)
  })

  it("returns null and stays not-loading when autoLoad is false", async () => {
    await bulkInsertSpans([span({ id: "a", sessionId: "s1", operationName: "execute_tool" })])
    const { result } = renderHook(() =>
      useAgentTraceAnalytics({ sessionId: "s1", autoLoad: false })
    )
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.sessionSummary).toBeNull()
  })

  it("re-emits when new spans land for the watched session", async () => {
    const { result } = renderHook(() => useAgentTraceAnalytics({ sessionId: "s1" }))
    await waitFor(() => expect(result.current.sessionSummary).not.toBeNull())
    expect(result.current.sessionSummary?.toolCallCount).toBe(0)
    await act(async () => {
      await bulkInsertSpans([
        span({
          id: "tool",
          sessionId: "s1",
          operationName: "execute_tool",
          durationMs: 10,
          endTime: 100,
          startTime: 90,
        }),
      ])
    })
    await waitFor(() => expect(result.current.sessionSummary?.toolCallCount).toBe(1))
  })
})
