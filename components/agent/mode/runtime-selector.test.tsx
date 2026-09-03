/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import { AgentRuntimeSelector } from "./runtime-selector"
import type { AgentRuntimeRef } from "@/lib/ai/agent/runtime-catalog/types"

// Passthrough i18n — assertions use raw translation keys.
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// Flatten the picker and cmdk so the panel is always rendered and its rows are
// directly clickable in jsdom, without pointer-event plumbing or an open state.
//
// The rows keep the contract the assertions read: the row's own `data-testid`
// from the component, `data-value` for the runtime key, `aria-disabled` for a
// blocked lane, and `aria-current` for the one the turn will actually run on.
// `aria-current` is deliberately NOT `aria-selected`: cmdk owns that one for
// keyboard highlight.
jest.mock("@/components/shared/responsive-picker", () => ({
  ResponsivePicker: ({
    trigger,
    children,
  }: {
    trigger: React.ReactNode
    children: React.ReactNode
  }) => (
    <div>
      {trigger}
      <div data-testid="agent-runtime-panel">{children}</div>
    </div>
  ),
  PickerCheck: ({ active }: { active: boolean }) =>
    active ? <span data-testid="picker-check" /> : null,
}))

jest.mock("@/components/ui/command", () => ({
  CommandInput: (props: React.InputHTMLAttributes<HTMLInputElement>) => (
    <input data-testid="runtime-search" {...props} />
  ),
  CommandList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandEmpty: () => null,
  CommandGroup: ({
    children,
    heading,
  }: {
    children: React.ReactNode
    heading?: React.ReactNode
  }) => (
    <div>
      {heading ? <div>{heading}</div> : null}
      {children}
    </div>
  ),
  CommandSeparator: () => <hr />,
  CommandItem: ({
    children,
    onSelect,
    disabled,
    forceMount,
    ...rest
  }: {
    children: React.ReactNode
    onSelect?: () => void
    disabled?: boolean
    forceMount?: boolean
  } & React.HTMLAttributes<HTMLDivElement>) => (
    <div
      role="option"
      aria-selected={false}
      {...rest}
      data-force-mount={forceMount ? "true" : undefined}
      aria-disabled={disabled ?? false}
      onClick={() => {
        if (!disabled) onSelect?.()
      }}
    >
      {children}
    </div>
  ),
}))

jest.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}))

jest.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div data-testid="manage-dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

jest.mock("@/components/agent/external-agent/manager", () => ({
  ExternalAgentManager: () => <div data-testid="external-agent-manager" />,
}))
jest.mock("@/components/agent/external-agent/connection-status-badge", () => ({
  ConnectionStatusBadge: ({ status }: { status: string }) => (
    <span data-testid={`status-${status}`} />
  ),
}))
jest.mock("@/components/icons/brand-icon", () => ({
  BrandIcon: ({ label }: { label: string }) => <span data-brand={label} />,
}))

// Only the pieces the component reads — `enabled` is the only field the block
// assessment needs here, and jsdom is not Tauri so the runtime gate has to be
// stubbed or every agent would report "external agents unsupported".
//
// `transient` mirrors the real classifier: a namespaced `pluginId:protocol`
// adapter may still register this session, so a block on it is not settled.
//
// A `stdio` transport models the OTHER transient class: this shell cannot
// reach a process plane right now (no Host paired yet, handshake unfinished,
// socket dropped, Agent Control not granted). The real classifier marks every
// one of those transient because they describe the shell rather than the agent.
const mockBlock = (agent: {
  enabled?: boolean
  protocol?: string
  transport?: string
}): { code: string; reason: string; transient?: boolean } | null => {
  if (agent.enabled === false) return { code: "agent_disabled", reason: "Agent is disabled." }
  if (agent.transport === "stdio") {
    return {
      code: "transport_blocked",
      reason: "This device has not finished pairing with a Host.",
      transient: true,
    }
  }
  if (typeof agent.protocol === "string" && agent.protocol.includes(":")) {
    return {
      code: "protocol_unsupported",
      reason: "Plugin adapter is not registered.",
      transient: true,
    }
  }
  return null
}
jest.mock("@/lib/ai/agent/external/config-normalizer", () => ({
  getExternalAgentExecutionBlock: (agent: {
    enabled?: boolean
    protocol?: string
    transport?: string
  }) => mockBlock(agent),
}))
jest.mock("@/lib/ai/agent/external/protocol-adapter", () => ({
  onProtocolAdapterRegistryChange: () => () => {},
}))
jest.mock("@/lib/ai/agent/external/presets", () => ({
  isFromPreset: () => null,
}))

