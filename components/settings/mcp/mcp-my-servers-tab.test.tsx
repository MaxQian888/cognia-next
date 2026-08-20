/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

let mockServers: unknown[] = []
let mockCapabilities: unknown[] = []
// Run the querier for real so the two live queries in this component stay
// distinguishable — a blanket `() => mockServers` would feed the server list
// into the capability derivation as well.
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (querier: () => unknown) => querier(),
}))

jest.mock("@/lib/db/mcp-servers", () => ({
  listMcpServers: () => mockServers,
  updateMcpServer: jest.fn().mockResolvedValue(undefined),
}))

jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({ mcpCapabilityCache: { toArray: () => mockCapabilities } }),
}))

jest.mock("@cognia/logging", () => ({
  loggers: { mcp: { info: jest.fn(), error: jest.fn(), warn: jest.fn() } },
}))

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

jest.mock("@/hooks/ui/use-mobile", () => ({ useIsMobile: () => false }))
jest.mock("@/hooks/agent/use-agent-status", () => ({
  useAgentStatuses: () => ({ statuses: [], loading: false }),
}))

jest.mock("./mcp-batch-actions-bar", () => ({
  McpBatchActionsBar: () => <div data-testid="batch" />,
}))
jest.mock("./mcp-filter-sheet", () => ({
  McpFilterSheet: () => <div data-testid="filter-sheet" />,
}))
// The detail pane drags in the sidecar, the log stream and the OAuth status
// hook; it has its own suite. Same reasoning for the list, which is covered by
// mcp-server-list.test.tsx.
jest.mock("./mcp-server-detail", () => ({
  McpServerDetail: ({ server }: { server: { id: string } }) => (
    <div data-testid="server-detail">{server.id}</div>
  ),
}))
jest.mock("./mcp-server-list", () => ({
  McpServerList: ({
    servers,
    onToggle,
    onOpen,
    toolCounts,
    deniedToolCounts,
  }: {
    servers: { id: string }[]
    onToggle: (s: unknown, enabled: boolean) => void
    onOpen: (id: string) => void
    toolCounts: ReadonlyMap<string, number>
    deniedToolCounts: ReadonlyMap<string, number>
  }) => (
    <div
      data-testid="server-list"
      data-tools={JSON.stringify([...toolCounts])}
      data-denied={JSON.stringify([...deniedToolCounts])}
    >
      {servers.length}
      <button onClick={() => onToggle(servers[0], false)}>toggle-first</button>
      <button onClick={() => onOpen(servers[servers.length - 1].id)}>open-last</button>
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
import type { McpServer } from "@cognia/agent-config-types"

const server = (id: string, patch: Partial<McpServer> = {}): McpServer =>
  ({
    id,
    name: id,
    transport: "stdio",
    config: { command: "x" },
    enabled: true,
    appsEnabled: {},
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  }) as McpServer

beforeEach(() => {
  mockServers = []
  mockCapabilities = []
  useMcpPanelStore.setState({
    activeTab: "my-servers",
    search: "",
    transportFilter: "all",
    statusFilter: "all",
    trustFilter: "all",
    selection: new Set(),
    editorTarget: null,
    detailServerId: null,
    exportTarget: null,
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

  it("switches to the presets tab from the empty-state CTA", () => {
    render(<McpMyServersTab />)
    fireEvent.click(screen.getByText("emptyBrowsePresets"))
    expect(useMcpPanelStore.getState().activeTab).toBe("presets")
  })

  it("opens the create editor from the empty-state Add button", async () => {
    render(<McpMyServersTab />)
    fireEvent.click(screen.getByText("addServer"))
    await waitFor(() =>
      expect(useMcpPanelStore.getState().editorTarget).toMatchObject({ mode: "create" })
    )
  })

  it("opens the create editor from the rail's add control", async () => {
    mockServers = [server("a")]
    render(<McpMyServersTab />)
    fireEvent.click(screen.getByLabelText("addServer"))
    await waitFor(() =>
      expect(useMcpPanelStore.getState().editorTarget).toMatchObject({ mode: "create" })
    )
  })

  it("selects and clears all visible servers via the select-all toggle", () => {
    mockServers = [server("a"), server("b")]
    render(<McpMyServersTab />)
    fireEvent.click(screen.getByText('selectAll:{"count":2}'))
    expect(useMcpPanelStore.getState().selection).toEqual(new Set(["a", "b"]))
    fireEvent.click(screen.getByText("clearSelection"))
    expect(useMcpPanelStore.getState().selection.size).toBe(0)
  })

  it("hides the select-all row while the empty state is showing", () => {
    render(<McpMyServersTab />)
    expect(screen.queryByLabelText("selectAllAria")).not.toBeInTheDocument()
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

  it("matches the display name as well as the SDK namespace when searching", () => {
    mockServers = [server("a", { displayName: "Filesystem" })]
    useMcpPanelStore.setState({ search: "filesys" })
    render(<McpMyServersTab />)
    expect(screen.getByTestId("server-list")).toHaveTextContent("1")
  })

  it("persists the compact density when the row toggle is clicked", async () => {
    const save = jest.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      settings: { mcpPanel: { view: "grid", groupBy: "none", favorites: [] } } as never,
      save,
    })
    mockServers = [server("a")]
    render(<McpMyServersTab />)
    fireEvent.click(screen.getByLabelText("compact"))
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        mcpPanel: { view: "list", groupBy: "none", favorites: [] },
      })
    )
  })

  it("toggles a server's enabled state through the list callback", async () => {
    mockServers = [server("a")]
    render(<McpMyServersTab />)
    fireEvent.click(screen.getByText("toggle-first"))
    await waitFor(() => expect(updateMcpServer).toHaveBeenCalledWith("a", { enabled: false }))
  })

  it("opens the filter sheet from the Filters trigger", () => {
    mockServers = [server("a")]
    render(<McpMyServersTab />)
    fireEvent.click(screen.getByLabelText("filters"))
    expect(useMcpPanelStore.getState().filterSheetOpen).toBe(true)
  })

  it("shows an active-filter count badge only when a non-default axis is set", () => {
    mockServers = [server("a")]
    const { rerender } = render(<McpMyServersTab />)
    expect(screen.queryByText("2")).not.toBeInTheDocument()
    useMcpPanelStore.setState({ transportFilter: "http", statusFilter: "disabled" })
    rerender(<McpMyServersTab />)
    expect(screen.getByText("2")).toBeInTheDocument()
  })

  it("auto-selects the first visible server for the detail pane", async () => {
    mockServers = [server("a"), server("b")]
    render(<McpMyServersTab />)
    await waitFor(() => expect(screen.getByTestId("server-detail")).toHaveTextContent("a"))
  })

  it("moves the detail pane off a server the filters just hid", async () => {
    mockServers = [server("a"), server("b")]
    const { rerender } = render(<McpMyServersTab />)
    fireEvent.click(screen.getByText("open-last"))
    await waitFor(() => expect(screen.getByTestId("server-detail")).toHaveTextContent("b"))

    useMcpPanelStore.setState({ search: "a" })
    rerender(<McpMyServersTab />)
    await waitFor(() => expect(screen.getByTestId("server-detail")).toHaveTextContent("a"))
  })

  it("filters by review state, so 'what is waiting on me' is one click", () => {
    mockServers = [
      server("a", { trust: { state: "trusted" } }),
      server("b", { trust: { state: "pending" } }),
    ]
    useMcpPanelStore.setState({ trustFilter: "pending" })
    render(<McpMyServersTab />)
    expect(screen.getByTestId("server-list")).toHaveTextContent("1")
  })

  it("treats a pre-governance row as unreviewed for the trust filter", () => {
    mockServers = [server("a")]
    useMcpPanelStore.setState({ trustFilter: "legacy" })
    render(<McpMyServersTab />)
    expect(screen.getByTestId("server-list")).toHaveTextContent("1")
  })

  it("counts the trust axis in the active-filter badge", () => {
    mockServers = [server("a")]
    useMcpPanelStore.setState({ trustFilter: "pending" })
    render(<McpMyServersTab />)
    expect(screen.getByTestId("mcp-filter-count")).toHaveTextContent("1")
  })

  it("finds a server by a tool it provides", () => {
    mockServers = [server("a"), server("b")]
    mockCapabilities = [{ serverId: "b", updatedAt: 1, tools: [{ name: "create_issue" }] }]
    useMcpPanelStore.setState({ search: "create_issue" })
    render(<McpMyServersTab />)
    // The tool list is what makes "which server gives me X?" askable.
    expect(screen.getByTestId("server-list")).toHaveTextContent("1")
  })

  it("derives per-server tool counts from the freshest capability row", () => {
    mockServers = [server("a"), server("b")]
    mockCapabilities = [
      {
        serverId: "a",
        updatedAt: 1,
        tools: [{ name: "stale_only" }],
      },
      {
        serverId: "a",
        updatedAt: 2,
        tools: [{ name: "read_file" }, { name: "write_file" }],
      },
    ]
    render(<McpMyServersTab />)
    const list = screen.getByTestId("server-list")
    expect(JSON.parse(list.dataset.tools ?? "[]")).toEqual([["a", 2]])
    // `b` was never probed, so it gets no entry rather than a zero.
    expect(JSON.parse(list.dataset.denied ?? "[]")).toEqual([["a", 0]])
  })

  it("counts tools denied by an exact rule and by a pattern", () => {
    mockServers = [
      server("a", { disallowedTools: ["read_file"], disallowedToolPatterns: ["write_*"] }),
    ]
    mockCapabilities = [
      {
        serverId: "a",
        updatedAt: 1,
        tools: [{ name: "read_file" }, { name: "write_file" }, { name: "list_dir" }],
      },
    ]
    render(<McpMyServersTab />)
    expect(JSON.parse(screen.getByTestId("server-list").dataset.denied ?? "[]")).toEqual([["a", 2]])
  })

  it("opens the export dialog for one server from the rail", () => {
    mockServers = [server("a")]
    render(<McpMyServersTab />)
    // The list stub does not expose export, so drive the store contract the
    // rail wires up: the detail pane and the row menu both call `openExport`.
    useMcpPanelStore.getState().openExport(["a"])
    expect(useMcpPanelStore.getState().exportTarget).toEqual({ serverIds: ["a"] })
  })
})
