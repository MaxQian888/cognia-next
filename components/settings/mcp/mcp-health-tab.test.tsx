/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const mockIsTauri = jest.fn(() => true)
jest.mock("@/lib/tauri", () => ({ isTauri: () => mockIsTauri() }))

const getLogs = jest.fn()
const onLogsUpdated = jest.fn((_cb?: () => void) => jest.fn())
jest.mock("@/lib/logging", () => ({
  loggers: { mcp: { error: jest.fn() } },
  getIndexedDBTransport: () => ({ getLogs: (...a: unknown[]) => getLogs(...a) }),
  IndexedDBTransport: { onLogsUpdated: (cb: () => void) => onLogsUpdated(cb) },
}))

jest.mock("@/components/logging", () => ({
  LogPanel: (props: { sources?: string[] }) => (
    <div data-testid="log-panel" data-sources={JSON.stringify(props.sources)} />
  ),
}))

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

const mockOperations = {
  generatedAt: 2_000,
  servers: [
    {
      serverId: "srv-1",
      displayName: "Docs",
      events: 4,
      failures: 1,
      failureRate: 0.25,
      connectP95Ms: 80,
      capabilityUpdatedAt: 1_000,
      lastErrorCode: "connect-failed",
    },
  ],
  sync: [
    {
      agentId: "claude-code",
      status: "retrying",
      lagMs: 5_000,
      attempts: 2,
      errorCode: "sync-failed",
    },
  ],
}
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => mockOperations }))
jest.mock("@/lib/mcp/operations", () => ({ loadMcpOperationsSnapshot: jest.fn() }))

const downloadFile = jest.fn()
jest.mock("@/lib/files/download", () => ({
  downloadFile: (...args: unknown[]) => downloadFile(...args),
}))

const getMcpServerStatus = jest.fn()
jest.mock("@/lib/external-bridge/tauri-control", () => ({
  getMcpServerStatus: () => getMcpServerStatus(),
}))

const listMcpAuditLog = jest.fn()
const clearMcpAuditLog = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/db/mcp-audit-log", () => ({
  listMcpAuditLog: (...a: unknown[]) => listMcpAuditLog(...a),
  clearMcpAuditLog: () => clearMcpAuditLog(),
}))

const mockRuntimeMetrics = {
  connectionAttempts: 3,
  successfulConnections: 2,
  failedConnections: 1,
  connectionLatencyMs: 40,
  warmReuses: 7,
  capabilityCacheHits: 5,
  retries: 1,
  toolCalls: 8,
  timeouts: 2,
  policyDenials: 4,
}
jest.mock("@/lib/mcp/runtime-gateway", () => ({
  defaultMcpRuntimeGateway: {
    getMetricsSnapshot: () => mockRuntimeMetrics,
    subscribeMetrics: () => () => undefined,
  },
}))

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { McpHealthTab } from "./mcp-health-tab"
import type { McpAuditLogRow } from "@/types/wiki"

const rows: McpAuditLogRow[] = [
  {
    id: "1",
    ts: 1_700_000_000_000,
    tool: "wiki_search",
    scope: "wiki:cognia",
    allowed: true,
    latencyMs: 12,
  },
  {
    id: "2",
    ts: 1_700_000_001_000,
    tool: "rag_search",
    scope: "rag:cognia",
    allowed: false,
    latencyMs: 4,
    reason: "scope OFF",
  },
]

const mcpLogs = [
  {
    id: "a",
    timestamp: new Date().toISOString(),
    level: "info",
    message: "connected",
    module: "mcp:github",
    origin: "mcp",
    data: { server: "github" },
  },
  {
    id: "b",
    timestamp: new Date().toISOString(),
    level: "error",
    message: "tools() failed",
    module: "mcp:slack",
    origin: "mcp",
    data: { server: "slack" },
  },
  {
    id: "c",
    timestamp: new Date().toISOString(),
    level: "warn",
    message: "internal diag",
    module: "logger.internal",
    origin: "diagnostic",
  },
]

beforeEach(() => {
  mockIsTauri.mockReturnValue(true)
  getMcpServerStatus.mockResolvedValue({ running: true, port: 8765, startedAt: null })
  listMcpAuditLog.mockResolvedValue(rows)
  getLogs.mockResolvedValue(mcpLogs)
  onLogsUpdated.mockClear()
  clearMcpAuditLog.mockClear()
  downloadFile.mockClear()
})

