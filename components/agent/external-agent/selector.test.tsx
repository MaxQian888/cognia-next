/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen, fireEvent, act } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import en from "@/i18n/messages/en.json"
import { TooltipProvider } from "@/components/ui/tooltip"
import type {
  ExternalAgentConfig,
  ExternalAgentConnectionStatus,
} from "@/types/agent/external-agent"

// --------------------------------------------------------------------------
// Mocks — DropdownMenu rendered inline (Radix pointer events unreliable in jsdom)
// --------------------------------------------------------------------------

jest.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({
    children,
    asChild: _asChild,
  }: {
    children: React.ReactNode
    asChild?: boolean
  }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dropdown-content">{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onClick,
    disabled,
  }: {
    children: React.ReactNode
    onClick?: () => void
    disabled?: boolean
  }) => (
    <div
      role="menuitem"
      aria-disabled={disabled ?? false}
      onClick={!disabled ? onClick : undefined}
    >
      {children}
    </div>
  ),
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

// Dialog rendered inline
jest.mock("@/components/ui/dialog", () => ({
  Dialog: ({
    open,
    children,
  }: {
    open?: boolean
    children: React.ReactNode
    onOpenChange?: (v: boolean) => void
  }) => (open ? <div data-testid="dialog">{children}</div> : null),
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}))

jest.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

// --------------------------------------------------------------------------
// Store + lib mocks
// --------------------------------------------------------------------------

const mockGetAllAgents = jest.fn<ExternalAgentConfig[], []>()
const mockGetConnectionStatus = jest.fn<ExternalAgentConnectionStatus, [string]>()
let mockEnabled = true

jest.mock("@/stores/agent/external-agent-store", () => ({
  useExternalAgentStore: () => ({
    getAllAgents: mockGetAllAgents,
    getConnectionStatus: mockGetConnectionStatus,
    get enabled() {
      return mockEnabled
    },
  }),
}))

jest.mock("@/lib/ai/agent/external/config-normalizer", () => ({
  getExternalAgentExecutionBlockReason: jest.fn(() => null),
}))

// Stub ExternalAgentManager to avoid its deep dependency tree
jest.mock("./manager", () => ({
  ExternalAgentManager: () => <div data-testid="external-agent-manager" />,
}))

jest.mock("./connection-status-badge", () => ({
  ConnectionStatusBadge: ({ status }: { status: string }) => (
    <span data-testid="connection-status-badge">{status}</span>
  ),
}))

// --------------------------------------------------------------------------
// Import after mocks
// --------------------------------------------------------------------------
import { ExternalAgentSelector } from "./selector"
import { getExternalAgentExecutionBlockReason } from "@/lib/ai/agent/external/config-normalizer"

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

const wrap = (ui: React.ReactNode) => (
  <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
    <TooltipProvider>{ui}</TooltipProvider>
  </NextIntlClientProvider>
)

