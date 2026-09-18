/**
 * @jest-environment jsdom
 */

import { render, renderHook, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

import { PluginActiveFilters, useHasActivePluginFilters } from "./plugin-active-filters"
import { usePluginsStore, DEFAULT_PLUGIN_FILTERS } from "@/stores/plugins"

beforeEach(() => {
  usePluginsStore.setState({
    filters: { ...DEFAULT_PLUGIN_FILTERS },
    librarySubFilter: "all",
  })
})

describe("PluginActiveFilters", () => {
  it("renders nothing when filters are at defaults", () => {
    const { container } = render(<PluginActiveFilters />)
    expect(container.firstChild).toBeNull()
  })

  it("renders a query chip when search is active and dismisses it on click", () => {
    usePluginsStore.setState({
      filters: { ...DEFAULT_PLUGIN_FILTERS, query: "hello" },
    })
    render(<PluginActiveFilters />)
    const chip = screen.getByTestId("plugin-active-filter-query")
    expect(chip.textContent).toContain("chip.query")
    expect(chip.textContent).toContain("hello")
    fireEvent.click(chip.querySelector("button")!)
    expect(usePluginsStore.getState().filters.query).toBe("")
  })

  it("renders capability, permission, source chips when set", () => {
    usePluginsStore.setState({
      filters: {
        ...DEFAULT_PLUGIN_FILTERS,
        capability: "tools",
        permission: "clipboard:read",
        source: "marketplace",
      },
    })
    render(<PluginActiveFilters />)
    expect(screen.getByTestId("plugin-active-filter-capability")).toBeInTheDocument()
    expect(screen.getByTestId("plugin-active-filter-permission")).toBeInTheDocument()
    expect(screen.getByTestId("plugin-active-filter-source")).toBeInTheDocument()
  })

  it("hides status/hasUpdate/configurable chips when a librarySubFilter is active", () => {
    usePluginsStore.setState({
      filters: {
        ...DEFAULT_PLUGIN_FILTERS,
        status: "enabled",
        hasUpdate: true,
        configurable: true,
      },
      librarySubFilter: "enabled",
    })
    render(<PluginActiveFilters />)
    expect(screen.queryByTestId("plugin-active-filter-status")).not.toBeInTheDocument()
    expect(screen.queryByTestId("plugin-active-filter-hasUpdate")).not.toBeInTheDocument()
    expect(screen.queryByTestId("plugin-active-filter-configurable")).not.toBeInTheDocument()
  })

  it("shows status/hasUpdate/configurable chips when librarySubFilter is 'all'", () => {
    usePluginsStore.setState({
      filters: {
        ...DEFAULT_PLUGIN_FILTERS,
        status: "error",
        hasUpdate: true,
        configurable: true,
      },
      librarySubFilter: "all",
    })
    render(<PluginActiveFilters />)
    expect(screen.getByTestId("plugin-active-filter-status")).toBeInTheDocument()
    expect(screen.getByTestId("plugin-active-filter-hasUpdate")).toBeInTheDocument()
    expect(screen.getByTestId("plugin-active-filter-configurable")).toBeInTheDocument()
  })

  it("shows a signedOnly chip when filters.signedOnly is true", () => {
    usePluginsStore.setState({
      filters: { ...DEFAULT_PLUGIN_FILTERS, signedOnly: true },
    })
    render(<PluginActiveFilters />)
    const chip = screen.getByTestId("plugin-active-filter-signedOnly")
    fireEvent.click(chip.querySelector("button")!)
    expect(usePluginsStore.getState().filters.signedOnly).toBe(false)
  })

  it("shows a sort chip only when sort is not the default", () => {
    usePluginsStore.setState({
      filters: { ...DEFAULT_PLUGIN_FILTERS, sort: "updated" },
    })
    render(<PluginActiveFilters />)
    expect(screen.getByTestId("plugin-active-filter-sort")).toBeInTheDocument()
  })

  it("does not show a sort chip for the default 'name' sort", () => {
    usePluginsStore.setState({
      filters: { ...DEFAULT_PLUGIN_FILTERS, sort: "name", capability: "tools" },
    })
    render(<PluginActiveFilters />)
    expect(screen.queryByTestId("plugin-active-filter-sort")).not.toBeInTheDocument()
  })

  it("Clear all resets every filter back to defaults", () => {
    usePluginsStore.setState({
      filters: {
        ...DEFAULT_PLUGIN_FILTERS,
        query: "x",
        capability: "tools",
        signedOnly: true,
      },
    })
    render(<PluginActiveFilters />)
    fireEvent.click(screen.getByText("clearAll"))
    const next = usePluginsStore.getState().filters
    expect(next.query).toBe("")
    expect(next.capability).toBe("all")
    expect(next.signedOnly).toBe(false)
  })

  // `w-max` keeps the chip row one line inside the status bar's horizontal
  // scroller — wrapping would grow the band's height and push the rows it
  // describes, the very shift it exists to prevent.
  it("keeps the chip row on a single line for the parent's scroller", () => {
    usePluginsStore.setState({
      filters: { ...DEFAULT_PLUGIN_FILTERS, capability: "tools" },
    })
    render(<PluginActiveFilters />)
    const group = screen.getByTestId("plugin-active-filters")
    expect(group.className).toContain("w-max")
    expect(group.className).not.toContain("flex-wrap")
  })
})

// `PluginLibraryStatusBar` mounts or skips its whole band on this answer,
// so it has to mirror exactly what the strip would render — including the
// sub-filter suppression rule.
describe("useHasActivePluginFilters", () => {
  it("is false at default filters", () => {
    const { result } = renderHook(() => useHasActivePluginFilters())
    expect(result.current).toBe(false)
  })

  it("is true once a filter leaves its default", () => {
    usePluginsStore.setState({
      filters: { ...DEFAULT_PLUGIN_FILTERS, capability: "tools" },
    })
    const { result } = renderHook(() => useHasActivePluginFilters())
    expect(result.current).toBe(true)
  })

  it("is false when the only non-default filters are sub-filter-owned and suppressed", () => {
    usePluginsStore.setState({
      filters: { ...DEFAULT_PLUGIN_FILTERS, status: "enabled" },
      librarySubFilter: "enabled",
    })
    const { result } = renderHook(() => useHasActivePluginFilters())
    expect(result.current).toBe(false)
  })
})
