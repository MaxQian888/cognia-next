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
