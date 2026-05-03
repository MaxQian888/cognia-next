/**
 * @jest-environment jsdom
 */

import { renderHook } from "@testing-library/react"
import type { PluginAnalyticsRow } from "@/lib/db/plugin-types"

let mockRows: PluginAnalyticsRow[] | undefined = undefined

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => mockRows,
}))

jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    pluginAnalytics: {
      orderBy: () => ({
        reverse: () => ({
          toArray: async () => mockRows ?? [],
        }),
      }),
    },
  }),
}))

import { usePluginAnalytics } from "./use-plugin-analytics"

beforeEach(() => {
  mockRows = undefined
})

describe("usePluginAnalytics", () => {
  it("reports loading=true while rows are undefined", () => {
    mockRows = undefined
    const { result } = renderHook(() => usePluginAnalytics())
    expect(result.current.loading).toBe(true)
    expect(result.current.byPlugin).toEqual([])
  })

  it("groups rows by pluginId and sums totals", () => {
    mockRows = [
      { pluginId: "a", key: "tool.invoke", count: 5, lastEventAt: 100 },
      { pluginId: "a", key: "hook.dispatch", count: 2, lastEventAt: 200 },
      { pluginId: "b", key: "tool.invoke", count: 7, lastEventAt: 50 },
    ]
    const { result } = renderHook(() => usePluginAnalytics())
    expect(result.current.loading).toBe(false)
    expect(result.current.byPlugin).toHaveLength(2)
    const a = result.current.byPlugin.find((p) => p.pluginId === "a")
    expect(a?.totalEvents).toBe(7)
    expect(a?.lastEventAt).toBe(200)
    expect(a?.byKey["tool.invoke"]).toEqual({ count: 5, lastEventAt: 100 })
  })

  it("sorts byPlugin most-recent-first", () => {
    mockRows = [
      { pluginId: "old", key: "k", count: 1, lastEventAt: 10 },
      { pluginId: "new", key: "k", count: 1, lastEventAt: 1000 },
      { pluginId: "mid", key: "k", count: 1, lastEventAt: 500 },
    ]
    const { result } = renderHook(() => usePluginAnalytics())
    expect(result.current.byPlugin.map((p) => p.pluginId)).toEqual(["new", "mid", "old"])
  })

  it("rows are passed through unchanged for raw consumers", () => {
    mockRows = [
      { pluginId: "x", key: "k1", count: 3, lastEventAt: 1 },
      { pluginId: "x", key: "k2", count: 4, lastEventAt: 2 },
    ]
    const { result } = renderHook(() => usePluginAnalytics())
    expect(result.current.rows).toBe(mockRows)
  })
})
