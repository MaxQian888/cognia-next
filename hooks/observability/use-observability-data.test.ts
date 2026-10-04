import "fake-indexeddb/auto"
import { act, waitFor, renderHook } from "@testing-library/react"

// Real Dexie reads, with both window reads wrapped so a test can make one fail.
jest.mock("@/lib/db/agent-traces", () => {
  const actual = jest.requireActual("@/lib/db/agent-traces")
  return {
    ...actual,
    queryByWindow: jest.fn(actual.queryByWindow),
    countByWindow: jest.fn(actual.countByWindow),
  }
})

import { SPAN_READ_CAP, useObservabilityData } from "./use-observability-data"
import {
  __clearAgentTracesForTesting,
  bulkInsertSpans,
  countByWindow,
  queryByWindow,
} from "@/lib/db/agent-traces"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { customRange } from "@/lib/observability/time-range"
import { makeSpan } from "@/lib/observability/fixtures"

const queryByWindowMock = queryByWindow as jest.MockedFunction<typeof queryByWindow>
const countByWindowMock = countByWindow as jest.MockedFunction<typeof countByWindow>

beforeEach(async () => {
  queryByWindowMock.mockClear()
  countByWindowMock.mockClear()
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

  it("reads with the production cap unless told otherwise", async () => {
    const { result } = renderHook(() => useObservabilityData(customRange(0, 1000), {}, 0))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(queryByWindowMock).toHaveBeenCalledWith({ since: 0, until: 1000, limit: SPAN_READ_CAP })
  })

  it("reports a failed window read as error instead of throwing, and retry recovers", async () => {
    await bulkInsertSpans([makeSpan({ id: "a", startTime: 100 })])
    queryByWindowMock.mockRejectedValueOnce(new Error("IDB blocked"))
    const { result } = renderHook(() => useObservabilityData(customRange(0, 1000), {}, 0))
    await waitFor(() => expect(result.current.error?.message).toBe("IDB blocked"))
    // Settled, not "loading forever", and no stale rows.
    expect(result.current.loading).toBe(false)
    expect(result.current.spans).toEqual([])
    expect(result.current.windowSpans).toEqual([])

    act(() => result.current.retry())
    await waitFor(() => expect(result.current.spans.map((s) => s.id)).toEqual(["a"]))
    expect(result.current.error).toBeNull()
    expect(queryByWindowMock).toHaveBeenCalledTimes(2)
  })

  it("reports a failed count as error too", async () => {
    await bulkInsertSpans([makeSpan({ id: "a", startTime: 100 })])
    countByWindowMock.mockRejectedValueOnce(new Error("count failed"))
    const { result } = renderHook(() => useObservabilityData(customRange(0, 1000), {}, 0))
    await waitFor(() => expect(result.current.error?.message).toBe("count failed"))
    expect(result.current.windowSpanCount).toBe(0)

    act(() => result.current.retry())
    await waitFor(() => expect(result.current.error).toBeNull())
    await waitFor(() => expect(result.current.windowSpanCount).toBe(1))
  })

  it("wraps a non-Error rejection in an Error", async () => {
    queryByWindowMock.mockRejectedValueOnce("quota exceeded")
    const { result } = renderHook(() => useObservabilityData(customRange(0, 1000), {}, 0))
    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error))
    expect(result.current.error?.message).toBe("quota exceeded")
  })

  it("keeps a stable retry callback", () => {
    const { result, rerender } = renderHook(() => useObservabilityData(customRange(0, 1000), {}, 0))
    const first = result.current.retry
    rerender()
    expect(result.current.retry).toBe(first)
  })
})
