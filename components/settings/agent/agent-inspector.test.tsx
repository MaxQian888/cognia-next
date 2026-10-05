/**
 * AgentInspector — selected-agent detail: header actions, readiness strip,
 * tabbed sections, and inline editing through the lifecycle service.
 */

import { render, screen, within, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AgentInspector } from "./agent-inspector"
import type { AgentReadiness } from "@/lib/ai/agent/external/agent-readiness"
import type { LifecycleExternalAgentConfig } from "@/stores/agent/external-agent-store"

const updateConfigMock = jest.fn(async (_id: string, _updates: unknown) => {})
const toastError = jest.fn()
const toastSuccess = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: (...args: unknown[]) => toastSuccess(...args),
  },
}))
jest.mock("@/lib/ai/agent/external/lifecycle/state-root", () => ({
  getExternalAgentStateRootInfo: async () => null,
}))
jest.mock("@/lib/ai/agent/external/lifecycle/service", () => ({
  getExternalAgentLifecycleService: async () => ({
    updateConfig: updateConfigMock,
  }),
}))

jest.mock("@/stores/agent/external-agent-store", () => ({
  useExternalAgentStore: (sel?: (s: Record<string, unknown>) => unknown) => {
    const s = { getAgentValidity: () => undefined }
    return sel ? sel(s) : s
  },
}))

jest.mock("@/lib/ai/agent/external/config/config-normalizer", () => ({
  ...(jest.requireActual("@/lib/ai/agent/external/config/config-normalizer") as Record<
    string,
    unknown
  >),
  getExternalAgentEcosystemReadiness: () => undefined,
}))

jest.mock("./codex-app-server-status-card", () => ({
  CodexAppServerStatusCard: () => <div data-testid="codex-status-card" />,
}))
jest.mock("./opencode-status-card", () => ({
  OpencodeStatusCard: () => <div data-testid="opencode-status-card" />,
}))
jest.mock("./pi-auth-status-card", () => ({
  PiAuthStatusCard: () => <div data-testid="pi-auth-status-card" />,
}))
jest.mock("./kimi-management-card", () => ({
  KimiManagementCard: () => <div data-testid="kimi-management-card" />,
}))
jest.mock("@/components/agent/external-agent/lifecycle-status-notice", () => ({
  LifecycleStatusNotice: () => null,
}))
jest.mock("@/components/agent/external-agent/unsandboxed-consent-action", () => ({
  UnsandboxedConsentAction: () => null,
}))
jest.mock("@/components/agent/external-agent/unsandboxed-status-badge", () => ({
  UnsandboxedStatusBadge: () => null,
}))
jest.mock("@/components/agent/external-agent/sandbox-placement-badge", () => ({
  SandboxPlacementBadge: () => null,
}))

const agent = {
  id: "a1",
  name: "Alpha",
  protocol: "acp",
  transport: "stdio",
  enabled: true,
  process: { command: "npx", args: ["alpha"], cwd: "/work" },
  timeout: 300000,
  retryConfig: { maxRetries: 3, retryDelay: 1000, maxRetryDelay: 30000, exponentialBackoff: true },
  createdAt: new Date(0),
  updatedAt: new Date(0),
} as unknown as LifecycleExternalAgentConfig

const ready: AgentReadiness = {
  state: "off",
  blockReason: null,
  blockTransient: false,
  steps: [
    { id: "configured", state: "done" },
    { id: "runnable", state: "done" },
    { id: "connected", state: "todo" },
    { id: "routed", state: "todo" },
  ],
  nextAction: "connect",
}

function renderInspector(over: Partial<Parameters<typeof AgentInspector>[0]> = {}) {
  const props = {
    agent,
    allAgents: [agent],
    onOpenAgent: jest.fn(),
    readiness: ready,
    isConnecting: false,
    onConnect: jest.fn(),
    onDisconnect: jest.fn(),
    onEdit: jest.fn(),
    onDuplicate: jest.fn(),
    onDelete: jest.fn(),
    onAddRule: jest.fn(),
    ...over,
  }
  render(
    <TooltipProvider>
      <AgentInspector {...props} />
    </TooltipProvider>
  )
  return props
}

