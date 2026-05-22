/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

import { PluginActiveFilters } from "./plugin-active-filters"
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
})