describe("McpHealthTab", () => {
  it("renders the bridge running status and the audit rows", async () => {
    render(<McpHealthTab />)
    await waitFor(() => expect(screen.getByText("running")).toBeInTheDocument())
    expect(screen.getByText('port:{"port":8765}')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText("wiki_search")).toBeInTheDocument())
    expect(screen.getByText("rag_search")).toBeInTheDocument()
  })

  it("summarizes outbound MCP-client log activity (distinct servers + errors)", async () => {
    render(<McpHealthTab />)
    const overview = await screen.findByTestId("mcp-health-overview")
    await waitFor(() => expect(within(overview).getByText("1")).toBeInTheDocument()) // 1 error
    // 2 distinct mcp servers (github, slack); the diagnostic entry is excluded.
    expect(within(overview).getAllByText("2").length).toBeGreaterThanOrEqual(1)
    expect(within(overview).getByText("statServers")).toBeInTheDocument()
    expect(getLogs).toHaveBeenCalled()
    expect(onLogsUpdated).toHaveBeenCalled()
  })

  it("shows normalized runtime performance and policy counters", async () => {
    render(<McpHealthTab />)
    const metrics = await screen.findByTestId("mcp-runtime-metrics")
    expect(within(metrics).getByText("7")).toBeInTheDocument()
    expect(within(metrics).getByText("5")).toBeInTheDocument()
    expect(within(metrics).getByText("20ms")).toBeInTheDocument()
    expect(within(metrics).getByText("metricDenials")).toBeInTheDocument()
  })

  it("shows persisted per-server failure rate and Agent sync lag", async () => {
    render(<McpHealthTab />)
    const operations = await screen.findByTestId("mcp-persisted-operations")
    expect(within(operations).getByText("Docs")).toBeInTheDocument()
    expect(within(operations).getByText("25%")).toBeInTheDocument()
    expect(within(operations).getByText("80ms")).toBeInTheDocument()
    expect(within(operations).getByText("connect-failed")).toBeInTheDocument()
    expect(within(operations).getByText("claude-code")).toBeInTheDocument()
    expect(within(operations).getByText('syncLagValue:{"seconds":5}')).toBeInTheDocument()
  })

  it("embeds the shared LogPanel scoped to the mcp source", async () => {
    render(<McpHealthTab />)
    const panel = await screen.findByTestId("log-panel")
    expect(panel).toHaveAttribute("data-sources", JSON.stringify(["mcp"]))
  })

  it("wraps the audit table in a horizontal-scroll container for narrow screens", async () => {
    render(<McpHealthTab />)
    await waitFor(() => expect(screen.getByText("wiki_search")).toBeInTheDocument())
    const scroll = screen.getByTestId("mcp-health-audit-scroll")
    expect(scroll).toHaveClass("overflow-x-auto")
    expect(scroll.querySelector("table")).toBeInTheDocument()
  })

  it("re-queries the log when the denied-only filter is toggled", async () => {
    render(<McpHealthTab />)
    await waitFor(() =>
      expect(listMcpAuditLog).toHaveBeenCalledWith({ deniedOnly: false, limit: 100 })
    )
    fireEvent.click(screen.getByLabelText("deniedOnly"))
    await waitFor(() =>
      expect(listMcpAuditLog).toHaveBeenCalledWith({ deniedOnly: true, limit: 100 })
    )
  })

  it("clears the log", async () => {
    render(<McpHealthTab />)
    await waitFor(() => expect(screen.getByText("wiki_search")).toBeInTheDocument())
    fireEvent.click(screen.getByText("clearLog"))
    await waitFor(() => expect(clearMcpAuditLog).toHaveBeenCalled())
  })

  it("exports the complete redacted audit view", async () => {
    render(<McpHealthTab />)
    await waitFor(() => expect(screen.getByText("wiki_search")).toBeInTheDocument())
    fireEvent.click(screen.getByText("exportLog"))
    await waitFor(() => expect(listMcpAuditLog).toHaveBeenCalledWith({ deniedOnly: false }))
    expect(downloadFile).toHaveBeenCalledWith(
      expect.stringMatching(/^cognia-mcp-audit-\d{4}-\d{2}-\d{2}\.json$/),
      expect.stringContaining('"wiki_search"'),
      "application/json"
    )
  })

  it("shows desktop-only notices off Tauri and skips the log query", async () => {
    mockIsTauri.mockReturnValue(false)
    getMcpServerStatus.mockResolvedValue({ running: false, port: null, startedAt: null })
    listMcpAuditLog.mockResolvedValue([])
    render(<McpHealthTab />)
    await waitFor(() => expect(screen.getAllByText("desktopOnly").length).toBeGreaterThan(0))
    expect(getLogs).not.toHaveBeenCalled()
    expect(screen.queryByTestId("log-panel")).not.toBeInTheDocument()
  })
})
