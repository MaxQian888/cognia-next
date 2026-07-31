/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
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
import { PluginLibrarySubFilter, deriveActiveSubFilter } from "./plugin-library-sub-filter"

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
  usePluginsStore.setState({ librarySubFilter: "all" })
})

describe("PluginLibrarySubFilter", () => {
  it("renders all 5 chip values from the config", () => {
    render(<PluginLibrarySubFilter />)
    for (const label of ["all", "enabled", "updates", "configurable", "errored"]) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
  })

  it("renders the live counts for each sub-filter", () => {
    render(<PluginLibrarySubFilter />)
    expect(screen.getByText("4")).toBeInTheDocument() // total
    // Two enabled rows
    const enabledCount = screen.getAllByText("2")
    expect(enabledCount.length).toBeGreaterThan(0)
    // One row with updateAvailable, one with configSchema, one with error
    const onePeerCount = screen.getAllByText("1")
    expect(onePeerCount.length).toBeGreaterThanOrEqual(3)
  })

  it("clicking a chip updates the store + filters", () => {
    render(<PluginLibrarySubFilter />)
    fireEvent.click(screen.getByText("configurable"))
    expect(usePluginsStore.getState().librarySubFilter).toBe("configurable")
    expect(usePluginsStore.getState().filters.configurable).toBe(true)
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
