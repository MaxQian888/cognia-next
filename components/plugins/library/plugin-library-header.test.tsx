/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

jest.mock("../dialogs/plugin-category-sheet", () => ({
  PluginCategorySheet: ({ className }: { className?: string }) => (
    <div data-testid="plugin-category-sheet" className={className} />
  ),
}))
// `useLibrarySubFilterSegments` is deliberately NOT mocked — it reads the
// same `usePlugins()` mock below, so letting it run proves the status axis
// actually reaches the toolbar's segments slot (and that the zero-count
// rule applies to it) instead of just proving a stub rendered.
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
    all: [],
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

  it("renders the view toggle", () => {
    render(<PluginLibraryHeader />)
    expect(screen.getByTestId("plugin-library-view-toggle")).toBeInTheDocument()
  })

  // The status axis is a segmented control in the toolbar now, not a chip
  // row in the status line and not sub-items in the left rail.
  it("puts the status filters in the toolbar's segments slot", () => {
    mockUsePlugins.mockReturnValue({
      all: [
        { id: "a", status: "enabled", manifest: {} },
        { id: "b", status: "error", manifest: {} },
      ],
      filtered: [],
      totals: { total: 2, enabled: 1, errored: 1, loading: 0, updateAvailable: 0 },
      loading: false,
    })
    render(<PluginLibraryHeader />)
    expect(screen.getByTestId("plugin-library-sub-all")).toBeInTheDocument()
    expect(screen.getByTestId("plugin-library-sub-enabled")).toBeInTheDocument()
    expect(screen.getByTestId("plugin-library-sub-errored")).toBeInTheDocument()
  })

  it("drops the zero-count status segments and keeps the active one", () => {
    usePluginsStore.setState({
      filters: {
        ...usePluginsStore.getState().filters,
        status: "all",
        hasUpdate: false,
        configurable: false,
      },
    })
    // Empty library → every count is 0, so only the derived-active "all"
    // segment survives `visibleSegments`.
    render(<PluginLibraryHeader />)
    expect(screen.getByTestId("plugin-library-sub-all")).toBeInTheDocument()
    for (const dead of ["enabled", "updates", "configurable", "errored"]) {
      expect(screen.queryByTestId(`plugin-library-sub-${dead}`)).not.toBeInTheDocument()
    }
  })

  it("renders the first-class Sort control reflecting filters.sort", () => {
    usePluginsStore.setState({
      filters: { ...usePluginsStore.getState().filters, sort: "updated" },
    })
    render(<PluginLibraryHeader />)
    const sort = screen.getByTestId("plugin-library-sort")
    expect(sort).toBeInTheDocument()
    // The trigger shows the active sort mode's label (sortMode.updated).
    expect(sort.textContent).toContain("sortMode.updated")
  })

  // Radix Select checks pointer-event detail, so fireEvent.click never opens
  // it — this has to go through userEvent (jest-gotchas #4).
  it("writes the picked sort mode back to the store", async () => {
    const user = userEvent.setup()
    usePluginsStore.setState({
      filters: { ...usePluginsStore.getState().filters, sort: "name" },
    })
    render(<PluginLibraryHeader />)
    await user.click(screen.getByTestId("plugin-library-sort"))
    await user.click(await screen.findByRole("option", { name: "sortMode.usage" }))
    expect(usePluginsStore.getState().filters.sort).toBe("usage")
  })

  it("renders the capability sheet trigger gated to lg:hidden so the rail is only fallback for narrow viewports", () => {
    render(<PluginLibraryHeader />)
    const sheet = screen.getByTestId("plugin-category-sheet")
    expect(sheet.className).toContain("lg:hidden")
  })

  it("hides the result count when filters are inactive (filtered === total)", () => {
    mockUsePlugins.mockReturnValue({
      all: [],
      filtered: [{ id: "a" }, { id: "b" }],
      totals: { total: 2, enabled: 2, errored: 0, loading: 0, updateAvailable: 0 },
      loading: false,
    })
    render(<PluginLibraryHeader />)
    expect(screen.queryByTestId("plugin-library-result-count")).not.toBeInTheDocument()
  })

  it("renders 'X of Y plugins' when filtering reduces visible rows", () => {
    mockUsePlugins.mockReturnValue({
      all: [],
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
      all: [],
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
      all: [],
      filtered: [],
      totals: { total: 0, enabled: 0, errored: 0, loading: 0, updateAvailable: 0 },
      loading: true,
    })
    render(<PluginLibraryHeader />)
    expect(screen.queryByTestId("plugin-library-result-count")).not.toBeInTheDocument()
  })
})
