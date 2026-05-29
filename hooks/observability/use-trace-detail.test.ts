import "fake-indexeddb/auto"
import { waitFor, renderHook } from "@testing-library/react"
import { useTraceDetail } from "./use-trace-detail"
import { __clearAgentTracesForTesting, bulkInsertSpans } from "@/lib/db/agent-traces"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { makeSpan } from "@/lib/observability/fixtures"

beforeEach(async () => {
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
  })
})
