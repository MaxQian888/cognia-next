import "fake-indexeddb/auto"
import { act, waitFor, renderHook } from "@testing-library/react"

// Real Dexie reads, with `queryByTrace` wrapped so a test can make one fail.
jest.mock("@/lib/db/agent-traces", () => {
  const actual = jest.requireActual("@/lib/db/agent-traces")
  return { ...actual, queryByTrace: jest.fn(actual.queryByTrace) }
})

import { useTraceDetail } from "./use-trace-detail"
import { __clearAgentTracesForTesting, bulkInsertSpans, queryByTrace } from "@/lib/db/agent-traces"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { makeSpan } from "@/lib/observability/fixtures"

const queryByTraceMock = queryByTrace as jest.MockedFunction<typeof queryByTrace>

beforeEach(async () => {
  queryByTraceMock.mockClear()
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await __clearAgentTracesForTesting()
})

describe("useTraceDetail", () => {
  it("returns an empty waterfall when no trace is selected", async () => {
    const { result } = renderHook(() => useTraceDetail(null))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.waterfall.roots).toEqual([])
    // No selection is not "not found".
    expect(result.current.notFound).toBe(false)
    expect(result.current.error).toBeNull()
    expect(queryByTraceMock).not.toHaveBeenCalled()
  })

  it("builds a waterfall for a selected trace", async () => {
    await bulkInsertSpans([
      makeSpan({ traceId: "t1", spanId: "root", startTime: 1000, durationMs: 500 }),
      makeSpan({
        traceId: "t1",
        spanId: "child",
        parentSpanId: "root",
        startTime: 1100,
        durationMs: 100,
      }),
    ])
    const { result } = renderHook(() => useTraceDetail("t1"))
    await waitFor(() => expect(result.current.waterfall.roots.length).toBe(1))
    expect(result.current.waterfall.roots[0].children).toHaveLength(1)
    expect(result.current.notFound).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it("reports notFound for a selected id with no persisted spans", async () => {
    await bulkInsertSpans([makeSpan({ traceId: "other", spanId: "x" })])
    const { result } = renderHook(() => useTraceDetail("pruned"))
    await waitFor(() => expect(result.current.notFound).toBe(true))
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
    expect(result.current.waterfall.roots).toEqual([])
  })

  it("does not claim notFound while the read is in flight", () => {
    const { result } = renderHook(() => useTraceDetail("t1"))
    expect(result.current.loading).toBe(true)
    expect(result.current.notFound).toBe(false)
  })

  it("reports a failed read as error instead of throwing, and retry recovers", async () => {
    await bulkInsertSpans([makeSpan({ traceId: "t1", spanId: "root" })])
    queryByTraceMock.mockRejectedValueOnce(new Error("IDB blocked"))
    const { result } = renderHook(() => useTraceDetail("t1"))
    await waitFor(() => expect(result.current.error?.message).toBe("IDB blocked"))
    expect(result.current.loading).toBe(false)
    // A failed read is not evidence the trace is missing.
    expect(result.current.notFound).toBe(false)
    expect(result.current.waterfall.roots).toEqual([])

    act(() => result.current.retry())
    await waitFor(() => expect(result.current.waterfall.roots.length).toBe(1))
    expect(result.current.error).toBeNull()
    expect(queryByTraceMock).toHaveBeenCalledTimes(2)
  })

  it("wraps a non-Error rejection in an Error", async () => {
    queryByTraceMock.mockRejectedValueOnce("quota exceeded")
    const { result } = renderHook(() => useTraceDetail("t1"))
    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error))
    expect(result.current.error?.message).toBe("quota exceeded")
  })

  it("keeps a stable retry callback", () => {
    const { result, rerender } = renderHook(() => useTraceDetail(null))
    const first = result.current.retry
    rerender()
    expect(result.current.retry).toBe(first)
  })
})