describe("AgentInspector", () => {
  beforeEach(() => {
    updateConfigMock.mockReset()
    updateConfigMock.mockImplementation(async () => {})
    toastError.mockClear()
    toastSuccess.mockClear()
  })

  it("mounts native management for the Kimi ACP preset only", () => {
    renderInspector({ agent: { ...agent, metadata: { preset: "kimi" } } })
    expect(screen.getByTestId("kimi-management-card")).toBeInTheDocument()
  })

  it("duplicates the agent from the header", async () => {
    const user = userEvent.setup()
    const { onDuplicate } = renderInspector()
    await user.click(
      within(screen.getByTestId("agent-detail-a1")).getByRole("button", { name: "Duplicate Alpha" })
    )
    expect(onDuplicate).toHaveBeenCalledTimes(1)
  })

  it("renders the header, readiness strip, and tabs", () => {
    renderInspector()
    expect(screen.getByTestId("agent-detail-a1")).toBeInTheDocument()
    expect(screen.getByTestId("inspector-readiness")).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: /connection/i })).toBeInTheDocument()
  })

  it("connects from the header and suppresses the duplicate strip action", async () => {
    const user = userEvent.setup()
    const { onConnect } = renderInspector()
    // The strip does not repeat Connect — the header button owns it.
    expect(screen.queryByTestId("inspector-next-action")).not.toBeInTheDocument()
    await user.click(
      within(screen.getByTestId("agent-detail-a1")).getByRole("button", { name: /^connect$/i })
    )
    expect(onConnect).toHaveBeenCalled()
  })

  it("offers the non-header next actions (enable, add routing rule)", async () => {
    const user = userEvent.setup()
    const { onAddRule } = renderInspector({
      readiness: { ...ready, state: "connected", nextAction: "add-rule" },
    })
    await user.click(screen.getByTestId("inspector-next-action"))
    expect(onAddRule).toHaveBeenCalled()

    renderInspector({ readiness: { ...ready, state: "disabled", nextAction: "enable" } })
    const enableButtons = screen.getAllByTestId("inspector-next-action")
    await user.click(enableButtons[enableButtons.length - 1]!)
    expect(updateConfigMock).toHaveBeenCalledWith("a1", { enabled: true })
  })

  it("preserves argument boundaries and environment when changing the cwd inline", async () => {
    const configured = {
      ...agent,
      process: {
        command: "pi",
        args: ["--skill", "./my skills", ""],
        env: { AGENT_PERSONA: "reviewer" },
        cwd: "/work",
        debug: true,
      },
    }
    renderInspector({ agent: configured })
    await userEvent.click(screen.getByRole("tab", { name: /connection/i }))
    const cwd = screen.getByLabelText(/working directory/i)
    await userEvent.clear(cwd)
    await userEvent.type(cwd, "/workspace/review")
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }))
    expect(updateConfigMock).toHaveBeenCalledWith("a1", {
      process: { ...configured.process, cwd: "/workspace/review" },
    })
  })

  it("edits the command inline and saves through the lifecycle service", async () => {
    const user = userEvent.setup()
    renderInspector()
    await act(async () => {
      await user.click(screen.getByRole("tab", { name: /connection/i }))
    })
    const command = screen.getByTestId("inspector-command")
    await user.clear(command)
    await user.type(command, "bunx")
    expect(screen.getByTestId("inspector-dirty-bar")).toBeInTheDocument()
    await act(async () => {
      await user.click(screen.getByRole("button", { name: /^save$/i }))
    })
    expect(updateConfigMock).toHaveBeenCalledWith(
      "a1",
      expect.objectContaining({
        process: { command: "bunx", args: ["alpha"], cwd: "/work" },
      })
    )
  })

  it("shows one tab panel at a time", async () => {
    const user = userEvent.setup()
    renderInspector()
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1)
    expect(screen.getByTestId("agent-instance-section")).toBeInTheDocument()
    expect(screen.queryByTestId("inspector-command")).not.toBeInTheDocument()
    await user.click(screen.getByRole("tab", { name: /connection/i }))
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1)
    expect(screen.getByTestId("inspector-command")).toBeInTheDocument()
    expect(screen.queryByTestId("agent-instance-section")).not.toBeInTheDocument()
  })

  it("renames inline and saves only the name", async () => {
    const user = userEvent.setup()
    renderInspector()
    await user.click(screen.getByRole("button", { name: "Rename Alpha" }))
    const name = screen.getByTestId("inspector-name")
    await user.clear(name)
    await user.type(name, "  Alpha work  {Enter}")
    expect(updateConfigMock).toHaveBeenCalledWith("a1", { name: "Alpha work" })
  })

  it("refuses an empty name and keeps the rename open", async () => {
    const user = userEvent.setup()
    renderInspector()
    await user.click(screen.getByTestId("inspector-rename"))
    await user.clear(screen.getByTestId("inspector-name"))
    await user.keyboard("{Enter}")
    expect(updateConfigMock).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalled()
    expect(screen.getByTestId("inspector-name")).toBeInTheDocument()
  })

  it("cancels a rename with Escape without saving", async () => {
    const user = userEvent.setup()
    renderInspector()
    await user.click(screen.getByTestId("inspector-rename"))
    await user.type(screen.getByTestId("inspector-name"), " draft{Escape}")
    expect(screen.queryByTestId("inspector-name")).not.toBeInTheDocument()
    expect(screen.queryByTestId("inspector-dirty-bar")).not.toBeInTheDocument()
    expect(updateConfigMock).not.toHaveBeenCalled()
  })

  it("saves a changed description through the one save bar", async () => {
    const user = userEvent.setup()
    renderInspector()
    await user.type(screen.getByTestId("inspector-description"), "Reviews PRs")
    await user.click(screen.getByRole("button", { name: /^save$/i }))
    expect(updateConfigMock).toHaveBeenCalledWith("a1", { description: "Reviews PRs" })
  })

  it("switches the agent off from the header and says so when that fails", async () => {
    const user = userEvent.setup()
    updateConfigMock.mockRejectedValueOnce(new Error("write conflict"))
    renderInspector()
    await user.click(screen.getByRole("switch", { name: /alpha/i }))
    expect(updateConfigMock).toHaveBeenCalledWith("a1", { enabled: false })
    await screen.findByTestId("agent-detail-a1")
    expect(toastError).toHaveBeenCalled()
  })

  it("saves the instance draft: own state and a session limit", async () => {
    const user = userEvent.setup()
    renderInspector({
      agent: { ...agent, process: { command: "codex", args: ["app-server"] } },
    })
    await user.click(screen.getByTestId("state-isolation-isolated"))
    await user.type(screen.getByTestId("instance-session-limit"), "2")
    await user.click(screen.getByRole("button", { name: /^save$/i }))
    expect(updateConfigMock).toHaveBeenCalledWith("a1", {
      stateIsolation: "isolated",
      maxConcurrentSessions: 2,
    })
  })

  it("clears a session limit with null and refuses one that is not a whole number", async () => {
    const user = userEvent.setup()
    renderInspector({ agent: { ...agent, maxConcurrentSessions: 4 } })
    const limit = screen.getByTestId("instance-session-limit")
    expect(limit).toHaveValue(4)
    await user.clear(limit)
    await user.click(screen.getByRole("button", { name: /^save$/i }))
    expect(updateConfigMock).toHaveBeenCalledWith("a1", { maxConcurrentSessions: null })

    updateConfigMock.mockClear()
    await user.type(limit, "0")
    await user.click(screen.getByRole("button", { name: /^save$/i }))
    expect(updateConfigMock).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalled()
  })

  it("links back to the configuration this one was copied from", async () => {
    const user = userEvent.setup()
    const source = { ...agent, id: "src", name: "Original" } as LifecycleExternalAgentConfig
    const copy = {
      ...agent,
      id: "a1",
      name: "Alpha copy",
      duplicatedFromAgentId: "src",
    } as LifecycleExternalAgentConfig
    const { onOpenAgent } = renderInspector({ agent: copy, allAgents: [source, copy] })
    const hint = screen.getByTestId("duplicated-from-hint")
    expect(hint).toHaveTextContent("Original")
    await user.click(hint)
    expect(onOpenAgent).toHaveBeenCalledWith("src")
  })

  it("says nothing about lineage once the source is gone", () => {
    renderInspector({
      agent: { ...agent, duplicatedFromAgentId: "deleted" } as LifecycleExternalAgentConfig,
    })
    expect(screen.queryByTestId("duplicated-from-hint")).not.toBeInTheDocument()
  })
})