const mockSetRuntimeRef = jest.fn()
const mockSetSessionRuntimeRef = jest.fn()
const runtimeState = {
  runtimeRef: { kind: "builtin" } as AgentRuntimeRef,
  setRuntimeRef: mockSetRuntimeRef,
  setSessionRuntimeRef: mockSetSessionRuntimeRef,
}

// Configurations the paired host owns. The hook itself is covered by its own
// suite; here it only has to supply rows and the "no host" verdict.
const hostConfigsState = {
  configs: [] as Array<Record<string, unknown>>,
  unavailable: null as string | null,
}
jest.mock("@/hooks/agent/use-host-external-agent-configs", () => ({
  useHostExternalAgentConfigs: () => hostConfigsState,
}))

function hostConfig(
  configId: string,
  name: string,
  over: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    configId,
    revision: `${configId}-rev`,
    lifecycleGeneration: 1,
    enabled: true,
    lifecycleStatus: "ready",
    config: { name, protocol: "pi-rpc" },
    ...over,
  }
}

jest.mock("@/stores/agent", () => ({
  useAgentRuntimeStore: (selector: (s: typeof runtimeState) => unknown) => selector(runtimeState),
}))
// The lane is per session, so the chip reads it through the selector rather
// than off the store's default field.
jest.mock("@/stores/agent/agent-runtime-store", () => ({
  useRuntimeRefForSession: () => runtimeState.runtimeRef,
}))

const mockSetExternalEnabled = jest.fn()
const externalAgentState = {
  enabled: true,
  agents: {} as Record<
    string,
    { id: string; name: string; enabled: boolean; protocol: string; transport?: string }
  >,
  connectionStatus: {} as Record<string, string>,
  agentValidity: {} as Record<string, Record<string, unknown>>,
  setEnabled: mockSetExternalEnabled,
}

jest.mock("@/stores/agent/external-agent-store", () => ({
  useExternalAgentStore: (selector: (s: typeof externalAgentState) => unknown) =>
    selector(externalAgentState),
}))

// The selection authority writes BOTH stores; the component must go through it
// rather than poking either store itself.
const mockSelectExternalAgent = jest.fn()
jest.mock("@/lib/agent/external-agent-selection", () => ({
  selectExternalAgent: (id: string | null) => mockSelectExternalAgent(id),
}))

// Selecting an agent also has to make the lane able to dispatch. The readiness
// answer is what the chip reports on, so the test drives it directly.
let readiness: { ok: boolean; reason?: string; detail?: string } = { ok: true }
const mockEnsureReady = jest.fn(async (_id: string) => readiness)
jest.mock("@/lib/agent/ensure-external-agent-ready", () => ({
  ensureExternalAgentReady: (id: string) => mockEnsureReady(id),
}))

const mockToastError = jest.fn()
jest.mock("@/components/ui/sonner", () => ({
  toast: { error: (...args: unknown[]) => mockToastError(...args) },
}))

function agent(id: string, name: string, enabled = true) {
  return { id, name, enabled, protocol: "acp" }
}

beforeEach(() => {
  runtimeState.runtimeRef = { kind: "builtin" }
  hostConfigsState.configs = []
  hostConfigsState.unavailable = null
  externalAgentState.enabled = true
  externalAgentState.agents = {}
  externalAgentState.connectionStatus = {}
  externalAgentState.agentValidity = {}
  mockSetRuntimeRef.mockClear()
  mockSetSessionRuntimeRef.mockClear()
  mockSelectExternalAgent.mockClear()
  mockSetExternalEnabled.mockClear()
  mockEnsureReady.mockClear()
  mockToastError.mockClear()
  readiness = { ok: true }
})

