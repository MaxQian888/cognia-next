/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
jest.mock("@cognia/logging", () => ({
  loggers: { mcp: { info: jest.fn(), error: jest.fn() } },
}))

// Same TDZ hazard as the health tab: importing this component reaches the
// keyring at module-eval time, so the factory must not close over an outer
// `const`.
jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => true) }))

// The Test action is gated on reach, not on `isTauri()`: `claude_feature_call`
// is internal-only, so the honest block is `needs-desktop-shell` rather than a
// claim about which shell this is.
const reachRef = { current: { available: true } as { available: boolean; block?: string } }
jest.mock("@/hooks/platform/use-surface-reach", () => ({
  useSurfaceReach: () => reachRef.current,
}))

const discoverMcpServerViaSidecar = jest.fn()
jest.mock("@/lib/claude/feature-call", () => ({
  discoverMcpServerViaSidecar: (...a: unknown[]) => discoverMcpServerViaSidecar(...a),
}))

const recordMcpCapabilities = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/mcp/runtime-gateway", () => ({
  recordMcpCapabilities: (...a: unknown[]) => recordMcpCapabilities(...a),
}))

const reviewMcpServer = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/db/mcp-servers", () => ({
  reviewMcpServer: (...a: unknown[]) => reviewMcpServer(...a),
}))

const writeClipboardText = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/tauri/clipboard", () => ({
  writeClipboardText: (text: string) => writeClipboardText(text),
}))

jest.mock("@/hooks/mcp/use-mcp-server-logs", () => ({
  mcpServerLogsHref: (s: string) => `/logs?src=mcp&module=mcp:${s}`,
  useMcpServerLogs: () => ({
    logs: [{ timestamp: "2026-01-01T00:00:00.000Z", level: "error", message: "boom" }],
  }),
}))

jest.mock("../mcp-agent-chip-group", () => ({
  McpAgentChipGroup: () => <div data-testid="chips" />,
}))
jest.mock("./mcp-auth-button", () => ({ McpAuthButton: () => <div data-testid="auth" /> }))
jest.mock("./mcp-tool-rules-card", () => ({
  McpToolRulesCard: ({ server }: { server: { id: string } }) => (
    <div data-testid="tool-rules">{server.id}</div>
  ),
}))

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { McpServerDetail } from "./mcp-server-detail"
import { isTauri } from "@/lib/tauri"
import type { McpServer } from "@cognia/agent-config-types"

const mockIsTauri = isTauri as jest.Mock

const server = (patch: Partial<McpServer> = {}): McpServer =>
  ({
    id: "mcp_1",
    name: "filesystem",
    transport: "stdio",
    config: { command: "npx", args: ["-y", "server-filesystem"] },
    enabled: true,
    appsEnabled: {},
    trust: { state: "trusted" },
    origin: "manual",
    revision: 3,
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  }) as McpServer

const handlers = {
  onToggle: jest.fn(),
  onToggleFavorite: jest.fn(),
  onEdit: jest.fn(),
  onClone: jest.fn(),
  onExport: jest.fn(),
  onDelete: jest.fn(),
}

function renderDetail(overrides: Partial<React.ComponentProps<typeof McpServerDetail>> = {}) {
  return render(
    <McpServerDetail
      server={server()}
      favorite={false}
      agentStatuses={[]}
      agentStatusesLoading={false}
      {...handlers}
      {...overrides}
    />
  )
}

beforeEach(() => {
  mockIsTauri.mockReturnValue(true)
  reachRef.current = { available: true }
  for (const fn of Object.values(handlers)) fn.mockReset()
  discoverMcpServerViaSidecar.mockReset()
  recordMcpCapabilities.mockClear()
  reviewMcpServer.mockClear()
  writeClipboardText.mockClear()
})

