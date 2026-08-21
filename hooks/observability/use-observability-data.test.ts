import "fake-indexeddb/auto"
import { waitFor, renderHook } from "@testing-library/react"
import { useObservabilityData } from "./use-observability-data"
import { __clearAgentTracesForTesting, bulkInsertSpans } from "@/lib/db/agent-traces"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { customRange } from "@/lib/observability/time-range"
import { makeSpan } from "@/lib/observability/fixtures"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await __clearAgentTracesForTesting()
})

describe("useObservabilityData", () => {
  it("returns windowed spans and applies filters", async () => {
    await bulkInsertSpans([
      makeSpan({ id: "a", startTime: 100, surface: "chat" }),
      makeSpan({ id: "b", startTime: 200, surface: "workflow" }),
      makeSpan({ id: "c", startTime: 9999, surface: "chat" }),
    ])
    const range = customRange(0, 1000)
    const { result } = renderHook(() => useObservabilityData(range, { surface: ["chat"] }, 0))
    await waitFor(() => expect(result.current.loading).toBe(false))
    // windowSpans = a + b (c is outside window); filtered = a only
    expect(result.current.windowSpans.map((s) => s.id)).toEqual(["a", "b"])
    expect(result.current.spans.map((s) => s.id)).toEqual(["a"])
  })

  it("returns all window spans when filters are empty", async () => {
    await bulkInsertSpans([makeSpan({ id: "a", startTime: 100 })])
    const { result } = renderHook(() => useObservabilityData(customRange(0, 1000), {}, 0))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.spans).toHaveLength(1)
  })

  it("counts the whole window even when the read is capped", async () => {
    await bulkInsertSpans([
      makeSpan({ id: "a", startTime: 100 }),
      makeSpan({ id: "b", startTime: 200 }),
      makeSpan({ id: "c", startTime: 9999 }),
    ])
    const { result } = renderHook(() => useObservabilityData(customRange(0, 1000), {}, 0))
    await waitFor(() => expect(result.current.loading).toBe(false))
    await waitFor(() => expect(result.current.windowSpanCount).toBe(2))
    expect(result.current.spanCount).toBe(2)
    // Nothing was dropped, so the channel must not claim a partial answer.
    expect(result.current.truncated).toBe(false)
  })

  it("reports truncation when the window is bigger than the read cap", async () => {
    await bulkInsertSpans([
      makeSpan({ id: "a", startTime: 100 }),
      makeSpan({ id: "b", startTime: 200 }),
      makeSpan({ id: "c", startTime: 300 }),
    ])
    // The real cap is 20 000 rows; the hook's contract is "newest N, and say
    // so", which is what a tiny cap exercises without seeding 20k spans.
    const { result } = renderHook(() =>
      useObservabilityData(customRange(0, 1000), {}, 0, { limit: 2 })
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    await waitFor(() => expect(result.current.windowSpanCount).toBe(3))
    expect(result.current.spans.map((s) => s.id)).toEqual(["b", "c"])
    expect(result.current.truncated).toBe(true)
  })
})
