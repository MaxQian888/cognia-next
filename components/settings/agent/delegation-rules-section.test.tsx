import React from "react"
import { render, screen, within, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { DelegationRulesSection } from "./delegation-rules-section"
import type { ExternalAgentDelegationRule } from "@/types/agent/external-agent"

const addRule = jest.fn()
const updateRule = jest.fn()
const removeRule = jest.fn()
const reorderRules = jest.fn()
const updateConfig = jest.fn()
const toastError = jest.fn()
let mockRules: ExternalAgentDelegationRule[] = []
let mockAgents: Array<Record<string, unknown> & { id: string; name: string }> = []

jest.mock("@/lib/ai/agent/external/lifecycle/service", () => ({
  getExternalAgentLifecycleService: async () => ({ updateConfig }),
}))
jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: (...args: unknown[]) => toastError(...args) },
}))

jest.mock("@/hooks/ui/use-mobile", () => ({ useIsMobile: jest.fn(() => false) }))

import { useIsMobile } from "@/hooks/ui/use-mobile"
const useIsMobileMock = useIsMobile as jest.Mock

jest.mock("@/stores/agent/external-agent-store", () => ({
  useExternalAgentStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = {
      delegationRules: mockRules,
      agents: Object.fromEntries(mockAgents.map((agent) => [agent.id, agent])),
      connectionStatus: { a1: "connected" },
      addDelegationRule: addRule,
      updateDelegationRule: updateRule,
      removeDelegationRule: removeRule,
      reorderDelegationRules: reorderRules,
    }
    return selector ? selector(state) : state
  },
  selectDelegationRules: () => mockRules,
  selectAgents: (state: Record<string, unknown>) => state.agents,
  selectConnectionStatus: (state: Record<string, unknown>) => state.connectionStatus,
}))

function rule(overrides: Partial<ExternalAgentDelegationRule> = {}): ExternalAgentDelegationRule {
  return {
    id: "r1",
    name: "Code → CC",
    condition: "keyword",
    matcher: "refactor",
    targetAgentId: "a1",
    priority: 1,
    enabled: true,
    ...overrides,
  }
}

beforeEach(() => {
  addRule.mockClear()
  updateRule.mockClear()
  removeRule.mockClear()
  reorderRules.mockClear()
  updateConfig.mockReset().mockResolvedValue(undefined)
  toastError.mockClear()
  mockRules = []
  mockAgents = [{ id: "a1", name: "Claude Code", enabled: true }]
  useIsMobileMock.mockReturnValue(false)
})

/** Two configurations of the Codex runtime that differ only in permission mode. */
function codexPair() {
  const base = {
    protocol: "acp",
    transport: "stdio",
    process: { command: "codex", args: [] },
    metadata: { preset: "codex" },
    enabled: true,
  }
  return [
    { ...base, id: "c1", name: "Codex", defaultPermissionMode: "plan" },
    { ...base, id: "c2", name: "Codex", defaultPermissionMode: "bypassPermissions" },
  ]
}

