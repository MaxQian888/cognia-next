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

jest.mock("@/lib/db/mcp-servers", () => ({
  updateMcpServer: jest.fn().mockResolvedValue(undefined),
}))

const toolsState = {
  tools: [] as { name: string; description?: string }[],
  discoveredAt: null as number | null,
  discovering: false,
  error: null as string | null,
  canDiscover: true,
  loading: false,
  discover: jest.fn(),
}
jest.mock("@/hooks/mcp/use-mcp-server-tools", () => ({
  useMcpServerTools: () => toolsState,
}))

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { McpToolRulesCard } from "./mcp-tool-rules-card"
import { updateMcpServer } from "@/lib/db/mcp-servers"
import type { McpServer } from "@cognia/agent-config-types"

const server = (patch: Partial<McpServer> = {}): McpServer =>
  ({
    id: "mcp_1",
    name: "fs",
    transport: "stdio",
    config: { command: "x" },
    enabled: true,
    appsEnabled: {},
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  }) as McpServer

beforeEach(() => {
  ;(updateMcpServer as jest.Mock).mockClear()
  toolsState.tools = [
    { name: "read_file", description: "Read a file" },
    { name: "write_file" },
    { name: "write_dir" },
  ]
  toolsState.discoveredAt = null
  toolsState.discovering = false
  toolsState.error = null
  toolsState.canDiscover = true
  toolsState.loading = false
  toolsState.discover.mockReset()
})

describe("McpToolRulesCard", () => {
  it("renders one switch per discovered tool", () => {
    render(<McpToolRulesCard server={server()} />)
    expect(screen.getAllByRole("switch")).toHaveLength(3)
  })

  it("pins a tool by name when its switch is turned off", async () => {
    render(<McpToolRulesCard server={server()} />)
    fireEvent.click(screen.getByLabelText('denyToolAria:{"name":"write_file"}'))
    await waitFor(() =>
      expect(updateMcpServer).toHaveBeenCalledWith("mcp_1", { disallowedTools: ["write_file"] })
    )
  })

  it("un-pins a tool when its switch is turned back on", async () => {
    render(<McpToolRulesCard server={server({ disallowedTools: ["write_file"] })} />)
    fireEvent.click(screen.getByLabelText('allowToolAria:{"name":"write_file"}'))
    await waitFor(() =>
      expect(updateMcpServer).toHaveBeenCalledWith("mcp_1", { disallowedTools: [] })
    )
  })

  it("locks the switch for a tool a rule already denies, and names the rule", () => {
    render(<McpToolRulesCard server={server({ disallowedToolPatterns: ["write_*"] })} />)
    expect(screen.getByLabelText('allowToolAria:{"name":"write_file"}')).toBeDisabled()
    // A switch the user can flip but a rule silently overrides would be a lie.
    expect(screen.getByLabelText('denyToolAria:{"name":"read_file"}')).toBeEnabled()
    expect(screen.getAllByText('deniedByPattern:{"pattern":"write_*"}')).toHaveLength(2)
  })

  it("filters the tool list", () => {
    render(<McpToolRulesCard server={server()} />)
    fireEvent.change(screen.getByLabelText("searchPlaceholder"), { target: { value: "write" } })
    expect(screen.getAllByRole("switch")).toHaveLength(2)
  })

  it("denies only the filtered subset in bulk", async () => {
    render(<McpToolRulesCard server={server()} />)
    fireEvent.change(screen.getByLabelText("searchPlaceholder"), { target: { value: "write" } })
    fireEvent.click(screen.getByText("denyAll"))
    await waitFor(() =>
      expect(updateMcpServer).toHaveBeenCalledWith("mcp_1", {
        disallowedTools: ["write_dir", "write_file"],
      })
    )
  })

  it("allows back only the filtered subset in bulk", async () => {
    render(<McpToolRulesCard server={server({ disallowedTools: ["read_file", "write_file"] })} />)
    fireEvent.change(screen.getByLabelText("searchPlaceholder"), { target: { value: "write" } })
    fireEvent.click(screen.getByText("allowAll"))
    await waitFor(() =>
      expect(updateMcpServer).toHaveBeenCalledWith("mcp_1", { disallowedTools: ["read_file"] })
    )
  })

  it("turns the current filter into a rule", async () => {
    render(<McpToolRulesCard server={server()} />)
    fireEvent.change(screen.getByLabelText("searchPlaceholder"), { target: { value: "write" } })
    fireEvent.click(screen.getByText("denyMatching"))
    await waitFor(() =>
      expect(updateMcpServer).toHaveBeenCalledWith("mcp_1", {
        disallowedToolPatterns: ["*write*"],
      })
    )
  })

  it("hides the rule shortcut when nothing is filtered", () => {
    render(<McpToolRulesCard server={server()} />)
    expect(screen.queryByText("denyMatching")).not.toBeInTheDocument()
  })

  it("adds a rule typed into the rule box", async () => {
    render(<McpToolRulesCard server={server()} />)
    const input = screen.getByLabelText("patternPlaceholder")
    fireEvent.change(input, { target: { value: "write_*" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() =>
      expect(updateMcpServer).toHaveBeenCalledWith("mcp_1", {
        disallowedToolPatterns: ["write_*"],
      })
    )
  })

  it("shows how many tools a rule currently covers", () => {
    render(<McpToolRulesCard server={server({ disallowedToolPatterns: ["write_*"] })} />)
    expect(screen.getByText('patternHits:{"count":2}')).toBeInTheDocument()
  })

  it("warns when a typed rule has no wildcard", () => {
    render(<McpToolRulesCard server={server()} />)
    fireEvent.change(screen.getByLabelText("patternPlaceholder"), {
      target: { value: "write_file" },
    })
    expect(screen.getByText("patternLiteral")).toBeInTheDocument()
  })

  it("removes a rule", async () => {
    render(<McpToolRulesCard server={server({ disallowedToolPatterns: ["write_*"] })} />)
    fireEvent.click(screen.getByLabelText('removePattern:{"pattern":"write_*"}'))
    await waitFor(() =>
      expect(updateMcpServer).toHaveBeenCalledWith("mcp_1", { disallowedToolPatterns: [] })
    )
  })

  it("surfaces deny rules whose tool the server no longer reports", async () => {
    render(<McpToolRulesCard server={server({ disallowedTools: ["gone_tool"] })} />)
    expect(screen.getByText("orphansTitle")).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('removeOrphan:{"name":"gone_tool"}'))
    await waitFor(() =>
      expect(updateMcpServer).toHaveBeenCalledWith("mcp_1", { disallowedTools: [] })
    )
  })

  it("leads with discovery when no tool has been seen yet", () => {
    toolsState.tools = []
    render(<McpToolRulesCard server={server()} />)
    expect(screen.getByText("emptyDesktop")).toBeInTheDocument()
    fireEvent.click(screen.getByText("refresh"))
    expect(toolsState.discover).toHaveBeenCalled()
  })

  it("says so when discovery is unavailable off the desktop", () => {
    toolsState.tools = []
    toolsState.canDiscover = false
    render(<McpToolRulesCard server={server()} />)
    expect(screen.getByText("desktopOnly")).toBeInTheDocument()
  })

  it("shows a discovery error", () => {
    toolsState.error = "spawn ENOENT"
    render(<McpToolRulesCard server={server()} />)
    expect(screen.getByText("spawn ENOENT")).toBeInTheDocument()
  })
})
