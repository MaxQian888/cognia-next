/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
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

import { usePluginsStore } from "@/stores/plugins"
import { PluginLibraryHeader } from "./plugin-library-header"

beforeEach(() => {
  usePluginsStore.setState({
    filters: { ...usePluginsStore.getState().filters, query: "" },
    filterSheetOpen: false,
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
})
