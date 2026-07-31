/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import type { PluginRow } from "@/lib/db/plugin-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    if (vars && typeof vars.name === "string") return `${key}:${vars.name}`
    if (vars && typeof vars.count === "number") return `${key}:${vars.count}`
    return key
  },
}))

// Stub the card-view child so we can verify the toggle in isolation.
jest.mock("../plugin-panel-grid", () => ({
  PluginPanelGrid: () => <div data-testid="plugin-panel-grid" />,
}))

// Avoid Dexie writes in toggle handlers.
jest.mock("@/lib/db/plugins", () => ({
  setPluginEnabled: jest.fn(),
}))

let mockState = {
  filtered: [] as PluginRow[],
  totals: { total: 0, enabled: 0, errored: 0, loading: 0, updateAvailable: 0 },
  loading: false,
  all: [] as PluginRow[],
}
jest.mock("@/hooks/plugins", () => ({
  usePlugins: () => mockState,
}))

import { usePluginsStore } from "@/stores/plugins"
import { PluginLibraryList } from "./plugin-library-list"

function makePlugin(id: string): PluginRow {
  return {
    id,
    name: id,
    version: "1.0.0",
    status: "enabled",
    source: "marketplace",
    type: "frontend",
    enabled: true,
    capabilities: ["tools"],
    path: `/p/${id}`,
    manifest: { id },
    createdAt: 0,
    updatedAt: 0,
  }
}

beforeEach(() => {
  mockState = {
    filtered: [],
    totals: { total: 0, enabled: 0, errored: 0, loading: 0, updateAvailable: 0 },
    loading: false,
    all: [],
  }
  usePluginsStore.setState({
    listViewMode: "list",
    detailPluginId: null,
    selection: new Set<string>(),
    activeSection: "library",
  })
})

describe("PluginLibraryList", () => {
  it("shows the loading skeleton when the live-query has not resolved", () => {
    mockState.loading = true
    render(<PluginLibraryList />)
    expect(screen.getByTestId("plugin-library-list-skeleton")).toBeInTheDocument()
  })

  it("renders the no-plugins empty state with a Discover CTA when totals.total = 0", () => {
    render(<PluginLibraryList />)
    expect(screen.getByText("emptyAll")).toBeInTheDocument()
    fireEvent.click(screen.getByText("browseMarketplace"))
    expect(usePluginsStore.getState().activeSection).toBe("discover")
  })

  it("renders the filtered-empty card when filters yield zero rows", () => {
    mockState.totals.total = 3
    render(<PluginLibraryList />)
    expect(screen.getByText("emptyFiltered")).toBeInTheDocument()
  })

  it("renders one PluginLibraryRow per filtered plugin in list mode", () => {
    const rows = [makePlugin("a"), makePlugin("b"), makePlugin("c")]
    mockState.filtered = rows
    mockState.all = rows
    mockState.totals = { total: 3, enabled: 3, errored: 0, loading: 0, updateAvailable: 0 }
    render(<PluginLibraryList />)
    expect(screen.getByTestId("plugin-library-row-a")).toBeInTheDocument()
    expect(screen.getByTestId("plugin-library-row-b")).toBeInTheDocument()
    expect(screen.getByTestId("plugin-library-row-c")).toBeInTheDocument()
  })

  it("delegates to PluginPanelGrid when listViewMode is card", () => {
    const rows = [makePlugin("a")]
    mockState.filtered = rows
    mockState.all = rows
    mockState.totals = { total: 1, enabled: 1, errored: 0, loading: 0, updateAvailable: 0 }
    usePluginsStore.setState({ listViewMode: "card" })
    render(<PluginLibraryList />)
    expect(screen.getByTestId("plugin-panel-grid")).toBeInTheDocument()
  })

  it("select-all checkbox selects every filtered plugin, then clears", () => {
    const rows = [makePlugin("a"), makePlugin("b"), makePlugin("c")]
    mockState.filtered = rows
    mockState.all = rows
    mockState.totals = { total: 3, enabled: 3, errored: 0, loading: 0, updateAvailable: 0 }
    render(<PluginLibraryList />)
    const checkbox = screen.getByTestId("plugin-library-select-all")
    fireEvent.click(checkbox)
    expect(usePluginsStore.getState().selection).toEqual(new Set(["a", "b", "c"]))
    fireEvent.click(checkbox)
    expect(usePluginsStore.getState().selection.size).toBe(0)
  })

  it("select-all shows indeterminate when only part of the list is selected", () => {
    const rows = [makePlugin("a"), makePlugin("b")]
    mockState.filtered = rows
    mockState.all = rows
    mockState.totals = { total: 2, enabled: 2, errored: 0, loading: 0, updateAvailable: 0 }
    usePluginsStore.setState({ selection: new Set(["a"]) })
    render(<PluginLibraryList />)
    expect(screen.getByTestId("plugin-library-select-all")).toHaveAttribute(
      "data-state",
      "indeterminate"
    )
  })

  it("highlights the row that matches detailPluginId via data-active=true", () => {
    const rows = [makePlugin("a"), makePlugin("b")]
    mockState.filtered = rows
    mockState.all = rows
    mockState.totals = { total: 2, enabled: 2, errored: 0, loading: 0, updateAvailable: 0 }
    usePluginsStore.setState({ detailPluginId: "b" })
    const { container } = render(<PluginLibraryList />)
    const activeRow = container.querySelector('[data-plugin-id="b"]')
    expect(activeRow?.getAttribute("data-active")).toBe("true")
  })
})
