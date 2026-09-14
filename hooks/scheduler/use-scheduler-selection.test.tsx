import { act, renderHook } from "@testing-library/react"

const replace = jest.fn()
let searchParams = new URLSearchParams()
let pathname = "/scheduler"

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: (...args: unknown[]) => replace(...args) }),
  usePathname: () => pathname,
  useSearchParams: () => searchParams,
}))

import { useSchedulerSelection } from "./use-scheduler-selection"
import type { UnifiedScheduledItem } from "@/types/scheduler/unified"

function item(kind: UnifiedScheduledItem["kind"], sourceId: string): UnifiedScheduledItem {
  return {
    unifiedId: `${kind}:${sourceId}`,
    kind,
    sourceId,
    name: sourceId,
    status: "active",
    triggerSummary: { type: "cron" },
    origin: { deepLinkHref: "/scheduler" },
    capabilities: { runNow: true, pause: true, edit: true, delete: true },
  }
}

const items = [item("app", "t1"), item("system", "s1")]

beforeEach(() => {
  replace.mockClear()
  searchParams = new URLSearchParams()
  pathname = "/scheduler"
})

describe("useSchedulerSelection", () => {
  it("reads item and run from the address", () => {
    searchParams = new URLSearchParams("item=app:t1&run=app:r1")
    const { result } = renderHook(() => useSchedulerSelection(items, true))
    expect(result.current.itemId).toBe("app:t1")
    expect(result.current.runId).toBe("app:r1")
    expect(replace).not.toHaveBeenCalled()
  })

  it("writes selection with replace on the current pathname", () => {
    pathname = "/me/scheduler"
    const { result } = renderHook(() => useSchedulerSelection(items, true))
    act(() => result.current.selectItem("system:s1"))
    expect(replace).toHaveBeenLastCalledWith("/me/scheduler?item=system%3As1")
    act(() => result.current.openRun("app:r2"))
    expect(replace).toHaveBeenLastCalledWith("/me/scheduler?run=app%3Ar2")
    act(() => result.current.clear())
    expect(replace).toHaveBeenLastCalledWith("/me/scheduler")
  })

  it("selecting an item closes an open run", () => {
    searchParams = new URLSearchParams("run=app:r1")
    const { result } = renderHook(() => useSchedulerSelection(items, true))
    act(() => result.current.selectItem("app:t1"))
    expect(replace).toHaveBeenLastCalledWith("/scheduler?item=app%3At1")
  })

  it("resolves a legacy id against the items and rewrites the address", () => {
    searchParams = new URLSearchParams("taskId=t1")
    const { result } = renderHook(() => useSchedulerSelection(items, true))
    expect(result.current.itemId).toBe("app:t1")
    expect(replace).toHaveBeenCalledWith("/scheduler?item=app%3At1")
  })

  it("waits for the items before giving up on a legacy id", () => {
    searchParams = new URLSearchParams("systemTaskId=s1")
    const { result, rerender } = renderHook(
      ({ list, ready }: { list: UnifiedScheduledItem[]; ready: boolean }) =>
        useSchedulerSelection(list, ready),
      { initialProps: { list: [] as UnifiedScheduledItem[], ready: false } }
    )
    expect(result.current.itemId).toBeNull()
    expect(result.current.unresolvedLegacy).toBe(false)
    expect(replace).not.toHaveBeenCalled()
    rerender({ list: items, ready: true })
    expect(result.current.itemId).toBe("system:s1")
    expect(replace).toHaveBeenCalledWith("/scheduler?item=system%3As1")
  })

  it("drops a legacy id nothing matches once the items have loaded", () => {
    searchParams = new URLSearchParams("task=ghost")
    const { result } = renderHook(() => useSchedulerSelection(items, true))
    expect(result.current.itemId).toBeNull()
    expect(result.current.unresolvedLegacy).toBe(true)
    expect(replace).toHaveBeenCalledWith("/scheduler")
  })
})
