/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import { AgentRuntimeSelector } from "./runtime-selector"

// Passthrough i18n — assertions use raw translation keys.
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// Flatten Radix dropdown primitives so the content is always visible and
// RadioItems are directly clickable in jsdom without pointer-event plumbing.
jest.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  // Spreads the rest of the props (data-testid, data-labelled, …): the chip
  // encodes its labelled/glyph state as data attributes, and a mock that
  // dropped them would make those assertions untestable.
  DropdownMenuTrigger: ({
    children,
    ...rest
  }: {
    children: React.ReactNode
  } & React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...rest}>{children}</button>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuItem: ({
    children,
    onSelect,
    "data-testid": testId,
  }: {
    children: React.ReactNode
    onSelect?: () => void
    "data-testid"?: string
  }) => (
    <button data-testid={testId ?? "menu-item"} onClick={() => onSelect?.()}>
      {children}
    </button>
  ),
  DropdownMenuRadioGroup: ({
    children,
    value,
    onValueChange,
  }: {
    children: React.ReactNode
    value: string
    onValueChange: (v: string) => void
  }) => (
    <div data-value={value} data-testid="radio-group" onClick={onValueChangeProbe(onValueChange)}>
      {children}
    </div>
  ),
  DropdownMenuRadioItem: ({
    children,
    value,
    disabled,
  }: {
    children: React.ReactNode
    value: string
    disabled?: boolean
  }) => (
    <div
      data-testid={`radio-item-${value}`}
      role="menuitemradio"
      aria-checked={false}
      aria-disabled={disabled ?? false}
      data-value={value}
    >
      {children}
    </div>
  ),
}))

// Radix routes selection through the group; in the flattened mock the item that
// was clicked carries the value, so bubble it up the same way.
function onValueChangeProbe(onValueChange: (v: string) => void) {
  return (event: React.MouseEvent<HTMLDivElement>) => {
    const item = (event.target as HTMLElement).closest<HTMLElement>("[data-value]")
    const value = item?.dataset.value
    if (value) onValueChange(value)
  }
}

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
const mockBlock = (agent: {
  enabled?: boolean
  protocol?: string
}): { code: string; reason: string; transient?: boolean } | null => {
  if (agent.enabled === false) return { code: "agent_disabled", reason: "Agent is disabled." }
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
  getExternalAgentExecutionBlock: (agent: { enabled?: boolean; protocol?: string }) =>
    mockBlock(agent),
}))
jest.mock("@/lib/ai/agent/external/protocol-adapter", () => ({
  onProtocolAdapterRegistryChange: () => () => {},
}))
jest.mock("@/lib/ai/agent/external/presets", () => ({
  isFromPreset: () => null,
}))

const mockSetRuntime = jest.fn()
const mockSetExternalAgentId = jest.fn()
const runtimeState = {
  runtime: "claude-sdk" as "claude-sdk" | "external",
  setRuntime: mockSetRuntime,
  externalAgentId: null as string | null,
  setExternalAgentId: mockSetExternalAgentId,
}

jest.mock("@/stores/agent", () => ({
  useAgentRuntimeStore: (selector: (s: typeof runtimeState) => unknown) => selector(runtimeState),
}))

