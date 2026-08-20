/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

jest.mock("./mcp-server-list", () => ({
  McpServerList: ({ servers }: { servers: { id: string }[] }) => (
    <div data-testid="server-list">{servers.length}</div>
  ),
}))

import { fireEvent, render, screen } from "@testing-library/react"
import { McpServerListPane } from "./mcp-server-list-pane"
import { useMcpPanelStore } from "@/stores/mcp/mcp-panel-store"
import type { McpServer } from "@cognia/agent-config-types"

const server = (id: string): McpServer =>
  ({
    id,
    name: id,
    transport: "stdio",
    config: { command: "x" },
    enabled: true,
    appsEnabled: {},
    createdAt: 0,
    updatedAt: 0,
  }) as McpServer

const handlers = {
  onSetDensity: jest.fn(),
  onSetGroupBy: jest.fn(),
  onOpen: jest.fn(),
  onToggleSelect: jest.fn(),
  onToggleSelectAll: jest.fn(),
  onToggleFavorite: jest.fn(),
  onToggle: jest.fn(),
  onCreate: jest.fn(),
  onEdit: jest.fn(),
  onClone: jest.fn(),
  onExport: jest.fn(),
  onDelete: jest.fn(),
  onBrowsePresets: jest.fn(),
}

function renderPane(overrides: Partial<React.ComponentProps<typeof McpServerListPane>> = {}) {
  return render(
    <McpServerListPane
      servers={[server("a")]}
      totalCount={1}
      density="comfortable"
      groupBy="none"
      selection={new Set()}
      activeId={null}
      isFavorite={() => false}
      toolCounts={new Map()}
      deniedToolCounts={new Map()}
      {...handlers}
      {...overrides}
    />
  )
}

beforeEach(() => {
  for (const fn of Object.values(handlers)) fn.mockReset()
  useMcpPanelStore.setState({
    search: "",
    transportFilter: "all",
    statusFilter: "all",
    trustFilter: "all",
    filterSheetOpen: false,
  })
})

describe("McpServerListPane", () => {
  it("renders the list when servers are visible", () => {
    renderPane()
    expect(screen.getByTestId("server-list")).toHaveTextContent("1")
  })

  it("writes the search box back to the store", () => {
    renderPane()
    fireEvent.change(screen.getByLabelText("searchPlaceholder"), { target: { value: "git" } })
    expect(useMcpPanelStore.getState().search).toBe("git")
  })

  it("opens the filter sheet and badges the active axes", () => {
    useMcpPanelStore.setState({ transportFilter: "http" })
    renderPane()
    expect(screen.getByTestId("mcp-filter-count")).toHaveTextContent("1")
    fireEvent.click(screen.getByLabelText("filters"))
    expect(useMcpPanelStore.getState().filterSheetOpen).toBe(true)
  })

  it("reports the picked density back to the caller", () => {
    renderPane()
    fireEvent.click(screen.getByLabelText("compact"))
    expect(handlers.onSetDensity).toHaveBeenCalledWith("compact")
  })

  it("shows the first-run empty state when nothing is configured", () => {
    renderPane({ servers: [], totalCount: 0 })
    expect(screen.getByText("empty")).toBeInTheDocument()
    fireEvent.click(screen.getByText("emptyBrowsePresets"))
    expect(handlers.onBrowsePresets).toHaveBeenCalled()
  })

  it("distinguishes 'no match' from 'nothing configured'", () => {
    useMcpPanelStore.setState({ search: "zzz" })
    renderPane({ servers: [], totalCount: 4 })
    expect(screen.getByText("noMatch")).toBeInTheDocument()
    expect(screen.queryByText("empty")).not.toBeInTheDocument()
  })

  it("clears the filters from the no-match state", () => {
    useMcpPanelStore.setState({ search: "zzz", statusFilter: "enabled" })
    renderPane({ servers: [], totalCount: 4 })
    fireEvent.click(screen.getByText("clearFilters"))
    expect(useMcpPanelStore.getState().search).toBe("")
    expect(useMcpPanelStore.getState().statusFilter).toBe("all")
  })

  it("hides the clear-filters link when nothing is filtered", () => {
    renderPane({ servers: [], totalCount: 4 })
    expect(screen.queryByText("clearFilters")).not.toBeInTheDocument()
  })

  it("flips the select-all label once everything visible is selected", () => {
    const { rerender } = renderPane()
    expect(screen.getByText('selectAll:{"count":1}')).toBeInTheDocument()
    rerender(
      <McpServerListPane
        servers={[server("a")]}
        totalCount={1}
        density="comfortable"
        groupBy="none"
        selection={new Set(["a"])}
        activeId={null}
        isFavorite={() => false}
        toolCounts={new Map()}
        deniedToolCounts={new Map()}
        {...handlers}
      />
    )
    expect(screen.getByText("clearSelection")).toBeInTheDocument()
  })
})