/** The chip's own fallback effect landing on the default lane. */
function fellBackToBuiltin(): boolean {
  return mockSetRuntimeRef.mock.calls.some(([ref]) => (ref as AgentRuntimeRef).kind === "builtin")
}

describe("AgentRuntimeSelector — chip label", () => {
  // The glyph is what a crowded row can afford, not what the built-in lane
  // deserves. The wording is in the accessible name either way, so collapsing
  // costs nothing to a screen reader.
  it("wears a glyph on the built-in runtime only where the row is out of room", () => {
    render(<AgentRuntimeSelector dense />)
    const trigger = screen.getByTestId("agent-runtime-trigger")
    expect(trigger).not.toHaveAttribute("data-labelled")
    expect(trigger).toHaveTextContent("")
    expect(trigger.getAttribute("aria-label")).toContain("cogniaAgent")
  })

  it("spells the built-in runtime out when the row has the width", () => {
    render(<AgentRuntimeSelector />)
    const trigger = screen.getByTestId("agent-runtime-trigger")
    expect(trigger).toHaveAttribute("data-labelled", "true")
    expect(trigger).toHaveTextContent("cogniaAgent")
  })

  it("keeps the agent's name at any width, because the name is the point", () => {
    runtimeState.runtimeRef = { kind: "external", agentId: "a1" }
    externalAgentState.agents = { a1: agent("a1", "Codex") }
    render(<AgentRuntimeSelector dense />)
    const trigger = screen.getByTestId("agent-runtime-trigger")
    expect(trigger).toHaveAttribute("data-labelled", "true")
    expect(trigger).toHaveTextContent("Codex")
  })

  it("names the selected external agent instead of a generic 'external' label", () => {
    runtimeState.runtimeRef = { kind: "external", agentId: "a1" }
    externalAgentState.agents = { a1: agent("a1", "Codex") }
    render(<AgentRuntimeSelector />)
    const trigger = screen.getByTestId("agent-runtime-trigger")
    expect(trigger).toHaveAttribute("data-labelled", "true")
    expect(trigger).toHaveTextContent("Codex")
  })

  it("renders the aria label from the translation key", () => {
    render(<AgentRuntimeSelector />)
    expect(screen.getByTestId("agent-runtime-trigger").getAttribute("aria-label")).toContain(
      "ariaLabel"
    )
  })
})

