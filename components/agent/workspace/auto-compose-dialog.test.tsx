/**
 * @jest-environment jsdom
 */

import React from "react"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { AutoComposeDialog } from "./auto-compose-dialog"
import { EMPTY_CAPABILITY_CATALOG } from "@/lib/ai/agent/team/auto/capability-catalog"
import type { AutoOrchestrationProposal } from "@/lib/ai/agent/team/auto/types"
import type { LlmClient } from "@/lib/twin/distill/llm"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const toastError = jest.fn()
const toastSuccess = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    error: (...a: unknown[]) => toastError(...a),
    success: (...a: unknown[]) => toastSuccess(...a),
  },
}))

jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (sel: (s: { settings: Record<string, unknown> }) => unknown) =>
    sel({ settings: { defaultProvider: "anthropic" } }),
}))

// Render shadcn Select as a native <select> so the pattern / assignee controls
// inside the (real) editors and preview are drivable in jsdom.
jest.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string
    onValueChange: (v: string) => void
    children: React.ReactNode
  }) =>
    React.createElement(
      "select",
      { value, onChange: (e: { target: { value: string } }) => onValueChange(e.target.value) },
      children
    ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => children,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) =>
    React.createElement("option", { value }, children),
}))

// Engine seams: default params exercised (plan / materialize / renderer client).
jest.mock("@/lib/ai/agent/team/auto/auto-orchestrate", () => {
  const actual = jest.requireActual("@/lib/ai/agent/team/auto/auto-orchestrate")
  return { ...actual, planAutoOrchestration: jest.fn() }
})
jest.mock("@/lib/ai/agent/team/auto/materialize", () => ({ materializeProposal: jest.fn() }))
jest.mock("@/lib/ai/renderer-llm-client", () => ({ buildRendererLlmClient: jest.fn() }))
jest.mock("@/lib/ai/agent/team/auto/clarify-objective", () => {
  const actual = jest.requireActual("@/lib/ai/agent/team/auto/clarify-objective")
  return { ...actual, clarifyObjective: jest.fn() }
})

import {
  AutoOrchestrationPiiError,
  planAutoOrchestration,
} from "@/lib/ai/agent/team/auto/auto-orchestrate"
import { materializeProposal } from "@/lib/ai/agent/team/auto/materialize"
import { buildRendererLlmClient } from "@/lib/ai/renderer-llm-client"
import { clarifyObjective } from "@/lib/ai/agent/team/auto/clarify-objective"

const mockPlan = planAutoOrchestration as jest.MockedFunction<typeof planAutoOrchestration>
const mockMaterialize = materializeProposal as jest.MockedFunction<typeof materializeProposal>
const mockBuildClient = buildRendererLlmClient as jest.MockedFunction<typeof buildRendererLlmClient>
const mockClarify = clarifyObjective as jest.MockedFunction<typeof clarifyObjective>

const stubClient: LlmClient = { complete: async () => "{}" }

const proposal: AutoOrchestrationProposal = {
  objective: "Audit the auth layer",
  assessment: {
    recommendedPattern: "parallel_specialists",
    confidence: 0.82,
    reason: "Independent angles benefit from specialists.",
    factors: {
      taskComplexity: "moderate",
      specializationNeeded: true,
      contextIsolationNeeded: false,
      delegationCandidate: false,
      budgetPressure: "low",
    },
    createdAt: new Date("2026-06-14T00:00:00Z"),
  },
  roster: [
    { name: "Lead", role: "lead", description: "coordinates" },
    {
      name: "Security",
      role: "teammate",
      description: "reviews security",
      specialization: "security",
    },
  ],
  tasks: [
    { title: "Scan", description: "scan", assignedTo: 1, dependencies: [] },
    { title: "Report", description: "report", assignedTo: 0, dependencies: [0] },
  ],
}

const getCatalog = async () => EMPTY_CAPABILITY_CATALOG

function setup() {
  const onOpenChange = jest.fn()
  const onComposed = jest.fn()
  render(
    <AutoComposeDialog
      open
      onOpenChange={onOpenChange}
      onComposed={onComposed}
      getCatalog={getCatalog}
    />
  )
  return { onOpenChange, onComposed }
}

