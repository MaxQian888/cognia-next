/**
 * AgentInspector — selected-agent detail: header actions, readiness strip,
 * tabbed sections, and inline editing through the lifecycle service.
 */

import { render, screen, within, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { AgentInspector } from "./agent-inspector"
import type { AgentReadiness } from "@/lib/ai/agent/external/agent-readiness"
import type { LifecycleExternalAgentConfig } from "@/stores/agent/external-agent-store"

const updateConfigMock = jest.fn(async () => {})
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

jest.mock("@/lib/ai/agent/external/config-normalizer", () => ({
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
    readiness: ready,
    isConnecting: false,
    onConnect: jest.fn(),
    onDisconnect: jest.fn(),
    onEdit: jest.fn(),
    onDelete: jest.fn(),
    onAddRule: jest.fn(),
    ...over,
  }
  render(<AgentInspector {...props} />)
  return props
}

describe("AgentInspector", () => {
  beforeEach(() => updateConfigMock.mockClear())

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
})
