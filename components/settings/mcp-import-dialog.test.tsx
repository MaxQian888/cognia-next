/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

const mockIsTauri = jest.fn(() => true)
jest.mock("@/lib/tauri", () => ({ isTauri: () => mockIsTauri() }))

jest.mock("@/lib/logging", () => ({
  loggers: { mcp: { info: jest.fn(), error: jest.fn() } },
}))

const refreshAgentAvailability = jest.fn()
jest.mock("./mcp-agent-chip-group", () => ({
  refreshAgentAvailability: () => refreshAgentAvailability(),
}))

jest.mock("@/lib/claude/agents", () => ({
  MCP_AGENT_ADAPTERS: [
    {
      id: "claude-code",
      displayName: "Claude Code",
      description: "",
      parse: () => [{ name: "x", transport: "stdio", config: {} }],
    },
  ],
}))

jest.mock("@/lib/claude/ipc", () => ({
  readAgentConfig: jest.fn(async () => ({
    path: "/cfg.json",
    exists: true,
    parsed: {},
    parseError: undefined,
  })),
}))

const previewAgentImport = jest.fn(async (..._args: unknown[]) => ({
  drafts: [
    { name: "empty-stdio", transport: "stdio", config: {} },
    { name: "remote-ok", transport: "http", config: { url: "https://remote/mcp" } },
  ],
}))
jest.mock("@/lib/claude/sync", () => ({
  previewAgentImport: (...a: unknown[]) => previewAgentImport(...a),
}))

const bulkImportMcpServers = jest.fn(async (..._a: unknown[]) => ({
  created: 1,
  updated: 0,
  skipped: 0,
  errored: [] as Array<{ name: string; error: string }>,
}))
const listMcpServers = jest.fn(async () => [{ id: "s1", name: "remote-ok", appsEnabled: {} }])
const updateMcpServer = jest.fn(async (..._a: unknown[]) => undefined)
jest.mock("@/lib/db/mcp-servers", () => ({
  bulkImportMcpServers: (...a: unknown[]) => bulkImportMcpServers(...a),
  listMcpServers: () => listMcpServers(),
  updateMcpServer: (...a: unknown[]) => updateMcpServer(...a),
}))

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { toast } from "sonner"
import { readAgentConfig } from "@/lib/claude/ipc"
import { McpImportDialog } from "./mcp-import-dialog"

async function openAndPick() {
  fireEvent.click(screen.getByText("importLabel"))
  fireEvent.click(await screen.findByText("Claude Code"))
}

beforeEach(() => {
  jest.clearAllMocks()
  mockIsTauri.mockReturnValue(true)
  previewAgentImport.mockResolvedValue({
    drafts: [
      { name: "empty-stdio", transport: "stdio", config: {} },
      { name: "remote-ok", transport: "http", config: { url: "https://remote/mcp" } },
    ],
  })
})

