/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const mockUsePlugins = jest.fn()
jest.mock("@/hooks/plugins", () => ({
  usePlugins: () => mockUsePlugins(),
}))

import { usePluginsStore, DEFAULT_PLUGIN_FILTERS } from "@/stores/plugins"
import { PluginLibraryStatusBar } from "./plugin-library-status-bar"

const emptyTotals = { total: 0, enabled: 0, errored: 0, loading: 0, updateAvailable: 0 }

beforeEach(() => {
  usePluginsStore.setState({
    filters: { ...DEFAULT_PLUGIN_FILTERS },
    librarySubFilter: "all",
  })
  mockUsePlugins.mockReset()
  // Default: not loading, no filtering active (filtered === total).
  mockUsePlugins.mockReturnValue({
    all: [],
    filtered: [],
    totals: emptyTotals,
    loading: false,
  })
})

describe("PluginLibraryStatusBar", () => {
  // The strip must leave no trace on the unfiltered view — it is `empty:hidden`
  // precisely so the band (and its border) vanishes instead of sitting there.
  it("renders an empty strip when nothing is filtered", () => {
    render(<PluginLibraryStatusBar />)
    const bar = screen.getByTestId("plugin-library-status-bar")
    expect(bar).toBeEmptyDOMElement()
    expect(bar.className).toContain("empty:hidden")
  })

  it("shows the active-filter chips inside the strip", () => {
    usePluginsStore.setState({
      filters: { ...DEFAULT_PLUGIN_FILTERS, capability: "tools" },
    })
    render(<PluginLibraryStatusBar />)
    const bar = screen.getByTestId("plugin-library-status-bar")
    expect(bar).not.toBeEmptyDOMElement()
    expect(screen.getByTestId("plugin-active-filter-capability")).toBeInTheDocument()
  })

  it("hides the result count when filters are inactive (filtered === total)", () => {
    mockUsePlugins.mockReturnValue({
      all: [],
      filtered: [{ id: "a" }, { id: "b" }],
      totals: { ...emptyTotals, total: 2, enabled: 2 },
      loading: false,
    })
    render(<PluginLibraryStatusBar />)
    expect(screen.queryByTestId("plugin-library-result-count")).not.toBeInTheDocument()
  })

  it("renders 'X of Y plugins' when filtering reduces visible rows", () => {
    mockUsePlugins.mockReturnValue({
      all: [],
      filtered: [{ id: "a" }],
      totals: { ...emptyTotals, total: 3, enabled: 1 },
      loading: false,
    })
    render(<PluginLibraryStatusBar />)
    const count = screen.getByTestId("plugin-library-result-count")
    expect(count).toBeInTheDocument()
    expect(count.textContent).toContain("resultsCount")
    expect(count.textContent).toContain('"count":1')
    expect(count.textContent).toContain('"total":3')
  })

  it("renders the no-match message when filters yield zero results", () => {
    mockUsePlugins.mockReturnValue({
      all: [],
      filtered: [],
      totals: { ...emptyTotals, total: 5 },
      loading: false,
    })
    render(<PluginLibraryStatusBar />)
    const count = screen.getByTestId("plugin-library-result-count")
    expect(count.textContent).toContain("resultsCountEmpty")
    expect(count.textContent).toContain('"total":5')
  })

  it("hides the result count during loading even if filtered.length differs", () => {
    mockUsePlugins.mockReturnValue({
      all: [],
      filtered: [],
      totals: emptyTotals,
      loading: true,
    })
    render(<PluginLibraryStatusBar />)
    expect(screen.queryByTestId("plugin-library-result-count")).not.toBeInTheDocument()
  })
})