function typeObjective(value = "Audit the auth layer") {
  fireEvent.change(screen.getByTestId("auto-compose-objective"), { target: { value } })
}

beforeEach(() => {
  toastError.mockReset()
  toastSuccess.mockReset()
  mockPlan.mockReset()
  mockMaterialize.mockReset()
  mockBuildClient.mockReset()
  mockClarify.mockReset()
  mockBuildClient.mockReturnValue(stubClient)
  mockPlan.mockResolvedValue(proposal)
  mockClarify.mockResolvedValue({ questions: [] })
  mockMaterialize.mockReturnValue({
    teamId: "team-9",
    leadId: "lead-9",
    teammateIds: ["lead-9"],
    taskIds: [],
  })
})

describe("AutoComposeDialog — generate + preview", () => {
  it("plans then renders the editable proposal preview", async () => {
    setup()
    typeObjective()
    fireEvent.click(screen.getByTestId("auto-compose-submit"))

    await waitFor(() => expect(screen.getByTestId("auto-compose-preview")).toBeInTheDocument())
    expect(mockBuildClient).toHaveBeenCalledWith(
      expect.objectContaining({ featureId: "agent-team-auto" })
    )
    expect(mockPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        objective: "Audit the auth layer",
        client: stubClient,
        maxRoster: 6,
      })
    )
    expect(screen.getByTestId("auto-compose-member-name-1")).toHaveValue("Security")
    expect(screen.getByTestId("auto-compose-task-title-0")).toHaveValue("Scan")
  })

  it("requires a non-empty objective", () => {
    setup()
    fireEvent.click(screen.getByTestId("auto-compose-submit"))
    expect(mockPlan).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalledWith("objectiveRequired")
  })

  it("toasts when no LLM client resolves", () => {
    mockBuildClient.mockReturnValue(null)
    setup()
    typeObjective("do it")
    fireEvent.click(screen.getByTestId("auto-compose-submit"))
    expect(mockPlan).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalledWith("noClient")
  })

  it("surfaces the PII refusal distinctly and returns to input", async () => {
    mockPlan.mockRejectedValue(new AutoOrchestrationPiiError())
    setup()
    typeObjective("leak")
    fireEvent.click(screen.getByTestId("auto-compose-submit"))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("piiRefused"))
    expect(screen.getByTestId("auto-compose-objective")).toBeInTheDocument()
  })

  it("surfaces a generic failure with the message", async () => {
    mockPlan.mockRejectedValue(new Error("model down"))
    setup()
    typeObjective("x")
    fireEvent.click(screen.getByTestId("auto-compose-submit"))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('failed:{"error":"model down"}'))
  })

  it("stringifies a non-Error rejection", async () => {
    mockPlan.mockRejectedValue("plain string failure")
    setup()
    typeObjective("x")
    fireEvent.click(screen.getByTestId("auto-compose-submit"))
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith('failed:{"error":"plain string failure"}')
    )
  })

  it("plans with an empty catalog when capability gathering throws", async () => {
    const onComposed = jest.fn()
    render(
      <AutoComposeDialog
        open
        onOpenChange={jest.fn()}
        onComposed={onComposed}
        getCatalog={async () => {
          throw new Error("registry down")
        }}
      />
    )
    typeObjective("Audit")
    fireEvent.click(screen.getByTestId("auto-compose-submit"))
    await waitFor(() => screen.getByTestId("auto-compose-preview"))
    expect(mockPlan).toHaveBeenCalledWith(
      expect.objectContaining({ catalog: EMPTY_CAPABILITY_CATALOG })
    )
  })

  it("uses an injected buildClient seam when provided", async () => {
    const injected: LlmClient = { complete: async () => "{}" }
    render(
      <AutoComposeDialog
        open
        onOpenChange={jest.fn()}
        onComposed={jest.fn()}
        getCatalog={getCatalog}
        buildClient={() => injected}
      />
    )
    typeObjective("Audit")
    fireEvent.click(screen.getByTestId("auto-compose-submit"))
    await waitFor(() => screen.getByTestId("auto-compose-preview"))
    expect(mockBuildClient).not.toHaveBeenCalled()
    expect(mockPlan).toHaveBeenCalledWith(expect.objectContaining({ client: injected }))
  })

  it("reject returns to the objective input", async () => {
    setup()
    typeObjective("Audit")
    fireEvent.click(screen.getByTestId("auto-compose-submit"))
    await waitFor(() => screen.getByTestId("auto-compose-reject"))
    fireEvent.click(screen.getByTestId("auto-compose-reject"))
    expect(screen.getByTestId("auto-compose-objective")).toBeInTheDocument()
  })
})

