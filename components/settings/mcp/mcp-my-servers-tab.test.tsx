/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

let mockServers: unknown[] = []
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => mockServers }))

jest.mock("@/lib/db/mcp-servers", () => ({
  listMcpServers: jest.fn(),
  updateMcpServer: jest.fn().mockResolvedValue(undefined),
}))

jest.mock("@/lib/logging", () => ({
  loggers: { mcp: { info: jest.fn(), error: jest.fn(), warn: jest.fn() } },
}))

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

jest.mock("../mcp-import-dialog", () => ({ McpImportDialog: () => <div data-testid="import" /> }))
jest.mock("../mcp-agent-chip-group", () => ({ refreshAgentAvailability: jest.fn() }))
jest.mock("./mcp-batch-actions-bar", () => ({
  McpBatchActionsBar: () => <div data-testid="batch" />,
}))
jest.mock("./mcp-filter-sheet", () => ({
  McpFilterSheet: () => <div data-testid="filter-sheet" />,
}))
jest.mock("./mcp-server-list", () => ({
  McpServerList: ({
    servers,
    onToggle,
  }: {
    servers: { id: string }[]
    onToggle: (s: unknown, enabled: boolean) => void
  }) => (
    <div data-testid="server-list">
      {servers.length}
      <button onClick={() => onToggle(servers[0], false)}>toggle-first</button>
    </div>
  ),
}))
jest.mock("./server-seed", () => ({
  blankServerSeed: jest.fn().mockResolvedValue({
    name: "",
    transport: "stdio",
    config: {},
    enabled: true,
    appsEnabled: {},
  }),
}))

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { McpMyServersTab } from "./mcp-my-servers-tab"
import { useMcpPanelStore } from "@/stores/mcp/mcp-panel-store"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { updateMcpServer } from "@/lib/db/mcp-servers"
import type { McpServer } from "@/lib/claude/types"

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

beforeEach(() => {
  mockServers = []
  useMcpPanelStore.setState({
    search: "",
    transportFilter: "all",
    statusFilter: "all",
    selection: new Set(),
    editorTarget: null,
  })
  useSettingsStore.setState({
    settings: { mcpPanel: { view: "grid", groupBy: "none", favorites: [] } } as never,
    save: jest.fn().mockResolvedValue(undefined),
  })
})

describe("McpMyServersTab", () => {
  it("shows the empty state with no servers", () => {
    render(<McpMyServersTab />)
    expect(screen.getByText("empty")).toBeInTheDocument()
    expect(screen.queryByTestId("server-list")).not.toBeInTheDocument()
  })

  it("renders the list when servers exist", () => {
    mockServers = [server("a"), server("b")]
    render(<McpMyServersTab />)
    expect(screen.getByTestId("server-list")).toHaveTextContent("2")
  })

  it("shows the no-match state when filters exclude everything", () => {
    mockServers = [server("a")]
    useMcpPanelStore.setState({ search: "zzz" })
    render(<McpMyServersTab />)
    expect(screen.getByText("noMatch")).toBeInTheDocument()
  })

  it("persists the view when the list toggle is clicked", async () => {
    const save = jest.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      settings: { mcpPanel: { view: "grid", groupBy: "none", favorites: [] } } as never,
      save,
    })
    render(<McpMyServersTab />)
    fireEvent.click(screen.getByLabelText("list"))
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        mcpPanel: { view: "list", groupBy: "none", favorites: [] },
      })
    )
  })

  it("opens the create editor via the seeded add button", async () => {
    render(<McpMyServersTab />)
    fireEvent.click(screen.getByText("addServer"))
    await waitFor(() =>
      expect(useMcpPanelStore.getState().editorTarget).toMatchObject({ mode: "create" })
    )
  })

  it("toggles a server's enabled state through the list callback", async () => {
    mockServers = [server("a")]
    render(<McpMyServersTab />)
    fireEvent.click(screen.getByText("toggle-first"))
    await waitFor(() => expect(updateMcpServer).toHaveBeenCalledWith("a", { enabled: false }))
  })

  it("opens the filter sheet from the Filters trigger", () => {
    render(<McpMyServersTab />)
    fireEvent.click(screen.getByLabelText("filters"))
    expect(useMcpPanelStore.getState().filterSheetOpen).toBe(true)
    expect(screen.getByTestId("filter-sheet")).toBeInTheDocument()
  })

  it("shows an active-filter count badge only when a non-default axis is set", () => {
    const { rerender } = render(<McpMyServersTab />)
    // No active transport/status filter → no badge.
    expect(screen.queryByText("1")).not.toBeInTheDocument()
    useMcpPanelStore.setState({ transportFilter: "http", statusFilter: "disabled" })
    rerender(<McpMyServersTab />)
    expect(screen.getByText("2")).toBeInTheDocument()
  })
})
