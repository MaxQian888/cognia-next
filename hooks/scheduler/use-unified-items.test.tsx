/** @jest-environment jsdom */

import { act, renderHook } from "@testing-library/react"
import { useUnifiedScheduledItems } from "./use-unified-items"
import { createSchedulerSourceRegistry } from "@/lib/scheduler/sources/registry"
import type {
  ScheduledItemSource,
  ScheduledItemSourceObserver,
} from "@/lib/scheduler/sources/types"
import type { ScheduledItemKind, UnifiedScheduledItem } from "@/types/scheduler/unified"

function makeUnified(
  kind: ScheduledItemKind,
  id: string,
  overrides: Partial<UnifiedScheduledItem> = {}
): UnifiedScheduledItem {
  return {
    unifiedId: `${kind}:${id}`,
    kind,
    sourceId: id,
    name: `${kind} ${id}`,
    status: "active",
    triggerSummary: { type: "cron", cron: "* * * * *" },
    nextRunAt: 1000,
    origin: { deepLinkHref: "/" },
    capabilities: { runNow: true, pause: true, edit: true, delete: true },
    ...overrides,
  }
}

function makeControlledSource(kind: ScheduledItemKind): {
  source: ScheduledItemSource
  emit: (items: UnifiedScheduledItem[]) => void
  fail: (err: unknown) => void
  unsubscribed: { value: boolean }
} {
  let activeObserver: ScheduledItemSourceObserver | null = null
  const unsubscribed = { value: false }
  return {
    source: {
      kind,
      subscribe(observer) {
        activeObserver = observer
        return {
          unsubscribe() {
            unsubscribed.value = true
            activeObserver = null
          },
        }
      },
      async list() {
        return []
      },
      async get() {
        return undefined
      },
      async create() {
        throw new Error("not impl")
      },
      async update() {},
      async delete() {},
      async pause() {},
      async resume() {},
      async runNow() {},
    },
    emit(items) {
      activeObserver?.next(items)
    },
    fail(err) {
      activeObserver?.error?.(err)
    },
    unsubscribed,
  }
}

describe("useUnifiedScheduledItems", () => {
  it("merges items from every registered source, sorted by compareUnifiedItems", () => {
    const registry = createSchedulerSourceRegistry()
    const appStub = makeControlledSource("app")
    const workflowStub = makeControlledSource("workflow")
    registry.register(appStub.source)
    registry.register(workflowStub.source)

    const { result } = renderHook(() => useUnifiedScheduledItems({ registry }))

    act(() => {
      appStub.emit([
        makeUnified("app", "a", { nextRunAt: 500 }),
        makeUnified("app", "b", { nextRunAt: 200 }),
      ])
      workflowStub.emit([makeUnified("workflow", "x", { nextRunAt: 300 })])
    })

    const ids = result.current.items.map((i) => i.unifiedId)
    expect(ids).toEqual(["app:b", "workflow:x", "app:a"])
  })

  it("captures per-source errors without breaking the merged list", () => {
    const registry = createSchedulerSourceRegistry()
    const appStub = makeControlledSource("app")
    const pluginStub = makeControlledSource("plugin")
    registry.register(appStub.source)
    registry.register(pluginStub.source)

    const { result } = renderHook(() => useUnifiedScheduledItems({ registry }))

    act(() => {
      appStub.emit([makeUnified("app", "a")])
      pluginStub.fail(new Error("plugin store offline"))
    })

    expect(result.current.items.map((i) => i.unifiedId)).toEqual(["app:a"])
    expect(result.current.errors.plugin).toBeInstanceOf(Error)
    expect(result.current.errors.app).toBeUndefined()
  })

  it("computes per-kind counts + active counts", () => {
    const registry = createSchedulerSourceRegistry()
    const app = makeControlledSource("app")
    const workflow = makeControlledSource("workflow")
    registry.register(app.source)
    registry.register(workflow.source)

    const { result } = renderHook(() => useUnifiedScheduledItems({ registry }))

    act(() => {
      app.emit([
        makeUnified("app", "1", { status: "active" }),
        makeUnified("app", "2", { status: "paused" }),
        makeUnified("app", "3", { status: "active" }),
      ])
      workflow.emit([makeUnified("workflow", "w1", { status: "disabled" })])
    })

    expect(result.current.countsByKind.app).toBe(3)
    expect(result.current.activeCountsByKind.app).toBe(2)
    expect(result.current.countsByKind.workflow).toBe(1)
    expect(result.current.activeCountsByKind.workflow).toBe(0)
  })

  it("unsubscribes every source on unmount", () => {
    const registry = createSchedulerSourceRegistry()
    const app = makeControlledSource("app")
    const plugin = makeControlledSource("plugin")
    registry.register(app.source)
    registry.register(plugin.source)

    const { unmount } = renderHook(() => useUnifiedScheduledItems({ registry }))
    unmount()
    expect(app.unsubscribed.value).toBe(true)
    expect(plugin.unsubscribed.value).toBe(true)
  })

  it("returns an empty list when no sources are registered", () => {
    const registry = createSchedulerSourceRegistry()
    const { result } = renderHook(() => useUnifiedScheduledItems({ registry }))
    expect(result.current.items).toEqual([])
    expect(result.current.countsByKind.app).toBe(0)
  })
})