describe("AutoComposeDialog — clarify", () => {
  it("shows clarifying questions, then plans from the refined objective on continue", async () => {
    mockClarify.mockResolvedValue({ questions: ["What is the scope?"] })
    setup()
    typeObjective("build a thing")
    fireEvent.click(screen.getByTestId("auto-compose-submit"))

    await waitFor(() => screen.getByTestId("auto-compose-clarify"))
    fireEvent.change(screen.getByTestId("auto-compose-clarify-answer-0"), {
      target: { value: "just the CLI" },
    })
    fireEvent.click(screen.getByTestId("auto-compose-clarify-continue"))

    await waitFor(() => expect(mockPlan).toHaveBeenCalled())
    const planObjective = mockPlan.mock.calls[0][0].objective
    expect(planObjective).toContain("build a thing")
    expect(planObjective).toContain("just the CLI")
  })

  it("skips clarification and plans from the original objective", async () => {
    mockClarify.mockResolvedValue({ questions: ["scope?"] })
    setup()
    typeObjective("ship it")
    fireEvent.click(screen.getByTestId("auto-compose-submit"))
    await waitFor(() => screen.getByTestId("auto-compose-clarify-skip"))
    fireEvent.click(screen.getByTestId("auto-compose-clarify-skip"))

    await waitFor(() => expect(mockPlan).toHaveBeenCalled())
    expect(mockPlan.mock.calls[0][0].objective).toBe("ship it")
  })

  it("surfaces a PII refusal raised by the clarify pre-stage", async () => {
    mockClarify.mockRejectedValue(new AutoOrchestrationPiiError())
    setup()
    typeObjective("leaky")
    fireEvent.click(screen.getByTestId("auto-compose-submit"))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("piiRefused"))
    expect(mockPlan).not.toHaveBeenCalled()
    expect(screen.getByTestId("auto-compose-objective")).toBeInTheDocument()
  })

  it("falls through to planning when clarify fails for a non-PII reason", async () => {
    mockClarify.mockRejectedValue(new Error("clarify model down"))
    setup()
    typeObjective("still works")
    fireEvent.click(screen.getByTestId("auto-compose-submit"))
    await waitFor(() => screen.getByTestId("auto-compose-preview"))
    expect(mockPlan).toHaveBeenCalledWith(expect.objectContaining({ objective: "still works" }))
  })

  it("toasts noClient if the client vanishes when continuing or skipping clarify", async () => {
    mockClarify.mockResolvedValue({ questions: ["Q1", "Q2"] })
    // Resolve a client for the clarify call, then none afterwards.
    mockBuildClient.mockReturnValueOnce(stubClient).mockReturnValue(null)
    setup()
    typeObjective("vague")
    fireEvent.click(screen.getByTestId("auto-compose-submit"))
    await waitFor(() => screen.getByTestId("auto-compose-clarify-continue"))

    fireEvent.click(screen.getByTestId("auto-compose-clarify-continue"))
    expect(toastError).toHaveBeenCalledWith("noClient")
    fireEvent.click(screen.getByTestId("auto-compose-clarify-skip"))
    expect(toastError).toHaveBeenCalledWith("noClient")
    expect(mockPlan).not.toHaveBeenCalled()
  })

  it("folds only the answered questions into the objective", async () => {
    mockClarify.mockResolvedValue({ questions: ["Scope?", "Users?"] })
    setup()
    typeObjective("build a thing")
    fireEvent.click(screen.getByTestId("auto-compose-submit"))
    await waitFor(() => screen.getByTestId("auto-compose-clarify-continue"))
    // Answer only the second question.
    fireEvent.change(screen.getByTestId("auto-compose-clarify-answer-1"), {
      target: { value: "developers" },
    })
    fireEvent.click(screen.getByTestId("auto-compose-clarify-continue"))
    await waitFor(() => expect(mockPlan).toHaveBeenCalled())
    const objective = mockPlan.mock.calls[0][0].objective
    expect(objective).toContain("Users?")
    expect(objective).toContain("developers")
    expect(objective).not.toContain("Scope?")
  })

  it("skips the clarify step entirely when the toggle is off", async () => {
    const user = userEvent.setup()
    setup()
    typeObjective("clear objective")
    // Open advanced options and turn clarify off.
    fireEvent.click(screen.getByTestId("auto-compose-advanced-trigger"))
    await user.click(screen.getByTestId("auto-compose-clarify-toggle"))

    fireEvent.click(screen.getByTestId("auto-compose-submit"))
    await waitFor(() => screen.getByTestId("auto-compose-preview"))
    expect(mockClarify).not.toHaveBeenCalled()
  })
})

