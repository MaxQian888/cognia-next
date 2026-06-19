import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { CodexAppServerStatusCard } from "./codex-app-server-status-card"
import type { CodexAppServerStatus } from "@/lib/ai/agent/external/codex-app-server-client"

let hookValue: {
  status: CodexAppServerStatus
  loading: boolean
  available: boolean
  refresh: () => Promise<void>
}

jest.mock("@/hooks/agent/use-codex-app-server-status", () => ({
  useCodexAppServerStatus: () => hookValue,
}))

const messages = {
  externalAgent: {
    settings: {
      codexAppServer: {
        title: "Codex app-server",
        refresh: "Refresh status",
        mcpServers: "MCP servers",
        skills: "Skills",
        noMcpServers: "No MCP servers configured.",
        noSkills: "No skills found.",
        notConnected: "Connect the agent to view its Codex app-server status.",
      },
    },
  },
}

function renderCard() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <CodexAppServerStatusCard agentId="a1" connected />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  hookValue = {
    status: { mcpServers: [], skills: [] },
    loading: false,
    available: true,
    refresh: jest.fn(async () => {}),
  }
})

describe("CodexAppServerStatusCard", () => {
  it("renders a not-connected hint when unavailable", () => {
    hookValue.available = false
    renderCard()
    expect(
      screen.getByText("Connect the agent to view its Codex app-server status.")
    ).toBeInTheDocument()
    expect(screen.queryByTestId("codex-app-server-status")).not.toBeInTheDocument()
  })

  it("renders empty-state copy for no MCP servers and no skills", () => {
    renderCard()
    expect(screen.getByText("No MCP servers configured.")).toBeInTheDocument()
    expect(screen.getByText("No skills found.")).toBeInTheDocument()
  })

  it("renders MCP servers and skills as badges", () => {
    hookValue.status = {
      mcpServers: [{ name: "fs", status: "running" }],
      skills: [{ name: "deploy", path: "/s", enabled: true }],
    }
    renderCard()
    expect(screen.getByTestId("codex-mcp-server")).toHaveTextContent("fs · running")
    expect(screen.getByTestId("codex-skill")).toHaveTextContent("deploy")
  })

  it("disables the refresh control while loading", () => {
    hookValue.loading = true
    renderCard()
    expect(screen.getByTestId("codex-app-server-refresh")).toBeDisabled()
  })

  it("renders servers without status and disabled skills with key fallbacks", () => {
    hookValue.status = {
      mcpServers: [{ status: "running" }, { name: "fs" }],
      skills: [{ enabled: false }, { path: "/s/only-path" }],
    }
    renderCard()
    const servers = screen.getAllByTestId("codex-mcp-server")
    // First server has no name → "—"; second has a name but no status.
    expect(servers[0]).toHaveTextContent("—")
    expect(servers[1]).toHaveTextContent("fs")
    const skills = screen.getAllByTestId("codex-skill")
    expect(skills).toHaveLength(2)
  })

  it("invokes refresh when the refresh control is clicked", async () => {
    const refresh = jest.fn(async () => {})
    hookValue.refresh = refresh
    const user = userEvent.setup()
    renderCard()
    await user.click(screen.getByTestId("codex-app-server-refresh"))
    expect(refresh).toHaveBeenCalled()
  })
})
