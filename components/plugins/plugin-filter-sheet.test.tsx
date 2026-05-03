/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { PluginFilterSheet } from "./plugin-filter-sheet"
import { usePluginsStore, DEFAULT_PLUGIN_FILTERS } from "@/stores/plugins"

beforeEach(() => {
  usePluginsStore.setState({
    filterSheetOpen: true,
    filters: DEFAULT_PLUGIN_FILTERS,
  })
})

describe("PluginFilterSheet", () => {
  it("does not render when filterSheetOpen is false", () => {
    usePluginsStore.setState({ filterSheetOpen: false })
    const { container } = render(<PluginFilterSheet />)
    // The Sheet still mounts a portal but its content stays out of the DOM.
    expect(container.querySelector("[role='dialog']")).toBeNull()
  })

  it("renders fields for query / capability / permission / source / status / sort", () => {
    render(<PluginFilterSheet />)
    expect(screen.getByText("query")).toBeInTheDocument()
    expect(screen.getByText("capability")).toBeInTheDocument()
    expect(screen.getByText("permission")).toBeInTheDocument()
    expect(screen.getByText("source")).toBeInTheDocument()
    expect(screen.getByText("status")).toBeInTheDocument()
    expect(screen.getByText("sort")).toBeInTheDocument()
  })

  it("renders signedOnly + hasUpdate switches", () => {
    render(<PluginFilterSheet />)
    expect(screen.getByText("signedOnly")).toBeInTheDocument()
    expect(screen.getByText("hasUpdate")).toBeInTheDocument()
  })

  it("typing in the query input persists into the store", () => {
    render(<PluginFilterSheet />)
    const input = screen.getByPlaceholderText("queryPlaceholder")
    fireEvent.change(input, { target: { value: "alpha" } })
    expect(usePluginsStore.getState().filters.query).toBe("alpha")
  })

  it("reset button restores default filters", () => {
    usePluginsStore.setState({
      filters: { ...DEFAULT_PLUGIN_FILTERS, query: "x", signedOnly: true },
    })
    render(<PluginFilterSheet />)
    fireEvent.click(screen.getByText("reset"))
    expect(usePluginsStore.getState().filters).toEqual(DEFAULT_PLUGIN_FILTERS)
  })
})
