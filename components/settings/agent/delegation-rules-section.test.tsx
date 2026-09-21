import React from "react"
import { render, screen, within, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { DelegationRulesSection } from "./delegation-rules-section"
import type { ExternalAgentDelegationRule } from "@/types/agent/external-agent"

const addRule = jest.fn()
const updateRule = jest.fn()
const removeRule = jest.fn()
const reorderRules = jest.fn()
let mockRules: ExternalAgentDelegationRule[] = []
let mockAgents: Array<{ id: string; name: string }> = []

jest.mock("@/stores/agent/external-agent-store", () => ({
  useExternalAgentStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = {
      delegationRules: mockRules,
      agents: {},
      addDelegationRule: addRule,
      updateDelegationRule: updateRule,
      removeDelegationRule: removeRule,
      reorderDelegationRules: reorderRules,
    }
    return selector ? selector(state) : state
  },
  selectDelegationRules: () => mockRules,
  selectEnabledAgents: () => mockAgents,
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
  mockRules = []
  mockAgents = [{ id: "a1", name: "Claude Code" }]
})

describe("DelegationRulesSection", () => {
  it("shows the empty state when there are no rules", () => {
    render(<DelegationRulesSection />)
    expect(screen.getByText("No delegation rules")).toBeInTheDocument()
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

  it("removes a rule", async () => {
    const user = userEvent.setup()
    mockRules = [rule()]
    render(<DelegationRulesSection />)
    const row = screen.getByTestId("delegation-rule-r1")
    await act(async () => {
      await user.click(within(row).getByRole("button", { name: /delete/i }))
    })
    expect(removeRule).toHaveBeenCalledWith("r1")
  })

  it("opens the create dialog pre-targeted when a caller seeds an agent", () => {
    mockAgents = [
      { id: "a1", name: "Claude Code" },
      { id: "a2", name: "Codex" },
    ]
    render(<DelegationRulesSection createForAgent={{ agentId: "a2" }} />)
    const dialog = screen.getByRole("dialog")
    // The target select shows the seeded agent rather than the first agent.
    expect(within(dialog).getByText("Codex")).toBeInTheDocument()
  })

  it("ignores a seed pointing at an agent that cannot be targeted", () => {
    mockAgents = [{ id: "a1", name: "Claude Code" }]
    render(<DelegationRulesSection createForAgent={{ agentId: "missing" }} />)
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("does not reopen the dialog for the same seed object twice", async () => {
    mockAgents = [{ id: "a1", name: "Claude Code" }]
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
})