function makeAgent(overrides: Partial<ExternalAgentConfig> = {}): ExternalAgentConfig {
  return {
    id: "agent-1",
    name: "TestAgent",
    protocol: "acp",
    transport: "http",
    enabled: true,
    defaultPermissionMode: "default",
    network: { endpoint: "http://localhost:9999" },
    timeout: 300_000,
    tags: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as ExternalAgentConfig
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe("ExternalAgentSelector", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockEnabled = true
    mockGetAllAgents.mockReturnValue([])
    mockGetConnectionStatus.mockReturnValue("disconnected")
    ;(getExternalAgentExecutionBlockReason as jest.Mock).mockReturnValue(null)
  })

  it("renders a disabled button with 'disabled' text when external agents are off", () => {
    mockEnabled = false
    render(wrap(<ExternalAgentSelector selectedAgentId={null} onAgentChange={jest.fn()} />))
    const btn = screen.getByRole("button")
    expect(btn).toBeDisabled()
    expect(screen.getByText(en.externalAgent.disabled)).toBeInTheDocument()
  })

  it("renders the 'Built-in' label when no agent is selected and agents are enabled", () => {
    render(wrap(<ExternalAgentSelector selectedAgentId={null} onAgentChange={jest.fn()} />))
    expect(screen.getByText(en.externalAgent.builtIn)).toBeInTheDocument()
  })

  it("renders the selected agent name in the trigger when an agent is selected", () => {
    const agent = makeAgent({ id: "a1", name: "Codex" })
    mockGetAllAgents.mockReturnValue([agent])

    render(wrap(<ExternalAgentSelector selectedAgentId="a1" onAgentChange={jest.fn()} />))
    // The agent name appears at least in the trigger span and the dropdown list
    const matches = screen.getAllByText("Codex")
    expect(matches.length).toBeGreaterThanOrEqual(1)
  })

  it("shows the selectAgent label in the dropdown content", () => {
    render(wrap(<ExternalAgentSelector selectedAgentId={null} onAgentChange={jest.fn()} />))
    // With the inline mock, DropdownMenuContent always renders
    expect(screen.getByText(en.externalAgent.selectAgent)).toBeInTheDocument()
  })

  it("shows the built-in agent option in the dropdown", () => {
    render(wrap(<ExternalAgentSelector selectedAgentId={null} onAgentChange={jest.fn()} />))
    expect(screen.getByText(en.externalAgent.builtInAgent)).toBeInTheDocument()
    expect(screen.getByText(en.externalAgent.builtInAgentDesc)).toBeInTheDocument()
  })

  it("calls onAgentChange(null) when the built-in option is clicked", () => {
    const onAgentChange = jest.fn()
    render(wrap(<ExternalAgentSelector selectedAgentId="a1" onAgentChange={onAgentChange} />))
    fireEvent.click(screen.getByText(en.externalAgent.builtInAgent).closest("[role='menuitem']")!)
    expect(onAgentChange).toHaveBeenCalledWith(null)
  })

  it("lists external agents in the dropdown", () => {
    const agent = makeAgent({ id: "a1", name: "Alpha" })
    mockGetAllAgents.mockReturnValue([agent])

    render(wrap(<ExternalAgentSelector selectedAgentId={null} onAgentChange={jest.fn()} />))
    expect(screen.getByText("Alpha")).toBeInTheDocument()
  })

  it("calls onAgentChange with the agent id when an external agent is clicked", () => {
    const onAgentChange = jest.fn()
    const agent = makeAgent({ id: "a1", name: "Alpha" })
    mockGetAllAgents.mockReturnValue([agent])

    render(wrap(<ExternalAgentSelector selectedAgentId={null} onAgentChange={onAgentChange} />))
    const alphaItem = screen.getByText("Alpha").closest("[role='menuitem']")!
    fireEvent.click(alphaItem)
    expect(onAgentChange).toHaveBeenCalledWith("a1")
  })

  it("shows a checkmark next to the currently selected external agent", () => {
    const agent = makeAgent({ id: "a1", name: "Alpha" })
    mockGetAllAgents.mockReturnValue([agent])

    const { container } = render(
      wrap(<ExternalAgentSelector selectedAgentId="a1" onAgentChange={jest.fn()} />)
    )
    // The Check icon (lucide-check svg) is rendered next to the selected agent
    const checkIcons = container.querySelectorAll(".lucide-check")
    expect(checkIcons.length).toBeGreaterThanOrEqual(1)
  })

  it("shows a checkmark next to the built-in option when no agent is selected", () => {
    const { container } = render(
      wrap(<ExternalAgentSelector selectedAgentId={null} onAgentChange={jest.fn()} />)
    )
    // Check icon for built-in option
    const checkIcons = container.querySelectorAll(".lucide-check")
    expect(checkIcons.length).toBeGreaterThanOrEqual(1)
  })

  it("renders the 'Coming soon' badge for agents with an execution block", () => {
    const agent = makeAgent({ id: "a1", name: "Blocked" })
    mockGetAllAgents.mockReturnValue([agent])
    ;(getExternalAgentExecutionBlockReason as jest.Mock).mockReturnValue("Needs Tauri runtime.")

    render(wrap(<ExternalAgentSelector selectedAgentId={null} onAgentChange={jest.fn()} />))
    expect(screen.getByText(en.externalAgent.selectorComingSoon)).toBeInTheDocument()
  })

  it("renders the execution blocked reason text beneath the blocked agent", () => {
    const agent = makeAgent({ id: "a1", name: "Blocked" })
    mockGetAllAgents.mockReturnValue([agent])
    ;(getExternalAgentExecutionBlockReason as jest.Mock).mockReturnValue("Needs Tauri runtime.")

    render(wrap(<ExternalAgentSelector selectedAgentId={null} onAgentChange={jest.fn()} />))
    expect(screen.getByText("Needs Tauri runtime.")).toBeInTheDocument()
  })

  it("marks the dropdown item as disabled for blocked agents", () => {
    const agent = makeAgent({ id: "a1", name: "Blocked" })
    mockGetAllAgents.mockReturnValue([agent])
    ;(getExternalAgentExecutionBlockReason as jest.Mock).mockReturnValue("Needs Tauri runtime.")

    render(wrap(<ExternalAgentSelector selectedAgentId={null} onAgentChange={jest.fn()} />))
    const agentItem = screen.getByText("Blocked").closest("[role='menuitem']")
    expect(agentItem).toHaveAttribute("aria-disabled", "true")
  })

  it("does NOT call onAgentChange when a blocked agent item is clicked", () => {
    const onAgentChange = jest.fn()
    const agent = makeAgent({ id: "a1", name: "Blocked" })
    mockGetAllAgents.mockReturnValue([agent])
    ;(getExternalAgentExecutionBlockReason as jest.Mock).mockReturnValue("Needs Tauri runtime.")

    render(wrap(<ExternalAgentSelector selectedAgentId={null} onAgentChange={onAgentChange} />))
    const agentItem = screen.getByText("Blocked").closest("[role='menuitem']")!
    fireEvent.click(agentItem)
    expect(onAgentChange).not.toHaveBeenCalled()
  })

  it("shows the Manage menu item in the dropdown", () => {
    render(wrap(<ExternalAgentSelector selectedAgentId={null} onAgentChange={jest.fn()} />))
    expect(screen.getByText(en.externalAgent.manage)).toBeInTheDocument()
  })

  it("opens the manage dialog when the Manage item is clicked", async () => {
    render(wrap(<ExternalAgentSelector selectedAgentId={null} onAgentChange={jest.fn()} />))
    const manageItem = screen.getByText(en.externalAgent.manage).closest("[role='menuitem']")!
    await act(async () => {
      fireEvent.click(manageItem)
    })
    expect(screen.getByTestId("dialog")).toBeInTheDocument()
    expect(screen.getByText(en.externalAgent.manageAgents)).toBeInTheDocument()
    expect(screen.getByTestId("external-agent-manager")).toBeInTheDocument()
  })

  it("renders the 'Manage Agents' settings menu item when onOpenSettings is provided", () => {
    render(
      wrap(
        <ExternalAgentSelector
          selectedAgentId={null}
          onAgentChange={jest.fn()}
          onOpenSettings={jest.fn()}
        />
      )
    )
    expect(screen.getByText(en.externalAgent.manageAgents)).toBeInTheDocument()
  })

  it("calls onOpenSettings when the settings menu item is clicked", () => {
    const onOpenSettings = jest.fn()
    render(
      wrap(
        <ExternalAgentSelector
          selectedAgentId={null}
          onAgentChange={jest.fn()}
          onOpenSettings={onOpenSettings}
        />
      )
    )
    const manageAgentsItem = screen
      .getAllByText(en.externalAgent.manageAgents)
      .map((el) => el.closest("[role='menuitem']"))
      .find((el) => el !== null)
    fireEvent.click(manageAgentsItem!)
    expect(onOpenSettings).toHaveBeenCalled()
  })

  it("does NOT render the 'Manage Agents' settings menu item when onOpenSettings is absent", () => {
    render(wrap(<ExternalAgentSelector selectedAgentId={null} onAgentChange={jest.fn()} />))
    expect(screen.queryByText(en.externalAgent.manageAgents)).not.toBeInTheDocument()
  })

  it("renders the protocol badge (uppercase) for listed external agents", () => {
    const agent = makeAgent({ id: "a1", name: "ProtoAgent", protocol: "acp" })
    mockGetAllAgents.mockReturnValue([agent])

    render(wrap(<ExternalAgentSelector selectedAgentId={null} onAgentChange={jest.fn()} />))
    expect(screen.getByText("ACP")).toBeInTheDocument()
  })

  it("shows ConnectionStatusBadge for each listed agent", () => {
    const agent = makeAgent({ id: "a1", name: "StatusAgent" })
    mockGetAllAgents.mockReturnValue([agent])
    mockGetConnectionStatus.mockReturnValue("connected")

    render(wrap(<ExternalAgentSelector selectedAgentId={null} onAgentChange={jest.fn()} />))
    expect(screen.getByTestId("connection-status-badge")).toBeInTheDocument()
  })

  it("renders the trigger button as disabled when disabled prop is set", () => {
    render(
      wrap(<ExternalAgentSelector selectedAgentId={null} onAgentChange={jest.fn()} disabled />)
    )
    // The DropdownMenuTrigger asChild renders the Button directly; it should be disabled
    const buttons = screen.getAllByRole("button")
    // Find the main trigger button (not inside the dialog)
    const triggerBtn = buttons.find((b) => b.hasAttribute("disabled"))
    expect(triggerBtn).toBeDefined()
  })

  it("renders no external agents section when agents list is empty", () => {
    mockGetAllAgents.mockReturnValue([])
    render(wrap(<ExternalAgentSelector selectedAgentId={null} onAgentChange={jest.fn()} />))
    expect(screen.queryByText(en.externalAgent.externalAgents)).not.toBeInTheDocument()
  })

  it("renders the external agents section label when agents exist", () => {
    const agent = makeAgent({ id: "a1", name: "Foo" })
    mockGetAllAgents.mockReturnValue([agent])

    render(wrap(<ExternalAgentSelector selectedAgentId={null} onAgentChange={jest.fn()} />))
    expect(screen.getByText(en.externalAgent.externalAgents)).toBeInTheDocument()
  })

  it("passes the className prop to the trigger button", () => {
    render(
      wrap(
        <ExternalAgentSelector
          selectedAgentId={null}
          onAgentChange={jest.fn()}
          className="custom-trigger"
        />
      )
    )
    const btn = screen.getByRole("button", { hidden: true })
    // The class may be applied to the button itself
    expect(btn.className).toContain("custom-trigger")
  })
})