describe("AutoComposeDialog — quick create", () => {
  it("plans and materializes immediately, skipping the preview", async () => {
    const { onComposed } = setup()
    typeObjective("Audit")
    fireEvent.click(screen.getByTestId("auto-compose-quick"))

    await waitFor(() => expect(mockMaterialize).toHaveBeenCalled())
    expect(mockMaterialize).toHaveBeenCalledWith(
      proposal,
      expect.objectContaining({ config: expect.objectContaining({ requirePlanApproval: false }) })
    )
    expect(onComposed).toHaveBeenCalledWith("team-9")
    expect(screen.queryByTestId("auto-compose-preview")).not.toBeInTheDocument()
  })

  it("requires an objective and surfaces failures on the quick-create path", async () => {
    setup()
    // Empty objective → validation toast, no plan.
    fireEvent.click(screen.getByTestId("auto-compose-quick"))
    expect(mockPlan).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalledWith("objectiveRequired")

    // A planning failure returns to input with the error toast.
    mockPlan.mockRejectedValue(new Error("quick down"))
    typeObjective("Audit")
    fireEvent.click(screen.getByTestId("auto-compose-quick"))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('failed:{"error":"quick down"}'))
    expect(screen.getByTestId("auto-compose-objective")).toBeInTheDocument()
  })

  it("forwards advanced options through the quick-create path too", async () => {
    const user = userEvent.setup()
    setup()
    typeObjective("Audit")
    fireEvent.click(screen.getByTestId("auto-compose-advanced-trigger"))
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "single_agent_recommended" },
    })
    await user.click(screen.getByTestId("auto-compose-ultracode"))

    fireEvent.click(screen.getByTestId("auto-compose-quick"))
    await waitFor(() => expect(mockMaterialize).toHaveBeenCalled())
    expect(mockPlan).toHaveBeenCalledWith(
      expect.objectContaining({ preferredPattern: "single_agent_recommended" })
    )
    expect(mockMaterialize).toHaveBeenCalledWith(
      proposal,
      expect.objectContaining({
        config: { requirePlanApproval: false, ultracode: { enabled: true } },
      })
    )
  })
})

