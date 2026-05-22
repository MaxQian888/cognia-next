/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

// Toolbar pulls Tauri/native bridges + URL dialogs we don't care about
// here — stub it so this test focuses on the search + filter + toggle
// composition.
jest.mock("../plugin-panel-toolbar", () => ({
  PluginPanelToolbar: () => <div data-testid="plugin-panel-toolbar" />,
}))
jest.mock("../plugin-category-sheet", () => ({
  PluginCategorySheet: ({ className }: { className?: string }) => (
    <div data-testid="plugin-category-sheet" className={className} />
  ),
}))
jest.mock("./plugin-library-sub-filter", () => ({
  PluginLibrarySubFilter: () => <div data-testid="plugin-library-sub-filter" />,
}))
jest.mock("./plugin-library-view-toggle", () => ({
  PluginLibraryViewToggle: () => <div data-testid="plugin-library-view-toggle" />,
}))

const mockUsePlugins = jest.fn()
jest.mock("@/hooks/plugins", () => ({
  usePlugins: () => mockUsePlugins(),
}))

import { usePluginsStore } from "@/stores/plugins"
import { PluginLibraryHeader } from "./plugin-library-header"

beforeEach(() => {
  usePluginsStore.setState({
    filters: { ...usePluginsStore.getState().filters, query: "" },
    filterSheetOpen: false,
  })
  mockUsePlugins.mockReset()
  // Default: not loading, no filtering active (filtered === total).
  mockUsePlugins.mockReturnValue({
    filtered: [],
    totals: { total: 0, enabled: 0, errored: 0, loading: 0, updateAvailable: 0 },
    loading: false,
  })
})

describe("PluginLibraryHeader", () => {
  it("renders the search input bound to filters.query", () => {
    render(<PluginLibraryHeader />)
    const input = screen.getByPlaceholderText("searchPlaceholder")
    fireEvent.change(input, { target: { value: "hello" } })
    expect(usePluginsStore.getState().filters.query).toBe("hello")
  })

  it("clicking the filter button opens the filter sheet", () => {
    render(<PluginLibraryHeader />)
    fireEvent.click(screen.getByTestId("plugin-library-filters-trigger"))
    expect(usePluginsStore.getState().filterSheetOpen).toBe(true)
  })

  it("renders the view toggle, sub-filter chips, and toolbar slots", () => {
    render(<PluginLibraryHeader />)
    expect(screen.getByTestId("plugin-library-view-toggle")).toBeInTheDocument()
    expect(screen.getByTestId("plugin-library-sub-filter")).toBeInTheDocument()
    expect(screen.getByTestId("plugin-panel-toolbar")).toBeInTheDocument()
  })

  it("renders the capability sheet trigger gated to lg:hidden so the rail is only fallback for narrow viewports", () => {
    render(<PluginLibraryHeader />)
    const sheet = screen.getByTestId("plugin-category-sheet")
    expect(sheet.className).toContain("lg:hidden")
  })

  it("hides the result count when filters are inactive (filtered === total)", () => {
    mockUsePlugins.mockReturnValue({
      filtered: [{ id: "a" }, { id: "b" }],
      totals: { total: 2, enabled: 2, errored: 0, loading: 0, updateAvailable: 0 },
      loading: false,
    })
    render(<PluginLibraryHeader />)
    expect(screen.queryByTestId("plugin-library-result-count")).not.toBeInTheDocument()
  })

  it("renders 'X of Y plugins' when filtering reduces visible rows", () => {
    mockUsePlugins.mockReturnValue({
      filtered: [{ id: "a" }],
      totals: { total: 3, enabled: 1, errored: 0, loading: 0, updateAvailable: 0 },
      loading: false,
    })
    render(<PluginLibraryHeader />)
    const count = screen.getByTestId("plugin-library-result-count")
    expect(count).toBeInTheDocument()
    expect(count.textContent).toContain("resultsCount")
    expect(count.textContent).toContain('"count":1')
    expect(count.textContent).toContain('"total":3')
  })

  it("renders the no-match message when filters yield zero results", () => {
    mockUsePlugins.mockReturnValue({
      filtered: [],
      totals: { total: 5, enabled: 0, errored: 0, loading: 0, updateAvailable: 0 },
      loading: false,
    })
    render(<PluginLibraryHeader />)
    const count = screen.getByTestId("plugin-library-result-count")
    expect(count.textContent).toContain("resultsCountEmpty")
    expect(count.textContent).toContain('"total":5')
  })

  it("hides the result count during loading even if filtered.length differs", () => {
    mockUsePlugins.mockReturnValue({
      filtered: [],
      totals: { total: 0, enabled: 0, errored: 0, loading: 0, updateAvailable: 0 },
      loading: true,
    })
    render(<PluginLibraryHeader />)
    expect(screen.queryByTestId("plugin-library-result-count")).not.toBeInTheDocument()
  })
})