describe("McpServerDetail", () => {
  it("renders the identity, connection summary and every sub-card", () => {
    renderDetail()
    expect(screen.getByText("filesystem")).toBeInTheDocument()
    expect(screen.getByText("npx -y server-filesystem")).toBeInTheDocument()
    expect(screen.getByTestId("tool-rules")).toHaveTextContent("mcp_1")
    expect(screen.getByTestId("chips")).toBeInTheDocument()
    expect(screen.getByTestId("auth")).toBeInTheDocument()
  })

  it("shows the SDK namespace alongside a different display name", () => {
    renderDetail({ server: server({ displayName: "Filesystem" }) })
    expect(screen.getByText("Filesystem")).toBeInTheDocument()
    expect(screen.getByText("filesystem")).toBeInTheDocument()
  })

  it("routes the enable switch and the row actions to the caller", () => {
    renderDetail()
    fireEvent.click(screen.getByRole("switch"))
    expect(handlers.onToggle).toHaveBeenCalledWith(expect.objectContaining({ id: "mcp_1" }), false)
    fireEvent.click(screen.getByText("edit"))
    expect(handlers.onEdit).toHaveBeenCalledWith("mcp_1")
    fireEvent.click(screen.getByLabelText('export:{"name":"filesystem"}'))
    expect(handlers.onExport).toHaveBeenCalled()
    fireEvent.click(screen.getByLabelText('delete:{"name":"filesystem"}'))
    expect(handlers.onDelete).toHaveBeenCalled()
  })

  it("stores a successful test's tools so the switches populate", async () => {
    discoverMcpServerViaSidecar.mockResolvedValue({
      ok: true,
      toolCount: 2,
      tools: [{ name: "a" }, { name: "b" }],
      resources: [],
      prompts: [],
      durationMs: 10,
    })
    renderDetail()
    fireEvent.click(screen.getByText("test"))
    await waitFor(() => expect(recordMcpCapabilities).toHaveBeenCalled())
    expect(recordMcpCapabilities.mock.calls[0][1]).toMatchObject({
      tools: [{ name: "a" }, { name: "b" }],
    })
  })

  it("does not cache anything from a failed test", async () => {
    discoverMcpServerViaSidecar.mockResolvedValue({
      ok: false,
      toolCount: 0,
      tools: [],
      resources: [],
      prompts: [],
      error: "spawn ENOENT",
      durationMs: 1,
    })
    renderDetail()
    fireEvent.click(screen.getByText("test"))
    await waitFor(() => expect(screen.getByText("failed")).toBeInTheDocument())
    expect(recordMcpCapabilities).not.toHaveBeenCalled()
  })

  it("disables the test action, and names the real reason, when the shell cannot reach a sidecar", () => {
    reachRef.current = { available: false, block: "needs-desktop-shell" }
    renderDetail()

    const button = screen.getByText("test").closest("button")
    expect(button).toBeDisabled()
    // Not "requires desktop mode": a phone paired to a Host is not a browser
    // that needs a different build, and the shared vocabulary says so.
    // The next-intl stub returns the bare key, so this is `surfaceReach.block.*`.
    expect(button).toHaveAttribute("title", "block.needs-desktop-shell")
  })

  it("offers a trust review only while the server is unreviewed", async () => {
    const { rerender } = renderDetail({ server: server({ trust: { state: "pending" } }) })
    expect(screen.getByText("reviewTitle")).toBeInTheDocument()
    fireEvent.click(screen.getByText("reviewTrust"))
    await waitFor(() => expect(reviewMcpServer).toHaveBeenCalledWith("mcp_1", true))

    rerender(
      <McpServerDetail
        server={server()}
        favorite={false}
        agentStatuses={[]}
        agentStatusesLoading={false}
        {...handlers}
      />
    )
    expect(screen.queryByText("reviewTitle")).not.toBeInTheDocument()
  })

  it("copies the server as JSON and as an install command", async () => {
    renderDetail()
    fireEvent.click(screen.getByText("copyJson"))
    await waitFor(() => expect(writeClipboardText).toHaveBeenCalled())
    expect(JSON.parse(writeClipboardText.mock.calls[0][0])).toHaveProperty(
      "mcpServers.filesystem.command",
      "npx"
    )

    fireEvent.click(screen.getByText("copyCommand"))
    await waitFor(() => expect(writeClipboardText).toHaveBeenCalledTimes(2))
    expect(writeClipboardText.mock.calls[1][0]).toBe(
      "claude mcp add filesystem -- npx -y server-filesystem"
    )
  })

  it("lists the most recent log lines", () => {
    renderDetail()
    expect(screen.getByText("boom")).toBeInTheDocument()
  })
})