describe("DelegationRulesSection", () => {
  it("shows the empty state when there are no rules", () => {
    render(<DelegationRulesSection />)
    expect(screen.getByText("No delegation rules")).toBeInTheDocument()
  })

  it("keeps the focus heading and renders ordered divided rows without cards", () => {
    mockRules = [rule()]
    const { container } = render(<DelegationRulesSection />)
    expect(screen.getByRole("heading", { name: "Automatic routing" })).toHaveAttribute(
      "tabindex",
      "-1"
    )
    expect(screen.getByRole("heading", { name: "Automatic routing" })).toHaveAttribute(
      "data-detail-heading"
    )
    expect(screen.getByRole("list")).toHaveClass("divide-y")
    expect(screen.getByLabelText("Priority 1")).toBeInTheDocument()
    expect(screen.getByTestId("delegation-rule-r1")).toHaveTextContent("Connected")
    expect(container.querySelector('[data-slot="card"]')).not.toBeInTheDocument()
  })

  it("opens Add agent from the unconfigured empty state", async () => {
    mockAgents = []
    const onAddAgent = jest.fn()
    const user = userEvent.setup()
    render(<DelegationRulesSection onAddAgent={onAddAgent} />)
    expect(screen.getByText("No agents configured")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Add agent" }))
    expect(onAddAgent).toHaveBeenCalledTimes(1)
  })

  it("opens the first disabled agent when every agent is disabled", async () => {
    mockAgents = [{ id: "a1", name: "Claude Code", enabled: false }]
    const onOpenAgent = jest.fn()
    const user = userEvent.setup()
    render(<DelegationRulesSection onOpenAgent={onOpenAgent} />)
    expect(screen.getByText("All agents are disabled")).toBeInTheDocument()
    expect(
      screen.queryByText("Configure an external agent first, then add delegation rules.")
    ).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Open Claude Code" }))
    expect(onOpenAgent).toHaveBeenCalledWith("a1")
    // The empty state's step comes first; adding a rule is the secondary path.
    expect(screen.getByTestId("delegation-add-rule")).toHaveAttribute("data-variant", "outline")
  })

  it("disables Add Rule when no external agents are configured", () => {
    mockAgents = []
    render(<DelegationRulesSection />)
    expect(screen.getByRole("button", { name: /Add Rule/i })).toBeDisabled()
  })

  it("creates a rule with the form values + first agent as default target", async () => {
    const user = userEvent.setup()
    render(<DelegationRulesSection />)
    await act(async () => {
      await user.click(screen.getByRole("button", { name: /Add Rule/i }))
    })
    await act(async () => {
      await user.type(screen.getByLabelText("Rule name"), "Refactors")
      await user.type(screen.getByLabelText("Matcher"), "refactor")
    })
    await act(async () => {
      await user.click(screen.getByRole("button", { name: /^Add$/i }))
    })
    expect(addRule).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Refactors",
        condition: "keyword",
        matcher: "refactor",
        targetAgentId: "a1",
        enabled: true,
      })
    )
  })

  it("toggles a rule's enabled flag", async () => {
    const user = userEvent.setup()
    mockRules = [rule({ enabled: true })]
    render(<DelegationRulesSection />)
    const row = screen.getByTestId("delegation-rule-r1")
    await act(async () => {
      await user.click(within(row).getByRole("switch"))
    })
    expect(updateRule).toHaveBeenCalledWith("r1", { enabled: false })
  })

  it("asks before deleting, naming the rule, and deletes on confirm", async () => {
    const user = userEvent.setup()
    mockRules = [rule()]
    render(<DelegationRulesSection />)
    const row = screen.getByTestId("delegation-rule-r1")
    await act(async () => {
      await user.click(within(row).getByRole("button", { name: "Delete rule Code → CC" }))
    })
    expect(removeRule).not.toHaveBeenCalled()
    const confirm = screen.getByRole("alertdialog")
    expect(confirm).toHaveTextContent('Delete rule "Code → CC"?')
    await act(async () => {
      await user.click(within(confirm).getByRole("button", { name: /^delete$/i }))
    })
    expect(removeRule).toHaveBeenCalledWith("r1")
  })

  it("keeps the rule when the deletion is cancelled", async () => {
    const user = userEvent.setup()
    mockRules = [rule()]
    render(<DelegationRulesSection />)
    await act(async () => {
      await user.click(screen.getByRole("button", { name: /delete rule/i }))
    })
    await act(async () => {
      await user.click(screen.getByRole("button", { name: /^cancel$/i }))
    })
    expect(removeRule).not.toHaveBeenCalled()
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
  })

  it("names the rule in the toggle's accessible name", () => {
    mockRules = [rule({ id: "r1", name: "Refactors" }), rule({ id: "r2", name: "Tests" })]
    render(<DelegationRulesSection />)
    expect(screen.getByRole("switch", { name: "Enable rule Refactors" })).toBeInTheDocument()
    expect(screen.getByRole("switch", { name: "Enable rule Tests" })).toBeInTheDocument()
  })

  it("tells two configurations of one runtime apart in the rows and the target picker", async () => {
    const user = userEvent.setup()
    mockAgents = codexPair()
    mockRules = [rule({ id: "r1", targetAgentId: "c2" })]
    render(<DelegationRulesSection />)
    // The row shows what sets its target apart, not just the shared name.
    const row = screen.getByTestId("delegation-rule-r1")
    expect(within(row).getByTestId("instance-trait-chips")).toHaveTextContent("Bypass")

    await act(async () => {
      await user.click(screen.getByRole("button", { name: /Add Rule/i }))
    })
    await act(async () => {
      await user.click(screen.getByLabelText("Target agent"))
    })
    const options = screen.getAllByRole("option")
    expect(options).toHaveLength(2)
    expect(within(options[0]).getByTestId("delegation-target-traits-c1")).toHaveTextContent("Plan")
    expect(within(options[1]).getByTestId("delegation-target-traits-c2")).toHaveTextContent(
      "Bypass"
    )
  })

  it("does not add a trait line to a configuration with no sibling", async () => {
    const user = userEvent.setup()
    render(<DelegationRulesSection />)
    await act(async () => {
      await user.click(screen.getByRole("button", { name: /Add Rule/i }))
    })
    await act(async () => {
      await user.click(screen.getByLabelText("Target agent"))
    })
    expect(screen.queryByTestId("delegation-target-traits-a1")).not.toBeInTheDocument()
  })

  it("labels a rule whose target no longer exists instead of printing its id", () => {
    mockRules = [rule({ targetAgentId: "deleted-agent" })]
    render(<DelegationRulesSection />)
    const row = screen.getByTestId("delegation-rule-r1")
    expect(row).toHaveTextContent("Unavailable agent")
    expect(row).not.toHaveTextContent("deleted-agent")
  })

  it("opens the rule editor as a bottom drawer on a phone", async () => {
    const user = userEvent.setup()
    useIsMobileMock.mockReturnValue(true)
    render(<DelegationRulesSection />)
    await act(async () => {
      await user.click(screen.getByRole("button", { name: /Add Rule/i }))
    })
    expect(screen.getByTestId("delegation-rule-editor-drawer")).toBeInTheDocument()
    expect(screen.getByLabelText("Rule name")).toBeInTheDocument()
  })

  it("gives the move buttons a touch hit area", () => {
    mockRules = [rule({ id: "r1" }), rule({ id: "r2", name: "Tests" })]
    render(<DelegationRulesSection />)
    for (const button of screen.getAllByRole("button", { name: /Move (up|down)/i })) {
      expect(button).toHaveClass("touch-hit")
    }
  })

  it("opens the create dialog pre-targeted when a caller seeds an agent", () => {
    mockAgents = [
      { id: "a1", name: "Claude Code", enabled: true },
      { id: "a2", name: "Codex", enabled: true },
    ]
    render(<DelegationRulesSection createForAgent={{ agentId: "a2" }} />)
    const dialog = screen.getByRole("dialog")
    // The target select shows the seeded agent rather than the first agent.
    expect(within(dialog).getByText("Codex")).toBeInTheDocument()
  })

  it("ignores a seed pointing at an agent that cannot be targeted", () => {
    mockAgents = [{ id: "a1", name: "Claude Code", enabled: true }]
    render(<DelegationRulesSection createForAgent={{ agentId: "missing" }} />)
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("does not reopen the dialog for the same seed object twice", async () => {
    mockAgents = [{ id: "a1", name: "Claude Code", enabled: true }]
    const seed = { agentId: "a1" }
    const { rerender } = render(<DelegationRulesSection createForAgent={seed} />)
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    // Same identity on a re-render must not reopen after the user closes it.
    rerender(<DelegationRulesSection createForAgent={seed} />)
    const user = userEvent.setup()
    await act(async () => {
      await user.keyboard("{Escape}")
    })
    rerender(<DelegationRulesSection createForAgent={seed} />)
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("reorders rules with the move buttons", async () => {
    const user = userEvent.setup()
    mockRules = [rule({ id: "r1" }), rule({ id: "r2", name: "Tests" })]
    render(<DelegationRulesSection />)
    const firstRow = screen.getByTestId("delegation-rule-r1")
    await act(async () => {
      await user.click(within(firstRow).getByRole("button", { name: /Move down/i }))
    })
    expect(reorderRules).toHaveBeenCalledWith(["r2", "r1"])
  })
  it("preserves disabled targets and enables them from their rule row", async () => {
    mockAgents = [{ id: "a1", name: "Claude Code", enabled: false }]
    mockRules = [rule()]
    const user = userEvent.setup()
    render(<DelegationRulesSection />)
    const row = screen.getByTestId("delegation-rule-r1")
    expect(row).toHaveTextContent("Claude Code")
    expect(row).toHaveTextContent("Disabled")
    expect(row).toHaveTextContent("This rule will not run until its target agent is enabled.")
    expect(row).not.toHaveTextContent("Unavailable agent")
    await user.click(within(row).getByRole("button", { name: "Enable" }))
    expect(updateConfig).toHaveBeenCalledWith("a1", { enabled: true })
  })

  it("lists enabled targets first and allows selecting and saving a disabled target", async () => {
    mockAgents = [
      { id: "a2", name: "Codex", enabled: false },
      { id: "a1", name: "Claude Code", enabled: true },
    ]
    const user = userEvent.setup()
    render(<DelegationRulesSection />)
    await user.click(screen.getByRole("button", { name: "Add Rule" }))
    await user.click(screen.getByLabelText("Target agent"))
    const options = screen.getAllByRole("option")
    expect(options[0]).toHaveTextContent("Claude Code")
    expect(options[1]).toHaveTextContent("Codex (disabled)")
    await user.click(options[1])
    expect(
      screen.getByText("This rule will not run until its target agent is enabled.")
    ).toBeInTheDocument()
    await user.type(screen.getByLabelText("Rule name"), "Disabled target")
    await user.type(screen.getByLabelText("Matcher"), "refactor")
    await user.click(screen.getByRole("button", { name: "Add" }))
    expect(addRule).toHaveBeenCalledWith(expect.objectContaining({ targetAgentId: "a2" }))
  })

  it("accepts a disabled target from the readiness seed", () => {
    mockAgents = [{ id: "a1", name: "Claude Code", enabled: false }]
    render(<DelegationRulesSection createForAgent={{ agentId: "a1" }} />)
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    expect(screen.getByLabelText("Target agent")).toHaveTextContent("Claude Code (disabled)")
  })

  it("reports required name and matcher errors and focuses the first invalid field", async () => {
    const user = userEvent.setup()
    render(<DelegationRulesSection />)
    await user.click(screen.getByRole("button", { name: "Add Rule" }))
    await user.click(screen.getByRole("button", { name: "Add" }))
    const name = screen.getByLabelText("Rule name")
    const matcher = screen.getByLabelText("Matcher")
    expect(name).toHaveAttribute("aria-invalid", "true")
    expect(name).toHaveAccessibleDescription("Enter a rule name.")
    expect(name).toHaveFocus()
    expect(matcher).toHaveAttribute("aria-invalid", "true")
    expect(matcher).toHaveAccessibleDescription(
      expect.stringContaining("Enter a matcher for this condition.")
    )
    expect(addRule).not.toHaveBeenCalled()
    await user.type(name, "Refactors")
    await user.click(screen.getByRole("button", { name: "Add" }))
    expect(matcher).toHaveFocus()
  })

  it("requires an existing target and focuses the picker instead of saving a deleted target", async () => {
    mockRules = [rule({ targetAgentId: "deleted" })]
    const user = userEvent.setup()
    render(<DelegationRulesSection />)
    await user.click(screen.getByRole("button", { name: "Edit rule Code → CC" }))
    await user.click(screen.getByRole("button", { name: "Save" }))
    const target = screen.getByLabelText("Target agent")
    expect(target).toHaveAttribute("aria-invalid", "true")
    expect(target).toHaveAccessibleDescription("Select an agent that still exists.")
    expect(target).toHaveFocus()
    expect(updateRule).not.toHaveBeenCalled()
  })

  it("saves an always condition without requiring a matcher", async () => {
    const user = userEvent.setup()
    render(<DelegationRulesSection />)
    await user.click(screen.getByRole("button", { name: "Add Rule" }))
    await user.type(screen.getByLabelText("Rule name"), "Catch all")
    await user.click(screen.getByLabelText("Condition"))
    await user.click(screen.getByRole("option", { name: "Always" }))
    await user.click(screen.getByRole("button", { name: "Add" }))
    expect(addRule).toHaveBeenCalledWith(
      expect.objectContaining({ condition: "always", matcher: "" })
    )
  })
  it("reports lifecycle enable failures and keeps the disabled target available to retry", async () => {
    mockAgents = [{ id: "a1", name: "Claude Code", enabled: false }]
    mockRules = [rule()]
    updateConfig.mockRejectedValueOnce(new Error("enable failed"))
    const user = userEvent.setup()
    render(<DelegationRulesSection />)
    await user.click(screen.getByRole("button", { name: "Enable" }))
    expect(toastError).toHaveBeenCalledWith(
      jest.requireActual("@/i18n/messages/en/externalAgent.json").lifecycleErrors.unknown
    )
    expect(screen.getByRole("button", { name: "Enable" })).toBeEnabled()
    expect(screen.getByTestId("delegation-rule-r1")).toHaveTextContent("Disabled")
  })
})
