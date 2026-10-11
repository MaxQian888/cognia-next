/**
 * @jest-environment jsdom
 */

import { render, renderHook, screen, fireEvent } from "@testing-library/react"

// The namespace is part of the rendered key so the tests can tell WHICH
// vocabulary localized a value (status pill vs source badge vs sort labels).
jest.mock("next-intl", () => ({
  useTranslations: (ns?: string) => {
    const prefix = ns && ns !== "plugins.activeFilters" ? `${ns}.` : ""
    return (key: string, vars?: Record<string, unknown>) =>
      vars ? `${prefix}${key}:${JSON.stringify(vars)}` : `${prefix}${key}`
  },
}))

import {
  PluginActiveFilters,
  segmentOwnedDimensions,
  useHasActivePluginFilters,
} from "./plugin-active-filters"
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

  it("names a curated capability the way the category rail does", () => {
    usePluginsStore.setState({ filters: { ...DEFAULT_PLUGIN_FILTERS, capability: "commands" } })
    render(<PluginActiveFilters />)
    expect(screen.getByTestId("plugin-active-filter-capability").textContent).toContain(
      'chip.capability:{"value":"plugins.categorySidebar.capability.commands"}'
    )
  })

  it("keeps an uncurated capability id as is", () => {
    usePluginsStore.setState({
      filters: { ...DEFAULT_PLUGIN_FILTERS, capability: "made-up-capability" },
    })
    render(<PluginActiveFilters />)
    expect(screen.getByTestId("plugin-active-filter-capability").textContent).toContain(
      'chip.capability:{"value":"made-up-capability"}'
    )
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

  // Suppression follows the segment the toolbar LIGHTS (derived from
  // `filters`), never the stored `librarySubFilter`.
  it("hides only the dimension the lit segment shows", () => {
    usePluginsStore.setState({
      filters: { ...DEFAULT_PLUGIN_FILTERS, status: "enabled" },
      librarySubFilter: "enabled",
    })
    render(<PluginActiveFilters />)
    expect(screen.queryByTestId("plugin-active-filter-status")).not.toBeInTheDocument()
  })

  it("shows the status chip when another dimension lights the segment", () => {
    // configurable + status: the "Configurable" segment is lit, which says
    // nothing about status — so status must be a chip.
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
    expect(screen.getByTestId("plugin-active-filter-status")).toBeInTheDocument()
    expect(screen.getByTestId("plugin-active-filter-hasUpdate")).toBeInTheDocument()
    expect(screen.queryByTestId("plugin-active-filter-configurable")).not.toBeInTheDocument()
  })

  it("shows a sheet-set status with no segment of its own, whatever librarySubFilter says", () => {
    usePluginsStore.setState({
      filters: { ...DEFAULT_PLUGIN_FILTERS, status: "disabled" },
      // Stale stored sub-filter: it used to hide this chip although no
      // segment was lit.
      librarySubFilter: "updates",
    })
    render(<PluginActiveFilters />)
    expect(screen.getByTestId("plugin-active-filter-status").textContent).toContain(
      'chip.status:{"value":"plugins.card.status.disabled"}'
    )
  })

  it("localizes source, status and sort values, and describes the permission", () => {
    usePluginsStore.setState({
      filters: {
        ...DEFAULT_PLUGIN_FILTERS,
        source: "builtin",
        status: "error",
        hasUpdate: true,
        sort: "updated",
        permission: "clipboard:read",
      },
    })
    render(<PluginActiveFilters />)
    expect(screen.getByTestId("plugin-active-filter-source").textContent).toContain(
      "plugins.source.builtin"
    )
    expect(screen.getByTestId("plugin-active-filter-status").textContent).toContain(
      "plugins.card.status.error"
    )
    expect(screen.getByTestId("plugin-active-filter-sort").textContent).toContain(
      "plugins.filterSheet.sortMode.updated"
    )
    // The mock translator has no `has()`, so the description falls back to
    // the guard's English sentence — anything but the raw id.
    expect(screen.getByTestId("plugin-active-filter-permission").textContent).not.toContain(
      '"value":"clipboard:read"'
    )
  })

  it("keeps an unknown source or status as written", () => {
    usePluginsStore.setState({
      filters: { ...DEFAULT_PLUGIN_FILTERS, source: "weird", status: "installed" },
    })
    render(<PluginActiveFilters />)
    expect(screen.getByTestId("plugin-active-filter-source").textContent).toContain(
      'chip.source:{"value":"weird"}'
    )
    expect(screen.getByTestId("plugin-active-filter-status").textContent).toContain(
      'chip.status:{"value":"installed"}'
    )
  })

  it("renders a removable tag chip", () => {
    usePluginsStore.setState({ filters: { ...DEFAULT_PLUGIN_FILTERS, tag: "productivity" } })
    render(<PluginActiveFilters />)
    const chip = screen.getByTestId("plugin-active-filter-tag")
    expect(chip.textContent).toContain('chip.tag:{"value":"productivity"}')
    fireEvent.click(chip.querySelector("button")!)
    expect(usePluginsStore.getState().filters.tag).toBeNull()
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

  it("is true for a tag alone", () => {
    usePluginsStore.setState({ filters: { ...DEFAULT_PLUGIN_FILTERS, tag: "x" } })
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

describe("segmentOwnedDimensions", () => {
  it("maps each lit segment to the one dimension it shows", () => {
    expect(segmentOwnedDimensions({ ...DEFAULT_PLUGIN_FILTERS, status: "error" })).toEqual({
      status: true,
      hasUpdate: false,
      configurable: false,
    })
    expect(
      segmentOwnedDimensions({ ...DEFAULT_PLUGIN_FILTERS, status: "error", hasUpdate: true })
    ).toEqual({ status: false, hasUpdate: true, configurable: false })
    expect(segmentOwnedDimensions({ ...DEFAULT_PLUGIN_FILTERS, status: "disabled" })).toEqual({
      status: false,
      hasUpdate: false,
      configurable: false,
    })
  })
})