describe("AutoComposeDialog — approve + options passthrough", () => {
  it("materializes the proposal with the edited name on approve", async () => {
    const { onComposed } = setup()
    typeObjective("Audit")
    fireEvent.click(screen.getByTestId("auto-compose-submit"))
    await waitFor(() => screen.getByTestId("auto-compose-approve"))

    fireEvent.change(screen.getByTestId("auto-compose-name"), { target: { value: "Auth Squad" } })
    fireEvent.click(screen.getByTestId("auto-compose-approve"))
    expect(mockMaterialize).toHaveBeenCalledWith(proposal, {
      name: "Auth Squad",
      config: { requirePlanApproval: false },
    })
    expect(onComposed).toHaveBeenCalledWith("team-9")
    expect(toastSuccess).toHaveBeenCalledWith("created")
  })

  it("approves with an empty name (defaults to the objective)", async () => {
    setup()
    typeObjective("Audit")
    fireEvent.click(screen.getByTestId("auto-compose-submit"))
    await waitFor(() => screen.getByTestId("auto-compose-approve"))
    fireEvent.change(screen.getByTestId("auto-compose-name"), { target: { value: "   " } })
    fireEvent.click(screen.getByTestId("auto-compose-approve"))
    expect(mockMaterialize).toHaveBeenCalledWith(proposal, {
      name: undefined,
      config: { requirePlanApproval: false },
    })
  })

  it("forwards advanced options into plan and the materialized config", async () => {
    const user = userEvent.setup()
    setup()
    typeObjective("Audit")
    fireEvent.click(screen.getByTestId("auto-compose-advanced-trigger"))
    // Force a pattern + enable run options.
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "ultracode_orchestration" } })
    await user.click(screen.getByTestId("auto-compose-require-approval"))
    await user.click(screen.getByTestId("auto-compose-ultracode"))

    fireEvent.click(screen.getByTestId("auto-compose-submit"))
    await waitFor(() => screen.getByTestId("auto-compose-approve"))
    expect(mockPlan).toHaveBeenCalledWith(
      expect.objectContaining({ preferredPattern: "ultracode_orchestration" })
    )

    fireEvent.click(screen.getByTestId("auto-compose-approve"))
    expect(mockMaterialize).toHaveBeenCalledWith(
      proposal,
      expect.objectContaining({
        config: { requirePlanApproval: true, ultracode: { enabled: true } },
      })
    )
  })

  it("materializes edits made in the preview", async () => {
    setup()
    typeObjective("Audit")
    fireEvent.click(screen.getByTestId("auto-compose-submit"))
    await waitFor(() => screen.getByTestId("auto-compose-approve"))

    // Rename the teammate, then remove no one; approve sends the edited proposal.
    fireEvent.change(screen.getByTestId("auto-compose-member-name-1"), {
      target: { value: "Renamed" },
    })
    fireEvent.click(screen.getByTestId("auto-compose-approve"))
    const sent = mockMaterialize.mock.calls[0][0]
    expect(sent.roster[1].name).toBe("Renamed")
  })

  it("routes every structural preview edit through the index-safe wiring", async () => {
    setup()
    typeObjective("Audit")
    fireEvent.click(screen.getByTestId("auto-compose-submit"))
    await waitFor(() => screen.getByTestId("auto-compose-approve"))

    // Roster: add → promote → remove the extra member.
    fireEvent.click(screen.getByTestId("auto-compose-add-member"))
    fireEvent.click(screen.getByTestId("auto-compose-set-lead-1"))
    fireEvent.click(screen.getByTestId("auto-compose-remove-member-2"))

    // Tasks: edit a title, add a task, remove it again.
    fireEvent.change(screen.getByTestId("auto-compose-task-title-0"), {
      target: { value: "Edited scan" },
    })
    fireEvent.click(screen.getByTestId("auto-compose-add-task"))
    fireEvent.click(screen.getByTestId("auto-compose-remove-task-2"))

    // Preview-only pattern override (metadata, first combobox in the preview).
    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "manager_worker" } })

    fireEvent.click(screen.getByTestId("auto-compose-approve"))
    const sent = mockMaterialize.mock.calls[0][0]
    expect(sent.roster).toHaveLength(2)
    expect(sent.roster[0].name).toBe("Security") // promoted to lead
    expect(sent.roster[0].role).toBe("lead")
    expect(sent.tasks[0].title).toBe("Edited scan")
    expect(sent.tasks).toHaveLength(2)
    expect(sent.assessment.recommendedPattern).toBe("manager_worker")
  })
})

describe("AutoComposeDialog — lifecycle", () => {
  it("cancel closes the dialog", () => {
    const { onOpenChange } = setup()
    fireEvent.click(screen.getByText("cancel"))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("resets when the dialog is closed via Escape", async () => {
    setup()
    typeObjective("Audit")
    fireEvent.click(screen.getByTestId("auto-compose-submit"))
    await waitFor(() => screen.getByTestId("auto-compose-preview"))
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })
    await waitFor(() =>
      expect(screen.queryByTestId("auto-compose-preview")).not.toBeInTheDocument()
    )
  })
})