describe("AgentRuntimeSelector — one dropdown, one choice", () => {
  it("lists each configured agent as a peer of the built-in runtime", () => {
    externalAgentState.agents = { a1: agent("a1", "Codex"), a2: agent("a2", "Gemini") }
    render(<AgentRuntimeSelector />)
    expect(screen.getByTestId("runtime-builtin")).toBeInTheDocument()
    expect(screen.getByTestId("runtime-external-a1")).toBeInTheDocument()
    expect(screen.getByTestId("runtime-external-a2")).toBeInTheDocument()
    // The old two-control split is gone: there is no bare "external" lane to
    // land on without an agent.
    expect(screen.queryByTestId("runtime-external")).toBeNull()
  })

  // The defect this catalog exists for: the builtin row claimed the Anthropic
  // SDK sidecar under every provider, including in the accessible name, where
  // the glyph-only chip means it is the ONLY wording a screen reader gets.
  it("names the engine that will really serve the turn", () => {
    const { rerender } = render(<AgentRuntimeSelector providerId="anthropic" />)
    expect(screen.getByTestId("runtime-builtin")).toHaveTextContent("engineClaudeAgentSdk")

    rerender(<AgentRuntimeSelector providerId="deepseek" />)
    expect(screen.getByTestId("runtime-builtin")).toHaveTextContent("engineAiSdk")
    expect(screen.getByTestId("runtime-builtin")).not.toHaveTextContent("engineClaudeAgentSdk")
  })

  it("sorts agent rows by name", () => {
    externalAgentState.agents = { a1: agent("a1", "Zed"), a2: agent("a2", "Codex") }
    render(<AgentRuntimeSelector />)
    const items = screen
      .getAllByRole("option")
      .map((el) => el.dataset.value)
      .filter(Boolean)
    expect(items).toEqual(["builtin", "external:a2", "external:a1"])
  })

  it("selects the runtime AND the agent record in a single click", () => {
    externalAgentState.agents = { a1: agent("a1", "Codex") }
    render(<AgentRuntimeSelector />)
    fireEvent.click(screen.getByTestId("runtime-external-a1"))
    expect(mockSelectExternalAgent).toHaveBeenCalledWith("a1")
    expect(mockSetRuntimeRef).toHaveBeenCalledWith({ kind: "external", agentId: "a1" })
  })

  it("says so here when the agent it just picked cannot be reached", async () => {
    // The report is recorded against the agent, and the only surface that
    // draws those is the Manage Agents panel. This user is standing at the
    // composer, so a silent failure is the first send coming back with a
    // sentence about the manager's internals.
    readiness = { ok: false, reason: "failed", detail: "spawn codex ENOENT" }
    externalAgentState.agents = { a1: agent("a1", "Codex") }
    render(<AgentRuntimeSelector />)
    fireEvent.click(screen.getByTestId("runtime-external-a1"))
    await Promise.resolve()
    await Promise.resolve()
    expect(mockToastError).toHaveBeenCalledWith("failure.connect", {
      description: "spawn codex ENOENT",
    })
  })

  it("stays quiet when the agent connected, and when the lane is already moving", async () => {
    externalAgentState.agents = { a1: agent("a1", "Codex") }
    const { unmount } = render(<AgentRuntimeSelector />)
    fireEvent.click(screen.getByTestId("runtime-external-a1"))
    await Promise.resolve()
    expect(mockToastError).not.toHaveBeenCalled()
    unmount()

    // A selection that outlived its agent is already being walked back to the
    // built-in lane by the fallback effect, so a toast would be noise.
    readiness = { ok: false, reason: "unknown-agent" }
    render(<AgentRuntimeSelector />)
    fireEvent.click(screen.getByTestId("runtime-external-a1"))
    await Promise.resolve()
    await Promise.resolve()
    expect(mockToastError).not.toHaveBeenCalled()
  })

  it("switches back to the built-in runtime without touching the agent record", () => {
    runtimeState.runtimeRef = { kind: "external", agentId: "a1" }
    externalAgentState.agents = { a1: agent("a1", "Codex") }
    render(<AgentRuntimeSelector />)
    fireEvent.click(screen.getByTestId("runtime-builtin"))
    expect(mockSetRuntimeRef).toHaveBeenCalledWith({ kind: "builtin" })
    expect(mockSelectExternalAgent).not.toHaveBeenCalled()
  })

  it("disables a blocked agent and shows why, instead of hiding it", () => {
    externalAgentState.agents = { a1: agent("a1", "Codex", false) }
    render(<AgentRuntimeSelector />)
    expect(screen.getByTestId("runtime-external-a1")).toHaveAttribute("aria-disabled", "true")
    expect(screen.getByText("Agent is disabled.")).toBeInTheDocument()
  })

  it("ignores a click on a blocked agent", () => {
    externalAgentState.agents = { a1: agent("a1", "Codex", false) }
    render(<AgentRuntimeSelector />)
    fireEvent.click(screen.getByTestId("runtime-external-a1"))
    expect(mockSetRuntimeRef).not.toHaveBeenCalled()
    expect(mockSelectExternalAgent).not.toHaveBeenCalled()
  })

  it("shows setup guidance when nothing is configured", () => {
    render(<AgentRuntimeSelector />)
    expect(screen.getByText("externalEmpty")).toBeInTheDocument()
  })

  // "Manage agents" reads as housekeeping to someone with nothing to manage;
  // from zero the same dialog is the way to create the first agent.
  it("offers to add an agent instead of to manage none", () => {
    render(<AgentRuntimeSelector />)
    expect(screen.getByTestId("runtime-manage-agents")).toHaveTextContent("addExternalAgent")
  })

  it("labels the footer as manage once an agent exists", () => {
    externalAgentState.agents = { a1: agent("a1", "Codex") }
    render(<AgentRuntimeSelector />)
    expect(screen.getByTestId("runtime-manage-agents")).toHaveTextContent("manageAgents")
  })

  describe("globally disabled", () => {
    beforeEach(() => {
      externalAgentState.enabled = false
      externalAgentState.agents = { a1: agent("a1", "Codex") }
    })

    it("hides every agent row", () => {
      render(<AgentRuntimeSelector />)
      expect(screen.queryByTestId("runtime-external-a1")).toBeNull()
    })

    // Regression: this used to render the "nothing configured" sentence, which
    // is a different problem with a different fix — the agents exist, the
    // feature is off.
    it("says the feature is off rather than that nothing is configured", () => {
      render(<AgentRuntimeSelector />)
      expect(screen.getByText("externalTurnedOff")).toBeInTheDocument()
      expect(screen.queryByText("externalEmpty")).toBeNull()
    })

    it("turns the feature back on from the menu", () => {
      render(<AgentRuntimeSelector />)
      fireEvent.click(screen.getByTestId("runtime-enable-external"))
      expect(mockSetExternalEnabled).toHaveBeenCalledWith(true)
    })
  })

  describe("runtime validity", () => {
    it("surfaces the last failure verbatim without blocking the choice", () => {
      externalAgentState.agents = { a1: agent("a1", "Codex") }
      externalAgentState.agentValidity = {
        a1: { executable: false, blockingReason: "codex: command not found" },
      }
      render(<AgentRuntimeSelector />)
      expect(screen.getByText("codex: command not found")).toBeInTheDocument()
      expect(screen.getByTestId("runtime-external-a1")).toHaveAttribute("aria-disabled", "false")
    })

    it("flags an agent waiting on sign-in", () => {
      externalAgentState.agents = { a1: agent("a1", "Codex") }
      externalAgentState.agentValidity = {
        a1: { executable: true, negotiation: { authRequired: true } },
      }
      render(<AgentRuntimeSelector />)
      expect(screen.getByText("needsAuth")).toBeInTheDocument()
    })

    it("flags an agent whose last health check failed", () => {
      externalAgentState.agents = { a1: agent("a1", "Codex") }
      externalAgentState.agentValidity = { a1: { executable: true, healthStatus: "unhealthy" } }
      render(<AgentRuntimeSelector />)
      expect(screen.getByText("lastCheckFailed")).toBeInTheDocument()
    })

    // A config-level block is a verdict about now; the snapshot is history. The
    // verdict wins the one line the row has.
    it("prefers the config block over a stale snapshot", () => {
      externalAgentState.agents = { a1: agent("a1", "Codex", false) }
      externalAgentState.agentValidity = { a1: { executable: true, healthStatus: "unhealthy" } }
      render(<AgentRuntimeSelector />)
      expect(screen.getByText("Agent is disabled.")).toBeInTheDocument()
      expect(screen.queryByText("lastCheckFailed")).toBeNull()
    })

    it("says nothing when the snapshot is clean", () => {
      externalAgentState.agents = { a1: agent("a1", "Codex") }
      externalAgentState.agentValidity = { a1: { executable: true, healthStatus: "healthy" } }
      render(<AgentRuntimeSelector />)
      expect(screen.queryByText("lastCheckFailed")).toBeNull()
      expect(screen.queryByText("needsAuth")).toBeNull()
    })
  })

  it("opens the manager dialog from the menu footer", () => {
    externalAgentState.agents = { a1: agent("a1", "Codex") }
    render(<AgentRuntimeSelector />)
    expect(screen.queryByTestId("manage-dialog")).toBeNull()
    fireEvent.click(screen.getByTestId("runtime-manage-agents"))
    expect(screen.getByTestId("external-agent-manager")).toBeInTheDocument()
  })
})

