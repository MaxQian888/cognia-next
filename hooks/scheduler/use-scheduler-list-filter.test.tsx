import { act, renderHook } from "@testing-library/react"

import { useSchedulerListFilter } from "./use-scheduler-list-filter"
import { useSchedulerStore } from "@/stores/scheduler/scheduler-store"
import type { UnifiedScheduledItem } from "@/types/scheduler/unified"

function item(
  kind: UnifiedScheduledItem["kind"],
  name: string,
  extra: Partial<UnifiedScheduledItem> = {}
): UnifiedScheduledItem {
  return {
    unifiedId: `${kind}:${name}`,
    kind,
    sourceId: name,
    name,
    status: "active",
    triggerSummary: { type: "cron" },
    origin: { deepLinkHref: "/scheduler" },
    capabilities: { runNow: true, pause: true, edit: true, delete: true },
    ...extra,
  }
}

const items = [
  item("app", "nightly build", { projectId: "p1" }),
  item("app", "loop poll", { tags: ["loop"], status: "paused" }),
  item("workflow", "deploy"),
  item("backup", "backup"),
]

beforeEach(() => {
  useSchedulerStore.getState().resetListFilter()
})

describe("useSchedulerListFilter", () => {
  it("starts unfiltered and counts every kind", () => {
    const { result } = renderHook(() => useSchedulerListFilter(items, undefined))
    expect(result.current.isFiltering).toBe(false)
    expect(result.current.facets.visibleItems).toHaveLength(4)
    expect(result.current.facets.countsByKind.app).toBe(2)
    expect(result.current.facets.loopCount).toBe(1)
  })

  it("narrows through the store so a second consumer sees the same rows", () => {
    const first = renderHook(() => useSchedulerListFilter(items, undefined))
    const second = renderHook(() => useSchedulerListFilter(items, undefined))
    act(() => first.result.current.setStatus("paused"))
    expect(second.result.current.facets.visibleItems.map((i) => i.name)).toEqual(["loop poll"])
    act(() => first.result.current.toggleKind("workflow"))
    expect(second.result.current.kinds.has("workflow")).toBe(true)
    expect(second.result.current.facets.visibleItems).toEqual([])
    act(() => first.result.current.clearKindFilters())
    expect(second.result.current.kinds.size).toBe(0)
    act(() => first.result.current.setSearch("loop"))
    act(() => first.result.current.setLoopOnly(true))
    expect(second.result.current.isFiltering).toBe(true)
    act(() => first.result.current.reset())
    expect(second.result.current.isFiltering).toBe(false)
    expect(second.result.current.facets.visibleItems).toHaveLength(4)
  })

  it("scopes to the workspace but keeps unattributed rows", () => {
    const { result } = renderHook(() => useSchedulerListFilter(items, "p2"))
    expect(result.current.facets.visibleItems.map((i) => i.name)).toEqual([
      "loop poll",
      "deploy",
      "backup",
    ])
  })
})
