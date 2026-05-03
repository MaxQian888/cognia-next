/**
 * @jest-environment jsdom
 */

import { renderHook } from "@testing-library/react"
import { act } from "react"
import type { PluginRow } from "@/lib/db/plugin-types"

let mockRows: PluginRow[] | undefined = undefined

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => mockRows,
}))

jest.mock("@/lib/db/plugins", () => ({
  listPlugins: jest.fn(() => Promise.resolve(mockRows ?? [])),
}))

import { usePlugins } from "./use-plugins"
import { usePluginsStore, DEFAULT_PLUGIN_FILTERS } from "@/stores/plugins"

function row(over: Partial<PluginRow>): PluginRow {
  return {
    id: "p_" + (over.name ?? "x"),
    name: over.name ?? "x",
    version: over.version ?? "1.0.0",
    status: over.status ?? "enabled",
    source: over.source ?? "builtin",
    type: over.type ?? "frontend",
    enabled: over.enabled ?? true,
    capabilities: over.capabilities ?? ["tools"],
    path: over.path ?? "builtin://x",
    manifest: over.manifest ?? { id: "p_" + (over.name ?? "x") },
    config: over.config,
    error: over.error,
    lastUsedAt: over.lastUsedAt,
    createdAt: over.createdAt ?? 1,
    updatedAt: over.updatedAt ?? 1,
  }
}

beforeEach(() => {
  mockRows = undefined
  usePluginsStore.setState({
    activeTab: "installed",
    filters: DEFAULT_PLUGIN_FILTERS,
    selection: new Set(),
    detailPluginId: null,
    filterSheetOpen: false,
    configTarget: null,
    importStaging: null,
    deleteTarget: null,
    permissionReviewTarget: null,
    conflictDialogTarget: null,
  })
})

describe("usePlugins", () => {
  it("reports loading=true while rows are undefined", () => {
    mockRows = undefined
    const { result } = renderHook(() => usePlugins())
    expect(result.current.loading).toBe(true)
    expect(result.current.all).toEqual([])
    expect(result.current.totals.total).toBe(0)
  })

  it("aggregates totals and per-source / per-capability counts", () => {
    mockRows = [
      row({ name: "alpha", source: "builtin", capabilities: ["tools", "commands"] }),
      row({
        name: "beta",
        source: "marketplace",
        status: "error",
        enabled: false,
        capabilities: ["themes"],
      }),
      row({
        name: "gamma",
        source: "marketplace",
        status: "loading",
        capabilities: ["tools"],
      }),
    ]
    const { result } = renderHook(() => usePlugins())
    expect(result.current.totals).toEqual({
      total: 3,
      enabled: 2,
      errored: 1,
      loading: 1,
      updateAvailable: 0,
    })
    expect(result.current.countsBySource).toEqual({ builtin: 1, marketplace: 2 })
    expect(result.current.countsByCapability.tools).toBe(2)
    expect(result.current.countsByCapability.commands).toBe(1)
    expect(result.current.countsByCapability.themes).toBe(1)
  })

  it("filters by capability", () => {
    mockRows = [
      row({ name: "a", capabilities: ["tools"] }),
      row({ name: "b", capabilities: ["themes"] }),
    ]
    act(() => usePluginsStore.getState().setFilters({ capability: "themes" }))
    const { result } = renderHook(() => usePlugins())
    expect(result.current.filtered).toHaveLength(1)
    expect(result.current.filtered[0]?.name).toBe("b")
  })

  it("filters by required permission via manifest.permissions", () => {
    mockRows = [
      row({
        name: "a",
        manifest: { id: "a", permissions: ["clipboard:read"] },
      }),
      row({ name: "b", manifest: { id: "b", permissions: ["network:fetch"] } }),
    ]
    act(() => usePluginsStore.getState().setFilters({ permission: "network:fetch" }))
    const { result } = renderHook(() => usePlugins())
    expect(result.current.filtered).toHaveLength(1)
    expect(result.current.filtered[0]?.name).toBe("b")
  })

  it("filters by signed-only and hasUpdate", () => {
    mockRows = [
      row({ name: "a", manifest: { id: "a", signature: { verified: true } } }),
      row({ name: "b", manifest: { id: "b" } }),
      row({ name: "c", manifest: { id: "c", updateAvailable: true } }),
    ]
    act(() => usePluginsStore.getState().setFilters({ signedOnly: true }))
    const { result } = renderHook(() => usePlugins())
    expect(result.current.filtered.map((r) => r.name)).toEqual(["a"])

    act(() => usePluginsStore.getState().setFilters({ signedOnly: false, hasUpdate: true }))
    const { result: result2 } = renderHook(() => usePlugins())
    expect(result2.current.filtered.map((r) => r.name)).toEqual(["c"])
  })

  it("text query matches name / id / manifest.description", () => {
    mockRows = [
      row({
        name: "Alpha",
        manifest: { id: "alpha", description: "first plugin" },
      }),
      row({
        name: "Beta",
        manifest: { id: "beta", description: "another extension" },
      }),
    ]
    act(() => usePluginsStore.getState().setFilters({ query: "First" }))
    const { result } = renderHook(() => usePlugins())
    expect(result.current.filtered).toHaveLength(1)
    expect(result.current.filtered[0]?.name).toBe("Alpha")
  })

  it("sort by name (default)", () => {
    mockRows = [row({ name: "Charlie" }), row({ name: "Alpha" }), row({ name: "Bravo" })]
    const { result } = renderHook(() => usePlugins())
    expect(result.current.filtered.map((r) => r.name)).toEqual(["Alpha", "Bravo", "Charlie"])
  })

  it("sort by updated descending", () => {
    mockRows = [row({ name: "old", updatedAt: 1 }), row({ name: "new", updatedAt: 100 })]
    act(() => usePluginsStore.getState().setFilters({ sort: "updated" }))
    const { result } = renderHook(() => usePlugins())
    expect(result.current.filtered.map((r) => r.name)).toEqual(["new", "old"])
  })

  it("sort by rating descending", () => {
    mockRows = [
      row({ name: "low", manifest: { id: "low", rating: 2 } }),
      row({ name: "high", manifest: { id: "high", rating: 5 } }),
    ]
    act(() => usePluginsStore.getState().setFilters({ sort: "rating" }))
    const { result } = renderHook(() => usePlugins())
    expect(result.current.filtered.map((r) => r.name)).toEqual(["high", "low"])
  })
})
