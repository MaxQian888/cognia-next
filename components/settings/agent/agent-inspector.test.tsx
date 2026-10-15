// Resolve complete namespaces from split sources; aggregates are rebuilt by the orchestrator.
/**
 * AgentInspector — selected-agent detail: header actions, readiness strip,
 * tabbed sections, and inline editing through the lifecycle service.
 */

import { render, screen, within, act, fireEvent, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TooltipProvider } from "@/components/ui/tooltip"
import externalAgentMessages from "@/i18n/messages/en/externalAgent.json"
import { AgentInspector } from "./agent-inspector"
import type { AgentReadiness } from "@/lib/ai/agent/external/agent-readiness"
import type { LifecycleExternalAgentConfig } from "@/stores/agent/external-agent-store"

jest.mock("@/components/chat/motion/motion-reveal", () => ({
  useFlowMotion: () => ({ reduce: true, durationScale: 1 }),
}))

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
    const s = { getAgentValidity: () => undefined, agentFailures: {}, clearAgentFailure: jest.fn() }
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
jest.mock("@/components/agent/external-agent/unsandboxed-consent-action", () => ({
  UnsandboxedConsentAction: () => null,
}))
jest.mock("@/components/agent/external-agent/unsandboxed-status-badge", () => ({
  UnsandboxedStatusBadge: () => null,
}))
jest.mock("@/components/agent/external-agent/sandbox-delivery-history", () => ({
  SandboxDeliveryHistory: ({ agentId }: { agentId: string }) => (
    <div data-testid="sandbox-delivery-history">{agentId}</div>
  ),
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
  ready: false,
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
    masterEnabled: true,
    onOpenRuntimes: jest.fn(),
    onOpenPlugins: jest.fn(),
    onConnect: jest.fn(),
    onDisconnect: jest.fn(),
    onEdit: jest.fn(),
    onDuplicate: jest.fn(),
    onDelete: jest.fn(),
    onAddRule: jest.fn(),
    ...over,
  }
  const view = render(
    <TooltipProvider>
      <AgentInspector {...props} />
    </TooltipProvider>
  )
  return {
    ...props,
    unmount: view.unmount,
    rerenderAgent: (next: LifecycleExternalAgentConfig) =>
      view.rerender(
        <TooltipProvider>
          <AgentInspector {...props} agent={next} />
        </TooltipProvider>
      ),
    rerenderProps: (next: Partial<Parameters<typeof AgentInspector>[0]>) =>
      view.rerender(
        <TooltipProvider>
          <AgentInspector {...props} {...next} />
        </TooltipProvider>
      ),
  }
}

describe("AgentInspector", () => {
  beforeEach(() => {
    updateConfigMock.mockReset()
    updateConfigMock.mockImplementation(async () => {})
    toastError.mockClear()
    toastSuccess.mockClear()
  })

  it("disables Connect with a reason while the master switch is off", () => {
    renderInspector({ masterEnabled: false })
    const connect = screen.getByRole("button", { name: /^connect$/i })
    expect(connect).toBeDisabled()
    expect(connect).toHaveAttribute("title", externalAgentMessages.settings.inspectorMasterDisabled)
    expect(connect).toHaveAccessibleDescription(
      externalAgentMessages.settings.inspectorMasterDisabled
    )
  })

  it("mounts OpenCode status for V2 and uses semantic, wrapping facts", () => {
    renderInspector({ agent: { ...agent, protocol: "opencode-v2" } })
    expect(screen.getByTestId("opencode-status-card")).toBeInTheDocument()
    expect(screen.getByText("/work").closest("dl")).toBeInTheDocument()
    expect(screen.getByText("/work")).toHaveClass("break-all")
    expect(screen.getByRole("tablist")).not.toHaveClass("overflow-x-auto")
  })

  it("shows the saved-key hint without putting credentials into the input", async () => {
    renderInspector({
      agent: {
        ...agent,
        transport: "http",
        network: { endpoint: "https://example.com" },
        credentialRefs: { apiKey: "keyring-ref" },
      },
    })
    await userEvent.click(screen.getByRole("tab", { name: /connection/i }))
    expect(screen.getByLabelText("API Key")).toHaveValue("")
    expect(screen.getByTestId("inspector-key-saved")).toHaveTextContent(
      externalAgentMessages.settings.inspectorKeySaved
    )
  })

  it.each(["state_isolation_unsupported", "session_limit_reached"] as const)(
    "focuses the instance limit from any tab for %s",
    async (code) => {
      renderInspector({
        agent: {
          ...agent,
          stateIsolation: "isolated",
          lifecycleStatus: "blocked",
          lifecycleReasonCode: code,
        },
      })
      await userEvent.click(screen.getByRole("tab", { name: /advanced/i }))
      await userEvent.click(screen.getByTestId("inspector-next-action"))
      expect(screen.getByRole("tab", { name: /overview/i })).toHaveAttribute("data-state", "active")
      await waitFor(() =>
        expect(
          screen.getByTestId(
            code === "session_limit_reached" ? "instance-session-limit" : "inspector-instance-focus"
          )
        ).toHaveFocus()
      )
      if (code === "state_isolation_unsupported") {
        expect(screen.getByTestId("state-isolation-shared")).toHaveAttribute(
          "data-state",
          "checked"
        )
        expect(screen.getByTestId("unsaved-bar")).toBeInTheDocument()
      }
    }
  )

  it("keeps edit and delete accessible in the overflow menu", async () => {
    const view = renderInspector()
    await userEvent.click(screen.getByTestId("inspector-actions-menu"))
    await userEvent.click(screen.getByRole("menuitem", { name: "Edit all settings of Alpha" }))
    expect(view.onEdit).toHaveBeenCalledTimes(1)
    await userEvent.click(screen.getByTestId("inspector-actions-menu"))
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete Alpha" }))
    expect(view.onDelete).toHaveBeenCalledTimes(1)
  })

  it("mounts native management for the Kimi ACP preset only", () => {
    renderInspector({ agent: { ...agent, metadata: { preset: "kimi" } } })
    expect(screen.getByTestId("kimi-management-card")).toBeInTheDocument()
  })

  it("duplicates the agent from the header", async () => {
    const user = userEvent.setup()
    const { onDuplicate } = renderInspector()
    await user.click(screen.getByTestId("inspector-actions-menu"))
    await user.click(screen.getByRole("menuitem", { name: "Duplicate Alpha" }))
    expect(onDuplicate).toHaveBeenCalledTimes(1)
  })

  it("renders the header, readiness strip, and tabs", () => {
    renderInspector()
    expect(screen.getByTestId("agent-detail-a1")).toBeInTheDocument()
    expect(screen.getByTestId("sandbox-delivery-history")).toHaveTextContent("a1")
    const heading = screen.getByRole("heading", { name: "Alpha" })
    expect(heading).toHaveAttribute("tabindex", "-1")
    expect(heading).toHaveAttribute("data-detail-heading", "agent-a1")
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
    expect(screen.getByTestId("unsaved-bar")).toBeInTheDocument()
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
    expect(screen.queryByTestId("unsaved-bar")).not.toBeInTheDocument()
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

describe("inspector draft safety", () => {
  beforeEach(() => {
    updateConfigMock.mockReset().mockResolvedValue(undefined)
    toastError.mockClear()
    toastSuccess.mockClear()
  })
  afterEach(() => jest.useRealTimers())

  it("rebases a same-agent revision without wiping a command draft", async () => {
    const onDirtyChange = jest.fn()
    const view = renderInspector({ onDirtyChange })
    await userEvent.click(screen.getByRole("tab", { name: /connection/i }))
    fireEvent.change(screen.getByLabelText(/^command$/i), { target: { value: "my-cli" } })
    await act(async () => fireEvent.click(screen.getByRole("switch", { name: /alpha/i })))
    view.rerenderAgent({ ...agent, enabled: false, description: "Synced", updatedAt: new Date(1) })
    expect(screen.getByLabelText(/^command$/i)).toHaveValue("my-cli")
    expect(screen.getByTestId("inspector-description")).toHaveValue("Synced")
    expect(onDirtyChange.mock.calls).toEqual([[true]])
    expect(screen.getByTestId("unsaved-bar")).toHaveTextContent("1")
    await act(async () => fireEvent.click(screen.getByTestId("unsaved-bar-save")))
    expect(updateConfigMock).toHaveBeenLastCalledWith("a1", {
      process: { ...agent.process, command: "my-cli" },
    })
  })

  it("resets for a different agent and only reports boolean transitions", () => {
    const onDirtyChange = jest.fn()
    const view = renderInspector({ onDirtyChange })
    fireEvent.change(screen.getByTestId("inspector-description"), { target: { value: "One" } })
    fireEvent.change(screen.getByTestId("inspector-description"), { target: { value: "Two" } })
    expect(onDirtyChange.mock.calls).toEqual([[true]])
    view.rerenderAgent({ ...agent, id: "other", description: "Other agent" })
    expect(screen.getByTestId("inspector-description")).toHaveValue("Other agent")
    expect(screen.queryByTestId("unsaved-bar")).not.toBeInTheDocument()
    expect(onDirtyChange.mock.calls).toEqual([[true], [false]])
    fireEvent.change(screen.getByTestId("inspector-description"), { target: { value: "Draft" } })
    view.unmount()
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)
  })

  it("does not report unchanged dirty state when the callback identity changes", () => {
    const first = jest.fn()
    const second = jest.fn()
    const view = renderInspector({ onDirtyChange: first })
    fireEvent.change(screen.getByTestId("inspector-description"), { target: { value: "Draft" } })
    view.rerenderProps({ onDirtyChange: second })
    expect(second).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("unsaved-bar-discard"))
    expect(second).toHaveBeenCalledWith(false)
  })

  it("owns the saving and saved states and clears the saved timer on unmount", async () => {
    jest.useFakeTimers()
    let resolve!: () => void
    updateConfigMock.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done
        })
    )
    const onDirtyChange = jest.fn()
    const view = renderInspector({ onDirtyChange })
    fireEvent.change(screen.getByTestId("inspector-description"), {
      target: { value: "Saved description" },
    })
    await act(async () => fireEvent.click(screen.getByTestId("unsaved-bar-save")))
    expect(screen.getByTestId("unsaved-bar")).toHaveAttribute("data-status", "saving")
    expect(screen.getByTestId("unsaved-bar-discard")).toBeDisabled()
    view.rerenderAgent({ ...agent, description: "Saved description", updatedAt: new Date(1) })
    await act(async () => resolve())
    expect(screen.getByTestId("unsaved-bar")).toHaveAttribute("data-status", "saved")
    expect(screen.getByTestId("unsaved-bar").parentElement).toHaveClass(
      "sticky",
      "bottom-0",
      "z-10",
      "pt-2"
    )
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)
    act(() => jest.advanceTimersByTime(2000))
    expect(screen.queryByTestId("unsaved-bar")).not.toBeInTheDocument()
    fireEvent.change(screen.getByTestId("inspector-description"), { target: { value: "Again" } })
    await act(async () => fireEvent.click(screen.getByTestId("unsaved-bar-save")))
    const clearTimer = jest.spyOn(globalThis, "clearTimeout")
    view.unmount()
    expect(clearTimer).toHaveBeenCalled()
    clearTimer.mockRestore()
  })

  it("keeps newer typing during a save and preserves a failed draft", async () => {
    let resolve!: () => void
    updateConfigMock.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done
        })
    )
    const view = renderInspector()
    fireEvent.change(screen.getByTestId("inspector-description"), { target: { value: "First" } })
    await act(async () => fireEvent.click(screen.getByTestId("unsaved-bar-save")))
    fireEvent.change(screen.getByTestId("inspector-description"), { target: { value: "Second" } })
    view.rerenderAgent({ ...agent, description: "First", updatedAt: new Date(1) })
    await act(async () => resolve())
    expect(screen.getByTestId("inspector-description")).toHaveValue("Second")
    expect(screen.getByTestId("unsaved-bar")).toHaveAttribute("data-status", "dirty")
    updateConfigMock.mockRejectedValueOnce(new Error("write failed"))
    await act(async () => fireEvent.click(screen.getByTestId("unsaved-bar-save")))
    expect(toastError).toHaveBeenCalledWith(externalAgentMessages.lifecycleErrors.unknown)
    expect(screen.getByTestId("inspector-description")).toHaveValue("Second")
  })

  it.each(["permission", "web", "elicitation", "preview", "undo", "enable"])(
    "reports an immediate %s update failure without losing a draft",
    async (control) => {
      updateConfigMock.mockRejectedValueOnce(new Error("instant failed"))
      renderInspector({
        agent: { ...agent, metadata: { providerUndoWarningAcknowledged: true } },
        readiness: { ...ready, state: "disabled", nextAction: "enable" },
      })
      fireEvent.change(screen.getByTestId("inspector-description"), {
        target: { value: "Keep me" },
      })
      if (control === "enable") {
        await act(async () => fireEvent.click(screen.getByTestId("inspector-next-action")))
      } else {
        await userEvent.click(screen.getByRole("tab", { name: /advanced/i }))
        if (control === "permission" || control === "web") {
          await userEvent.click(
            screen.getByTestId(
              control === "permission"
                ? "inspector-permission-mode"
                : "inspector-declared-web-search"
            )
          )
          await userEvent.click(
            screen
              .getAllByRole("option")
              .find((option) => option.getAttribute("aria-selected") !== "true")!
          )
        } else if (control === "undo") {
          await act(async () => fireEvent.click(screen.getByTestId("reset-provider-undo-warning")))
        } else {
          const switches = within(screen.getByTestId("acp-feature-settings")).getAllByRole("switch")
          await act(async () => fireEvent.click(switches[control === "elicitation" ? 0 : 1]!))
        }
      }
      await waitFor(() =>
        expect(toastError).toHaveBeenCalledWith(externalAgentMessages.lifecycleErrors.unknown)
      )
      expect(screen.getByTestId("inspector-description")).toHaveValue("Keep me")
      expect(screen.getByTestId("unsaved-bar")).toHaveAttribute("data-status", "dirty")
    }
  )
})

it("rejects a fractional retry value using shared draft validation", async () => {
  updateConfigMock.mockReset().mockResolvedValue(undefined)
  toastError.mockClear()
  renderInspector()
  await userEvent.click(screen.getByRole("tab", { name: /advanced/i }))
  fireEvent.change(screen.getByLabelText("Max Retries"), { target: { value: "1.5" } })
  await userEvent.click(screen.getByRole("button", { name: /^save$/i }))
  expect(updateConfigMock).not.toHaveBeenCalled()
  expect(toastError).toHaveBeenCalledWith(
    externalAgentMessages.settings.mobileDetailNonNegativeIntegerInvalid
  )
  expect(screen.getByTestId("unsaved-bar")).toBeInTheDocument()
})