describe("AgentRuntimeSelector — invalid selection repair", () => {
  it("falls back to the built-in runtime when the selected agent is gone", () => {
    runtimeState.runtimeRef = { kind: "external", agentId: "deleted" }
    render(<AgentRuntimeSelector />)
    expect(fellBackToBuiltin()).toBe(true)
  })

  it("falls back when the selected agent can no longer execute", () => {
    runtimeState.runtimeRef = { kind: "external", agentId: "a1" }
    externalAgentState.agents = { a1: agent("a1", "Codex", false) }
    render(<AgentRuntimeSelector />)
    expect(fellBackToBuiltin()).toBe(true)
  })

  it("leaves a valid external selection alone", () => {
    runtimeState.runtimeRef = { kind: "external", agentId: "a1" }
    externalAgentState.agents = { a1: agent("a1", "Codex") }
    render(<AgentRuntimeSelector />)
    expect(fellBackToBuiltin()).toBe(false)
  })

  it("keeps the selection while this shell cannot reach a process plane yet", () => {
    // The reload defect. A companion resolves its Host asynchronously, and the
    // boot provider that writes the runtime snapshot runs its effect AFTER the
    // composer's, so the first frame of every reload reports "no host". That
    // used to read as a settled block, and the chip persisted the built-in lane
    // over the user's chosen agent before the Host had even answered.
    runtimeState.runtimeRef = { kind: "external", agentId: "a1" }
    externalAgentState.agents = { a1: { ...agent("a1", "Pi"), transport: "stdio" } }
    render(<AgentRuntimeSelector />)
    expect(fellBackToBuiltin()).toBe(false)
  })

  it("keeps the selection while a plugin adapter has not registered yet", () => {
    // The chip mounts before the plugin manager finishes registering protocol
    // adapters, so a plugin-contributed agent reads as blocked at first render.
    // Persisting the fallback there silently moved the user off their chosen
    // agent on every restart, and the later registry tick never undid it.
    runtimeState.runtimeRef = { kind: "external", agentId: "a1" }
    externalAgentState.agents = { a1: { ...agent("a1", "My Plugin Agent"), protocol: "acme:rpc" } }
    render(<AgentRuntimeSelector />)
    expect(fellBackToBuiltin()).toBe(false)
  })

  it("still renders a transiently blocked agent as unselectable", () => {
    // Not persisting the fallback must not mean pretending it works: the row
    // stays disabled and carries its reason until the adapter registers.
    runtimeState.runtimeRef = { kind: "external", agentId: "a1" }
    externalAgentState.agents = { a1: { ...agent("a1", "My Plugin Agent"), protocol: "acme:rpc" } }
    render(<AgentRuntimeSelector />)
    expect(screen.getByTestId("runtime-external-a1")).toHaveAttribute("aria-disabled", "true")
  })
})

