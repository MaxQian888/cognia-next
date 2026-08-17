/**
 * @jest-environment jsdom
 */

import { renderHook, act } from "@testing-library/react"
import type { PluginRow } from "@/lib/db/plugin-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const mockRows: PluginRow[] = [
  makePlugin({ id: "a", status: "enabled", enabled: true }),
  makePlugin({ id: "b", status: "enabled", enabled: true, manifest: { updateAvailable: true } }),
  makePlugin({
    id: "c",
    status: "disabled",
    enabled: false,
    manifest: { configSchema: { type: "object" } },
  }),
  makePlugin({ id: "d", status: "error", enabled: false, error: "boom" }),
]

jest.mock("@/hooks/plugins", () => ({
  usePlugins: () => ({
    all: mockRows,
    filtered: mockRows,
    countsBySource: {},
    countsByCapability: {},
    countsByStatus: {},
    totals: {
      total: mockRows.length,
      enabled: 2,
      errored: 1,
      loading: 0,
      updateAvailable: 1,
    },
    loading: false,
  }),
}))

import { usePluginsStore } from "@/stores/plugins"
import { useLibrarySubFilterSegments, deriveActiveSubFilter } from "./plugin-library-sub-filter"

function makePlugin(overrides: Partial<PluginRow> = {}): PluginRow {
  return {
    id: overrides.id ?? "default",
    name: "Plugin",
    version: "1.0.0",
    status: "enabled",
    source: "marketplace",
    type: "frontend",
    enabled: true,
    capabilities: [],
    path: "/plugins/x",
    manifest: { id: overrides.id ?? "default" },
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

beforeEach(() => {
  usePluginsStore.setState({
    librarySubFilter: "all",
    filters: {
      ...usePluginsStore.getState().filters,
      status: "all",
      hasUpdate: false,
      configurable: false,
    },
  })
})

describe("useLibrarySubFilterSegments", () => {
  it("emits all 5 segments in config order", () => {
    const { result } = renderHook(() => useLibrarySubFilterSegments())
    expect(result.current.items.map((s) => s.value)).toEqual([
      "all",
      "enabled",
      "updates",
      "configurable",
      "errored",
    ])
  })

  it("attaches the live count to every segment", () => {
    const { result } = renderHook(() => useLibrarySubFilterSegments())
    const counts = Object.fromEntries(result.current.items.map((s) => [s.value, s.count]))
    // Fixture: 2 enabled, 1 with updateAvailable, 1 with configSchema, 1 errored.
    expect(counts).toEqual({ all: 4, enabled: 2, updates: 1, configurable: 1, errored: 1 })
  })

  // Counts are what let `visibleSegments` drop the dead filters, so a
  // segment arriving without one would silently make it unhideable.
  it("never emits an undefined count (the zero-count rule reads them)", () => {
    const { result } = renderHook(() => useLibrarySubFilterSegments())
    for (const segment of result.current.items) {
      expect(typeof segment.count).toBe("number")
    }
  })

  it("onSelect writes both the sub-filter and the derived filters", () => {
    const { result } = renderHook(() => useLibrarySubFilterSegments())
    act(() => result.current.onSelect("configurable"))
    expect(usePluginsStore.getState().librarySubFilter).toBe("configurable")
    expect(usePluginsStore.getState().filters.configurable).toBe(true)
  })

  // The active value comes from `filters`, never from `librarySubFilter` —
  // so the filter sheet moving an axis directly still lights the segment.
  it("derives the active value from filters, not from the stored sub-filter", () => {
    usePluginsStore.setState({
      librarySubFilter: "all",
      filters: { ...usePluginsStore.getState().filters, hasUpdate: true },
    })
    const { result } = renderHook(() => useLibrarySubFilterSegments())
    expect(result.current.value).toBe("updates")
  })

  it("emits an empty active value for a custom sheet status so nothing is falsely lit", () => {
    usePluginsStore.setState({
      filters: { ...usePluginsStore.getState().filters, status: "disabled" },
    })
    const { result } = renderHook(() => useLibrarySubFilterSegments())
    expect(result.current.value).toBe("")
  })

  it("labels the group with the Library section name", () => {
    const { result } = renderHook(() => useLibrarySubFilterSegments())
    expect(result.current.ariaLabel).toBe("library")
  })
})

describe("deriveActiveSubFilter (single source of truth)", () => {
  const base = { configurable: false, hasUpdate: false, status: "all" }
  it("maps configurable first", () => {
    expect(deriveActiveSubFilter({ ...base, configurable: true })).toBe("configurable")
  })
  it("maps hasUpdate to 'updates'", () => {
    expect(deriveActiveSubFilter({ ...base, hasUpdate: true })).toBe("updates")
  })
  it("maps status enabled / error", () => {
    expect(deriveActiveSubFilter({ ...base, status: "enabled" })).toBe("enabled")
    expect(deriveActiveSubFilter({ ...base, status: "error" })).toBe("errored")
  })
  it("maps the all-clear filters to 'all'", () => {
    expect(deriveActiveSubFilter(base)).toBe("all")
  })
  it("returns '' for a custom status set via the filter sheet (no chip)", () => {
    expect(deriveActiveSubFilter({ ...base, status: "disabled" })).toBe("")
  })
})
