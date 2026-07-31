import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { OpencodeStatusCard } from "./opencode-status-card"
import type { OpencodeStatus } from "@/hooks/agent/use-opencode-status"

let hookValue: {
  status: OpencodeStatus
  loading: boolean
  available: boolean
  refresh: () => Promise<void>
}

jest.mock("@/hooks/agent/use-opencode-status", () => ({
  useOpencodeStatus: () => hookValue,
}))

const messages = {
  externalAgent: {
    settings: {
      opencode: {
        title: "OpenCode server",
        refresh: "Refresh status",
        notConnected: "Connect the agent to view its OpenCode server status.",
        project: "Project",
        providers: "Providers",
        noProviders: "No providers discovered.",
        agents: "Agents",
        noAgents: "No agents exposed.",
        commands: "Commands",
        noCommands: "No commands exposed.",
        mcpServers: "MCP servers",
        noMcpServers: "No MCP servers configured.",
        lspServers: "LSP servers",
      },
    },
  },
}

const EMPTY: OpencodeStatus = {
  providers: [],
  agents: [],
  commands: [],
  mcpServers: [],
  lspServers: [],
}

function renderCard() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <OpencodeStatusCard agentId="a1" connected />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  hookValue = {
    status: EMPTY,
    loading: false,
    available: true,
    refresh: jest.fn(async () => {}),
  }
})

describe("OpencodeStatusCard", () => {
  it("renders a not-connected hint when unavailable", () => {
    hookValue.available = false
    renderCard()
    expect(
      screen.getByText("Connect the agent to view its OpenCode server status.")
    ).toBeInTheDocument()
    expect(screen.queryByTestId("opencode-status")).not.toBeInTheDocument()
  })

  it("renders empty-state copy for every section", () => {
    renderCard()
    expect(screen.getByText("No providers discovered.")).toBeInTheDocument()
    expect(screen.getByText("No agents exposed.")).toBeInTheDocument()
    expect(screen.getByText("No commands exposed.")).toBeInTheDocument()
    expect(screen.getByText("No MCP servers configured.")).toBeInTheDocument()
    expect(screen.queryByTestId("opencode-lsp")).not.toBeInTheDocument()
    expect(screen.queryByTestId("opencode-project")).not.toBeInTheDocument()
  })

  it("renders project, providers, agents, commands, MCP and LSP entries", () => {
    hookValue.status = {
      providers: [
        { id: "anthropic", name: "Anthropic", connected: true },
        { id: "openai", connected: false },
      ],
      agents: [{ id: "build", name: "Build" }],
      commands: [{ name: "review" }],
      mcpServers: [{ name: "fs", status: "connected" }],
      lspServers: [{ id: "ts", status: "running" }],
      project: { worktree: "/repo", vcs: "git" },
    }
    renderCard()
    expect(screen.getByTestId("opencode-project")).toHaveTextContent("/repo · git")
    const providers = screen.getAllByTestId("opencode-provider")
    expect(providers[0]).toHaveTextContent("Anthropic")
    expect(providers[1]).toHaveTextContent("openai")
    expect(screen.getByTestId("opencode-agent")).toHaveTextContent("Build")
    expect(screen.getByTestId("opencode-command")).toHaveTextContent("/review")
    expect(screen.getByTestId("opencode-mcp-server")).toHaveTextContent("fs · connected")
    expect(screen.getByTestId("opencode-lsp")).toHaveTextContent("ts · running")
  })

  it("disables the refresh control while loading and invokes refresh on click", async () => {
    const refresh = jest.fn(async () => {})
    hookValue.refresh = refresh
    const user = userEvent.setup()
    renderCard()
    await user.click(screen.getByTestId("opencode-status-refresh"))
    expect(refresh).toHaveBeenCalled()

    hookValue.loading = true
    renderCard()
    const buttons = screen.getAllByTestId("opencode-status-refresh")
    expect(buttons[buttons.length - 1]).toBeDisabled()
  })
})