describe("AgentRuntimeSelector — the lane belongs to the session", () => {
  // Writing the app default from inside a conversation is the defect ADR-0117
  // fixed for the mode: it retargets every other conversation, including one
  // mid-turn.
  it("writes the session's own lane when it has one", () => {
    externalAgentState.agents = { a1: agent("a1", "Codex") }
    render(<AgentRuntimeSelector sessionId="s1" />)
    fireEvent.click(screen.getByTestId("runtime-external-a1"))
    expect(mockSetSessionRuntimeRef).toHaveBeenCalledWith("s1", {
      kind: "external",
      agentId: "a1",
    })
    expect(mockSetRuntimeRef).not.toHaveBeenCalled()
  })

  // On the new-chat surface there is no conversation yet, so the choice seeds
  // the one it is about to start.
  it("writes the app default when there is no session", () => {
    externalAgentState.agents = { a1: agent("a1", "Codex") }
    render(<AgentRuntimeSelector />)
    fireEvent.click(screen.getByTestId("runtime-external-a1"))
    expect(mockSetRuntimeRef).toHaveBeenCalledWith({ kind: "external", agentId: "a1" })
    expect(mockSetSessionRuntimeRef).not.toHaveBeenCalled()
  })
})

describe("AgentRuntimeSelector — props", () => {
  it("disables the trigger when disabled=true", () => {
    render(<AgentRuntimeSelector disabled />)
    expect(document.querySelector("button[disabled]")).not.toBeNull()
  })

  it("does not disable the trigger by default", () => {
    render(<AgentRuntimeSelector />)
    expect(document.querySelector("button[disabled]")).toBeNull()
  })

  it("forwards className to the trigger", () => {
    render(<AgentRuntimeSelector className="my-custom-class" />)
    expect(document.querySelector("button.my-custom-class")).not.toBeNull()
  })

  it("lets the runtime label use the available toolbar width before truncating", () => {
    runtimeState.runtimeRef = { kind: "external", agentId: "a1" }
    externalAgentState.agents = { a1: agent("a1", "Codex") }
    render(<AgentRuntimeSelector />)
    const trigger = screen.getByTestId("agent-runtime-trigger")
    expect(trigger.className).not.toContain("max-w-[9rem]")
  })
})