const mockSetExternalEnabled = jest.fn()
const externalAgentState = {
  enabled: true,
  agents: {} as Record<string, { id: string; name: string; enabled: boolean; protocol: string }>,
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

function agent(id: string, name: string, enabled = true) {
  return { id, name, enabled, protocol: "acp" }
}

beforeEach(() => {
  runtimeState.runtime = "claude-sdk"
  runtimeState.externalAgentId = null
  externalAgentState.enabled = true
  externalAgentState.agents = {}
  externalAgentState.connectionStatus = {}
  externalAgentState.agentValidity = {}
  mockSetRuntime.mockClear()
  mockSetExternalAgentId.mockClear()
  mockSelectExternalAgent.mockClear()
  mockSetExternalEnabled.mockClear()
})

describe("AgentRuntimeSelector — chip label", () => {
  // The label is earned by being a choice. On the built-in runtime the trigger
  // is a glyph: "Claude SDK" under every turn was the one value the chip can
  // never be wrong about, and it cost the composer's status line ~100px it did
  // not have. The wording moves into the accessible name, not out of reach.
  it("wears a glyph on the built-in runtime and names it in the accessible name", () => {
    render(<AgentRuntimeSelector />)
    const trigger = screen.getByTestId("agent-runtime-trigger")
    expect(trigger).not.toHaveAttribute("data-labelled")
    expect(trigger).toHaveTextContent("")
    expect(trigger.getAttribute("aria-label")).toContain("claudeSdk")
  })

  it("names the selected external agent instead of a generic 'external' label", () => {
    runtimeState.runtime = "external"
    runtimeState.externalAgentId = "a1"
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
    expect(screen.getByTestId("radio-item-claude-sdk")).toBeInTheDocument()
    expect(screen.getByTestId("radio-item-external:a1")).toBeInTheDocument()
    expect(screen.getByTestId("radio-item-external:a2")).toBeInTheDocument()
    // The old two-control split is gone: there is no bare "external" lane to
    // land on without an agent.
    expect(screen.queryByTestId("radio-item-external")).toBeNull()
  })

  it("sorts agent rows by name", () => {
    externalAgentState.agents = { a1: agent("a1", "Zed"), a2: agent("a2", "Codex") }
    render(<AgentRuntimeSelector />)
    const items = screen.getAllByRole("menuitemradio").map((el) => el.dataset.value)
    expect(items).toEqual(["claude-sdk", "external:a2", "external:a1"])
  })

  it("selects the runtime AND the agent record in a single click", () => {
    externalAgentState.agents = { a1: agent("a1", "Codex") }
    render(<AgentRuntimeSelector />)
    fireEvent.click(screen.getByTestId("radio-item-external:a1"))
    expect(mockSelectExternalAgent).toHaveBeenCalledWith("a1")
    expect(mockSetRuntime).toHaveBeenCalledWith("external")
  })

  it("switches back to the built-in runtime without touching the agent record", () => {
    runtimeState.runtime = "external"
    runtimeState.externalAgentId = "a1"
    externalAgentState.agents = { a1: agent("a1", "Codex") }
    render(<AgentRuntimeSelector />)
    fireEvent.click(screen.getByTestId("radio-item-claude-sdk"))
    expect(mockSetRuntime).toHaveBeenCalledWith("claude-sdk")
    expect(mockSelectExternalAgent).not.toHaveBeenCalled()
  })

  it("disables a blocked agent and shows why, instead of hiding it", () => {
    externalAgentState.agents = { a1: agent("a1", "Codex", false) }
    render(<AgentRuntimeSelector />)
    expect(screen.getByTestId("radio-item-external:a1")).toHaveAttribute("aria-disabled", "true")
    expect(screen.getByText("Agent is disabled.")).toBeInTheDocument()
  })

  it("ignores a click on a blocked agent", () => {
    externalAgentState.agents = { a1: agent("a1", "Codex", false) }
    render(<AgentRuntimeSelector />)
    fireEvent.click(screen.getByTestId("radio-item-external:a1"))
    expect(mockSetRuntime).not.toHaveBeenCalled()
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
      expect(screen.queryByTestId("radio-item-external:a1")).toBeNull()
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
      expect(screen.getByTestId("radio-item-external:a1")).toHaveAttribute("aria-disabled", "false")
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
    runtimeState.runtime = "external"
    runtimeState.externalAgentId = "deleted"
    render(<AgentRuntimeSelector />)
    expect(mockSetRuntime).toHaveBeenCalledWith("claude-sdk")
  })

  it("falls back when the selected agent can no longer execute", () => {
    runtimeState.runtime = "external"
    runtimeState.externalAgentId = "a1"
    externalAgentState.agents = { a1: agent("a1", "Codex", false) }
    render(<AgentRuntimeSelector />)
    expect(mockSetRuntime).toHaveBeenCalledWith("claude-sdk")
  })

  it("leaves a valid external selection alone", () => {
    runtimeState.runtime = "external"
    runtimeState.externalAgentId = "a1"
    externalAgentState.agents = { a1: agent("a1", "Codex") }
    render(<AgentRuntimeSelector />)
    expect(mockSetRuntime).not.toHaveBeenCalled()
  })

  it("keeps the selection while a plugin adapter has not registered yet", () => {
    // The chip mounts before the plugin manager finishes registering protocol
    // adapters, so a plugin-contributed agent reads as blocked at first render.
    // Persisting the fallback there silently moved the user off their chosen
    // agent on every restart, and the later registry tick never undid it.
    runtimeState.runtime = "external"
    runtimeState.externalAgentId = "a1"
    externalAgentState.agents = { a1: { ...agent("a1", "My Plugin Agent"), protocol: "acme:rpc" } }
    render(<AgentRuntimeSelector />)
    expect(mockSetRuntime).not.toHaveBeenCalled()
  })

  it("still renders a transiently blocked agent as unselectable", () => {
    // Not persisting the fallback must not mean pretending it works: the row
    // stays disabled and carries its reason until the adapter registers.
    runtimeState.runtime = "external"
    runtimeState.externalAgentId = "a1"
    externalAgentState.agents = { a1: { ...agent("a1", "My Plugin Agent"), protocol: "acme:rpc" } }
    render(<AgentRuntimeSelector />)
    expect(screen.getByTestId("radio-item-external:a1")).toHaveAttribute("aria-disabled", "true")
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
    runtimeState.runtime = "external"
    runtimeState.externalAgentId = "a1"
    externalAgentState.agents = { a1: agent("a1", "Codex") }
    render(<AgentRuntimeSelector />)
    const trigger = screen.getByTestId("agent-runtime-trigger")
    expect(trigger.className).not.toContain("max-w-[9rem]")
  })
})
