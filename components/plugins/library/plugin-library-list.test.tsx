/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import type { PluginRow } from "@/lib/db/plugin-types"

jest.mock("next-intl", () => ({
  useLocale: () => "en",
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
jest.mock("@/lib/plugin/core/set-plugin-enabled-for-host", () => ({
  setPluginEnabledForHost: jest.fn(async () => ({ ok: true, queued: false })),
  isMirroredPluginClient: () => false,
}))

jest.mock("@/lib/db/plugins", () => ({}))

let mockState = {
  filtered: [] as PluginRow[],
  totals: { total: 0, enabled: 0, errored: 0, loading: 0, updateAvailable: 0 },
  loading: false,
  all: [] as PluginRow[],
}
jest.mock("@/hooks/plugins", () => ({
  usePlugins: () => mockState,
}))

let mockBreakpoint: "mobile" | "tablet" | "desktop" = "desktop"
jest.mock("@/hooks/ui", () => ({
  ...jest.requireActual("@/hooks/ui"),
  useBreakpoint: () => mockBreakpoint,
}))

jest.mock("../dialogs/plugin-category-sheet", () => ({
  PluginCategorySheet: () => <button type="button" data-testid="categories-trigger" />,
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

  it("offers a way out when filters yield zero rows", () => {
    mockState.totals.total = 3
    usePluginsStore.setState({
      filters: { ...usePluginsStore.getState().filters, capability: "themes", tag: "ocr" },
    })
    render(<PluginLibraryList />)
    expect(screen.getByText("emptyFiltered")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("plugin-library-clear-filters"))
    const { filters, librarySubFilter } = usePluginsStore.getState()
    expect(filters.capability).toBe("all")
    expect(filters.tag).toBeNull()
    expect(librarySubFilter).toBe("all")
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

describe("head bar and selection by layout", () => {
  beforeEach(() => {
    mockState.filtered = [makePlugin("a"), makePlugin("b")]
    mockState.totals.total = 2
    usePluginsStore.setState({ selectionMode: false, selection: new Set<string>() })
  })
  afterEach(() => {
    mockBreakpoint = "desktop"
  })

  it("desktop: checkboxes always on, no Categories trigger (the facets are in the rail)", () => {
    mockBreakpoint = "desktop"
    render(<PluginLibraryList />)
    expect(screen.getByTestId("plugin-library-select-all")).toBeInTheDocument()
    expect(screen.getAllByRole("checkbox").length).toBeGreaterThan(2)
    expect(screen.queryByTestId("categories-trigger")).toBeNull()
    expect(screen.queryByTestId("plugin-library-selection-mode")).toBeNull()
  })

  it("tablet: the Categories trigger joins the head bar", () => {
    mockBreakpoint = "tablet"
    render(<PluginLibraryList />)
    expect(screen.getByTestId("categories-trigger")).toBeInTheDocument()
  })

  it("phone: no checkboxes until Select, a count and Categories in their place", () => {
    mockBreakpoint = "mobile"
    render(<PluginLibraryList />)
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0)
    expect(screen.getByTestId("plugin-library-count")).toHaveTextContent("pluginCount:2")
    expect(screen.getByTestId("categories-trigger")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("plugin-library-selection-mode"))
    expect(usePluginsStore.getState().selectionMode).toBe(true)
  })

  it("phone selection mode: a tap toggles the row instead of opening the drawer", () => {
    mockBreakpoint = "mobile"
    usePluginsStore.setState({ selectionMode: true })
    render(<PluginLibraryList />)
    fireEvent.click(screen.getByTestId("plugin-library-row-a"))
    expect(usePluginsStore.getState().selection.has("a")).toBe(true)
    expect(usePluginsStore.getState().detailPluginId).toBeNull()
    // Done leaves the mode and drops the selection.
    fireEvent.click(screen.getByTestId("plugin-library-selection-mode"))
    expect(usePluginsStore.getState().selectionMode).toBe(false)
    expect(usePluginsStore.getState().selection.size).toBe(0)
  })

  it("keeps the head bar pinned while the rows scroll", () => {
    render(<PluginLibraryList />)
    expect(screen.getByTestId("plugin-library-head")).toHaveClass("sticky", "top-0")
  })
})

describe("keyboard", () => {
  beforeEach(() => {
    mockState.filtered = [makePlugin("a"), makePlugin("b"), makePlugin("c")]
    mockState.totals.total = 3
  })

  it("moves between rows with the arrow keys and jumps with Home / End", () => {
    render(<PluginLibraryList />)
    const list = screen.getByTestId("plugin-library-list")
    const a = screen.getByTestId("plugin-library-row-a")
    const b = screen.getByTestId("plugin-library-row-b")
    const c = screen.getByTestId("plugin-library-row-c")
    a.focus()
    fireEvent.keyDown(list, { key: "ArrowDown" })
    expect(document.activeElement).toBe(b)
    fireEvent.keyDown(list, { key: "ArrowDown" })
    fireEvent.keyDown(list, { key: "ArrowDown" })
    expect(document.activeElement).toBe(c)
    fireEvent.keyDown(list, { key: "ArrowUp" })
    expect(document.activeElement).toBe(b)
    fireEvent.keyDown(list, { key: "Home" })
    expect(document.activeElement).toBe(a)
    fireEvent.keyDown(list, { key: "End" })
    expect(document.activeElement).toBe(c)
  })

  it("names the list for assistive tech", () => {
    render(<PluginLibraryList />)
    expect(screen.getByRole("list", { name: "listAria" })).toBeInTheDocument()
  })
})
