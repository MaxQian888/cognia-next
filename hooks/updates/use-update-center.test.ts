/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react"

import type { UpdateItem } from "@/lib/updates/adapter"
import type { UpdateCoordinator } from "@/lib/updates/coordinator"

import { useUpdateCenter } from "./use-update-center"

function item(overrides: Partial<UpdateItem> = {}): UpdateItem {
  return {
    key: "desktop:app",
    assetId: "app",
    kind: "desktop",
    executor: "tauri",
    state: "available",
    candidate: {
      assetId: "app",
      kind: "desktop",
      executor: "tauri",
      currentVersion: "1.0.0",
      targetVersion: "1.1.0",
      channel: "stable",
      criticality: "routine",
      source: "catalog",
      provenance: "verified",
    },
    currentVersion: "1.0.0",
    action: "install-in-app",
    externallyInstalled: false,
    ...overrides,
  }
}

function fakeCoordinator(items: UpdateItem[]) {
  const listeners = new Set<() => void>()
  let current = items
  const calls: string[] = []
  const coordinator = {
    subscribe: (l: () => void) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    getItems: () => current,
    check: async () => {
      calls.push("check")
      return current
    },
    apply: async (key: string) => {
      calls.push(`apply:${key}`)
      return current[0]
    },
    skip: async (key: string) => {
      calls.push(`skip:${key}`)
      return true
    },
    defer: async (key: string) => {
      calls.push(`defer:${key}`)
      return true
    },
    clearHold: async (key: string) => {
      calls.push(`clear:${key}`)
    },
  } as unknown as UpdateCoordinator
  return {
    coordinator,
    calls,
    emit(next: UpdateItem[]) {
      current = next
      for (const l of listeners) l()
    },
  }
}

describe("useUpdateCenter", () => {
  it("groups rows the way the Update Center renders them", () => {
    const { coordinator } = fakeCoordinator([
      item(),
      item({ key: "plugin:a", kind: "plugin", executor: "plugin-runtime" }),
      item({ key: "browser-chrome:x", kind: "browser-chrome", executor: "browser-store" }),
    ])
    const { result } = renderHook(() => useUpdateCenter(coordinator))
    expect(result.current.groups.map((g) => g.group)).toEqual([
      "apps-and-runtimes",
      "extensions",
      "plugins-and-content",
    ])
  })

  it("omits a group with no rows", () => {
    const { coordinator } = fakeCoordinator([item()])
    const { result } = renderHook(() => useUpdateCenter(coordinator))
    expect(result.current.groups).toHaveLength(1)
  })

  it("counts only rows the user can act on", () => {
    const { coordinator } = fakeCoordinator([
      item(),
      item({ key: "plugin:a", kind: "plugin", state: "current", candidate: null }),
      item({ key: "skill:b", kind: "skill", state: "deferred" }),
    ])
    const { result } = renderHook(() => useUpdateCenter(coordinator))
    expect(result.current.actionable.map((i) => i.key)).toEqual(["desktop:app"])
  })

  it("separates critical rows", () => {
    const critical = item({ key: "desktop:app" })
    critical.candidate = { ...critical.candidate!, criticality: "critical" }
    const { coordinator } = fakeCoordinator([critical])
    const { result } = renderHook(() => useUpdateCenter(coordinator))
    expect(result.current.critical).toHaveLength(1)
  })

  it("re-renders when the coordinator emits", () => {
    const fake = fakeCoordinator([item()])
    const { result } = renderHook(() => useUpdateCenter(fake.coordinator))
    expect(result.current.items).toHaveLength(1)
    act(() => fake.emit([]))
    expect(result.current.items).toHaveLength(0)
  })

  it("reports checking while any row is mid-check", () => {
    const { coordinator } = fakeCoordinator([item({ state: "checking" })])
    const { result } = renderHook(() => useUpdateCenter(coordinator))
    expect(result.current.checking).toBe(true)
  })

  it("forwards every action to the coordinator", async () => {
    const fake = fakeCoordinator([item()])
    const { result } = renderHook(() => useUpdateCenter(fake.coordinator))
    await act(async () => {
      await result.current.check()
      await result.current.apply("desktop:app")
      await result.current.skip("desktop:app")
      await result.current.defer("desktop:app")
      await result.current.clearHold("desktop:app")
    })
    expect(fake.calls).toEqual([
      "check",
      "apply:desktop:app",
      "skip:desktop:app",
      "defer:desktop:app",
      "clear:desktop:app",
    ])
  })
})