describe("AgentRuntimeSelector — host-owned agents", () => {
  it("lists a ready configuration the host owns", () => {
    hostConfigsState.configs = [hostConfig("eac_1", "Pi on the box")]
    render(<AgentRuntimeSelector />)
    expect(screen.getByTestId("runtime-host:eac_1")).toBeInTheDocument()
    expect(screen.getByText("Pi on the box")).toBeInTheDocument()
  })

  // The settings panel is where an unready configuration is actionable. Here
  // it would only be a row that refuses every turn it is picked for.
  it("hides a disabled or unready configuration", () => {
    hostConfigsState.configs = [
      hostConfig("eac_off", "Disabled", { enabled: false }),
      hostConfig("eac_bad", "Unready", { lifecycleStatus: "needs-credentials" }),
    ]
    render(<AgentRuntimeSelector />)
    expect(screen.queryByTestId("runtime-host:eac_off")).not.toBeInTheDocument()
    expect(screen.queryByTestId("runtime-host:eac_bad")).not.toBeInTheDocument()
  })

  it("contributes no rows when no host owns configurations", () => {
    hostConfigsState.configs = [hostConfig("eac_1", "Pi")]
    hostConfigsState.unavailable = "no-host"
    render(<AgentRuntimeSelector />)
    expect(screen.queryByTestId("runtime-host:eac_1")).not.toBeInTheDocument()
  })

  // The stamp is captured at selection time: it is what the host admits the
  // run against, so a configuration edited after this click is refused.
  it("records the whole stamp, not just the id", () => {
    hostConfigsState.configs = [
      hostConfig("eac_1", "Pi", { revision: "eacr_7", lifecycleGeneration: 4 }),
    ]
    render(<AgentRuntimeSelector />)
    fireEvent.click(screen.getByTestId("runtime-host:eac_1"))
    expect(mockSetRuntimeRef).toHaveBeenCalledWith({
      kind: "host",
      configId: "eac_1",
      revision: "eacr_7",
      lifecycleGeneration: 4,
      name: "Pi",
    })
  })

  it("names the host agent on the chip", () => {
    hostConfigsState.configs = [hostConfig("eac_1", "Pi on the box")]
    runtimeState.runtimeRef = {
      kind: "host",
      configId: "eac_1",
      revision: "eac_1-rev",
      lifecycleGeneration: 1,
      name: "Pi on the box",
    }
    render(<AgentRuntimeSelector />)
    expect(screen.getByTestId("agent-runtime-trigger")).toHaveTextContent("Pi on the box")
  })

  it("marks the host row as the checked value", () => {
    hostConfigsState.configs = [hostConfig("eac_1", "Pi")]
    runtimeState.runtimeRef = {
      kind: "host",
      configId: "eac_1",
      revision: "eac_1-rev",
      lifecycleGeneration: 1,
      name: "Pi",
    }
    render(<AgentRuntimeSelector />)
    expect(screen.getByTestId("runtime-host:eac_1")).toHaveAttribute("aria-current", "true")
  })

  // Without the host lane suppressing it, the local-agent fallback effect would
  // bounce every host selection straight back to the built-in runtime.
  it("does not fall back to the built-in runtime while a host agent is selected", () => {
    hostConfigsState.configs = [hostConfig("eac_1", "Pi")]
    runtimeState.runtimeRef = {
      kind: "host",
      configId: "eac_1",
      revision: "eac_1-rev",
      lifecycleGeneration: 1,
      name: "Pi",
    }
    render(<AgentRuntimeSelector />)
    expect(fellBackToBuiltin()).toBe(false)
  })

  // The host swapped, or the configuration was deleted over there. Naming a
  // different agent for the user is a worse surprise than the default.
  it("drops a selection whose configuration the host no longer has", () => {
    hostConfigsState.configs = [hostConfig("eac_other", "Other")]
    runtimeState.runtimeRef = {
      kind: "host",
      configId: "eac_gone",
      revision: "r",
      lifecycleGeneration: 1,
      name: "Gone",
    }
    render(<AgentRuntimeSelector />)
    expect(screen.queryByTestId("runtime-host:eac_gone")).toBeNull()
    // And the row that IS there must not inherit the selection.
    expect(screen.getByTestId("runtime-host:eac_other")).not.toHaveAttribute("aria-current")
  })

  it("keeps local and host agents in separate groups", () => {
    externalAgentState.agents = { a1: agent("a1", "Local one") }
    hostConfigsState.configs = [hostConfig("eac_1", "Host one")]
    render(<AgentRuntimeSelector />)
    expect(screen.getByTestId("runtime-external-a1")).toBeInTheDocument()
    expect(screen.getByTestId("runtime-host:eac_1")).toBeInTheDocument()
  })
})

