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
        account: "Account",
        signInRequired: "Sign-in required",
        usage: "Usage",
        usedPercent: "{percent}% used",
        resetsAt: "Resets {time}",
        rateLimitReached: "Rate limit reached",
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

  it("renders the account email, plan badge, and usage with reset time", () => {
    hookValue.status = {
      mcpServers: [],
      skills: [],
      account: { type: "chatgpt", email: "dev@example.com", planType: "pro" },
      requiresOpenaiAuth: false,
      rateLimits: {
        planType: "pro",
        primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1750010000 },
      },
    }
    renderCard()
    expect(screen.getByTestId("codex-account-email")).toHaveTextContent("dev@example.com")
    expect(screen.getByTestId("codex-account-plan")).toHaveTextContent("pro")
    expect(screen.getByTestId("codex-rate-limits")).toHaveTextContent("42% used")
    expect(screen.getByTestId("codex-rate-limit-reset")).toBeInTheDocument()
    expect(screen.queryByTestId("codex-rate-limited")).not.toBeInTheDocument()
  })

  it("shows sign-in required when signed out and the rate-limited badge when capped", () => {
    hookValue.status = {
      mcpServers: [],
      skills: [],
      account: null,
      requiresOpenaiAuth: true,
      rateLimits: {
        primary: { usedPercent: 100 },
        rateLimitReachedType: "rate_limit_reached",
      },
    }
    renderCard()
    expect(screen.getByTestId("codex-account-signin")).toBeInTheDocument()
    expect(screen.getByTestId("codex-rate-limited")).toBeInTheDocument()
  })

  it("omits account and usage sections when the surface was never fetched", () => {
    hookValue.status = { mcpServers: [], skills: [] }
    renderCard()
    expect(screen.queryByTestId("codex-account-section")).not.toBeInTheDocument()
    expect(screen.queryByTestId("codex-rate-limits")).not.toBeInTheDocument()
  })

  describe("managed policy", () => {
    it("lists the limits the local Codex's admin config imposes", () => {
      hookValue.status = {
        mcpServers: [],
        skills: [],
        configRequirements: {
          allowedSandboxModes: ["read-only", "workspace-write"],
          allowedApprovalPolicies: ["on-request"],
          allowedPermissionProfiles: { ":workspace": true, ":full": false },
        },
        configRequirementsUnsupported: false,
      }
      renderCard()
      const badges = screen.getByTestId("codex-managed-policy")
      expect(badges).toHaveTextContent("read-only")
      expect(badges).toHaveTextContent("workspace-write")
      expect(badges).toHaveTextContent("on-request")
      expect(badges).toHaveTextContent(":workspace")
      // A profile mapped to `false` is present but forbidden — listing it would
      // offer the user something the admin already refused.
      expect(badges).not.toHaveTextContent(":full")
    })

    it("says it could not look, rather than claiming there are no limits", () => {
      // "No limits found" and "cannot look" are different claims, and only one
      // of them means the administrator allowed everything.
      hookValue.status = {
        mcpServers: [],
        skills: [],
        configRequirementsUnsupported: true,
      }
      renderCard()
      expect(screen.getByTestId("codex-requirements-unsupported")).toBeInTheDocument()
      expect(screen.queryByTestId("codex-managed-policy")).not.toBeInTheDocument()
    })

    it("distinguishes a Codex that declares no limits from one that cannot be asked", () => {
      hookValue.status = {
        mcpServers: [],
        skills: [],
        configRequirements: null,
        configRequirementsUnsupported: false,
      }
      renderCard()
      expect(screen.queryByTestId("codex-requirements-unsupported")).not.toBeInTheDocument()
      expect(screen.queryByTestId("codex-managed-policy")).not.toBeInTheDocument()
      expect(screen.getByText(/declares no managed limits/i)).toBeInTheDocument()
    })
  })
})