describe("McpImportDialog", () => {
  it("renders the config summary via the shared summarizeServer, with i18n fallbacks", async () => {
    render(<McpImportDialog />)
    await openAndPick()
    await waitFor(() => expect(screen.getByText("https://remote/mcp")).toBeInTheDocument())
    expect(screen.getByText("noCommand")).toBeInTheDocument()
  })

  it("renders the three collision strategies", async () => {
    render(<McpImportDialog />)
    await openAndPick()
    await waitFor(() => expect(screen.getByText("strategySkip")).toBeInTheDocument())
    expect(screen.getByText("strategyOverwrite")).toBeInTheDocument()
    expect(screen.getByText("strategyDuplicate")).toBeInTheDocument()
  })

  it("imports the selected drafts and reports a summary", async () => {
    const onImported = jest.fn()
    render(<McpImportDialog onImported={onImported} />)
    await openAndPick()
    await screen.findByText("https://remote/mcp")
    fireEvent.click(screen.getByText('importN:{"count":2}'))
    await waitFor(() => expect(bulkImportMcpServers).toHaveBeenCalled())
    expect(updateMcpServer).toHaveBeenCalledWith("s1", { appsEnabled: { "claude-code": true } })
    expect(refreshAgentAvailability).toHaveBeenCalled()
    expect(onImported).toHaveBeenCalled()
  })

  it("toggles a draft off, shrinking the import count", async () => {
    render(<McpImportDialog />)
    await openAndPick()
    await screen.findByText("https://remote/mcp")
    const checkboxes = screen.getAllByRole("checkbox")
    fireEvent.click(checkboxes[0])
    await waitFor(() => expect(screen.getByText('importN:{"count":1}')).toBeInTheDocument())
  })

  it("goes back to the agent list via the back button", async () => {
    render(<McpImportDialog />)
    await openAndPick()
    await screen.findByText("https://remote/mcp")
    fireEvent.click(screen.getByText("back"))
    // The agent slot is shown again once we step back.
    expect(await screen.findByText("Claude Code")).toBeInTheDocument()
  })

  it("shows the empty-preview notice when an agent has no entries", async () => {
    previewAgentImport.mockResolvedValueOnce({ drafts: [] })
    render(<McpImportDialog />)
    await openAndPick()
    await waitFor(() =>
      expect(screen.getByText('noEntries:{"agent":"Claude Code"}')).toBeInTheDocument()
    )
  })

  it("surfaces a preview failure as a toast", async () => {
    previewAgentImport.mockRejectedValueOnce(new Error("boom"))
    render(<McpImportDialog />)
    await openAndPick()
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("boom"))
  })

  it("renders a custom trigger and the desktop-only path is gated by isTauri", async () => {
    render(<McpImportDialog trigger={<button>my-trigger</button>} />)
    fireEvent.click(screen.getByText("my-trigger"))
    expect(await screen.findByText("Claude Code")).toBeInTheDocument()
  })

  it("surfaces a per-agent probe failure as a parse error on the slot", async () => {
    ;(readAgentConfig as jest.Mock).mockRejectedValueOnce(new Error("probe-failed"))
    render(<McpImportDialog />)
    fireEvent.click(screen.getByText("importLabel"))
    expect(await screen.findByText("probe-failed")).toBeInTheDocument()
  })

  it("surfaces an import failure as a toast and stops", async () => {
    bulkImportMcpServers.mockRejectedValueOnce(new Error("import-broke"))
    render(<McpImportDialog />)
    await openAndPick()
    await screen.findByText("https://remote/mcp")
    fireEvent.click(screen.getByText('importN:{"count":2}'))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("import-broke"))
  })

  it("re-checks a draft toggled off, restoring the import count", async () => {
    render(<McpImportDialog />)
    await openAndPick()
    await screen.findByText("https://remote/mcp")
    const checkbox = screen.getAllByRole("checkbox")[0]
    fireEvent.click(checkbox)
    await waitFor(() => expect(screen.getByText('importN:{"count":1}')).toBeInTheDocument())
    fireEvent.click(checkbox)
    await waitFor(() => expect(screen.getByText('importN:{"count":2}')).toBeInTheDocument())
  })

  it("summarizes created/updated/skipped/errored parts on import", async () => {
    bulkImportMcpServers.mockResolvedValueOnce({
      created: 0,
      updated: 2,
      skipped: 1,
      errored: [{ name: "bad", error: "x" }],
    })
    render(<McpImportDialog />)
    await openAndPick()
    await screen.findByText("https://remote/mcp")
    fireEvent.click(screen.getByText('importN:{"count":2}'))
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
  })

  it("reports 'no changes' when the import yields an all-zero result", async () => {
    bulkImportMcpServers.mockResolvedValueOnce({
      created: 0,
      updated: 0,
      skipped: 0,
      errored: [],
    })
    render(<McpImportDialog />)
    await openAndPick()
    await screen.findByText("https://remote/mcp")
    fireEvent.click(screen.getByText('importN:{"count":2}'))
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("summaryNoChanges"))
    )
  })

  it("skips per-agent flips for already-projected and non-imported servers", async () => {
    listMcpServers.mockResolvedValueOnce([
      { id: "s1", name: "remote-ok", appsEnabled: { "claude-code": true } },
      { id: "s2", name: "unrelated", appsEnabled: {} },
    ])
    render(<McpImportDialog />)
    await openAndPick()
    await screen.findByText("https://remote/mcp")
    fireEvent.click(screen.getByText('importN:{"count":2}'))
    await waitFor(() => expect(bulkImportMcpServers).toHaveBeenCalled())
    expect(updateMcpServer).not.toHaveBeenCalled()
  })

  it("shows the desktop-only notice when not running under Tauri", () => {
    mockIsTauri.mockReturnValue(false)
    // A custom trigger isn't gated by the default button's disabled state, so
    // the dialog can open to reveal the desktop-only notice.
    render(<McpImportDialog trigger={<button>open-it</button>} />)
    fireEvent.click(screen.getByText("open-it"))
    expect(screen.getByText("desktopOnly")).toBeInTheDocument()
  })
})