describe("AgentRuntimeSelector — finding a runtime in a long list", () => {
  function manyAgents(count: number) {
    return Object.fromEntries(
      Array.from({ length: count }, (_, i) => [`a${i}`, agent(`a${i}`, `Agent ${i}`)])
    )
  }

  it("offers no filter while the whole list fits in view", () => {
    externalAgentState.agents = { a1: agent("a1", "Codex") }
    render(<AgentRuntimeSelector />)
    // Built-in plus one agent. A search box here can only ever hide something.
    expect(screen.queryByTestId("runtime-search")).toBeNull()
  })

  it("offers a filter once the list is long enough to scroll", () => {
    externalAgentState.agents = manyAgents(6)
    render(<AgentRuntimeSelector />)
    expect(screen.getByTestId("runtime-search")).toBeInTheDocument()
  })

  // A filter that matches no agent is exactly when the user needs the row that
  // adds one, so the two actions must not be filterable away.
  it("keeps the way out of an empty list mounted through any filter", () => {
    externalAgentState.agents = manyAgents(6)
    render(<AgentRuntimeSelector />)
    expect(screen.getByTestId("runtime-manage-agents")).toHaveAttribute("data-force-mount", "true")
  })

  it("keeps the enable-external action mounted too", () => {
    externalAgentState.enabled = false
    externalAgentState.agents = manyAgents(6)
    render(<AgentRuntimeSelector />)
    expect(screen.getByTestId("runtime-enable-external")).toHaveAttribute(
      "data-force-mount",
      "true"
    )
  })
})

describe("AgentRuntimeSelector — which lane is active", () => {
  // cmdk owns `aria-selected` for keyboard highlight, so a row that used it
  // would claim to be the active lane merely because the arrow keys rested on
  // it. `aria-current` is the one that means "this is what the turn runs on".
  it("marks the active lane with aria-current, not aria-selected", () => {
    externalAgentState.agents = { a1: agent("a1", "Codex") }
    render(<AgentRuntimeSelector />)
    expect(screen.getByTestId("runtime-builtin")).toHaveAttribute("aria-current", "true")
    expect(screen.getByTestId("runtime-external-a1")).not.toHaveAttribute("aria-current")
    expect(screen.getByTestId("runtime-builtin")).toHaveAttribute("aria-selected", "false")
  })

  it("moves the mark with the selection", () => {
    runtimeState.runtimeRef = { kind: "external", agentId: "a1" }
    externalAgentState.agents = { a1: agent("a1", "Codex") }
    render(<AgentRuntimeSelector />)
    expect(screen.getByTestId("runtime-external-a1")).toHaveAttribute("aria-current", "true")
    expect(screen.getByTestId("runtime-builtin")).not.toHaveAttribute("aria-current")
  })

  it("ticks exactly one row", () => {
    externalAgentState.agents = { a1: agent("a1", "Codex"), a2: agent("a2", "Gemini") }
    render(<AgentRuntimeSelector />)
    expect(screen.getAllByTestId("picker-check")).toHaveLength(1)
  })
})
