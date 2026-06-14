/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { AutoComposeDialog } from "./auto-compose-dialog"
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

// Mock the engine modules so the component's DEFAULT params (plan / materialize /
// the default renderer-client closure) are exercised — no injected props needed.
jest.mock("@/lib/ai/agent/team/auto/auto-orchestrate", () => {
  const actual = jest.requireActual("@/lib/ai/agent/team/auto/auto-orchestrate")
  return { ...actual, planAutoOrchestration: jest.fn() }
})
jest.mock("@/lib/ai/agent/team/auto/materialize", () => ({ materializeProposal: jest.fn() }))
jest.mock("@/lib/ai/renderer-llm-client", () => ({ buildRendererLlmClient: jest.fn() }))

import {
  AutoOrchestrationPiiError,
  planAutoOrchestration,
} from "@/lib/ai/agent/team/auto/auto-orchestrate"
import { materializeProposal } from "@/lib/ai/agent/team/auto/materialize"
import { buildRendererLlmClient } from "@/lib/ai/renderer-llm-client"

const mockPlan = planAutoOrchestration as jest.MockedFunction<typeof planAutoOrchestration>
const mockMaterialize = materializeProposal as jest.MockedFunction<typeof materializeProposal>
const mockBuildClient = buildRendererLlmClient as jest.MockedFunction<typeof buildRendererLlmClient>

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

function setup() {
  const onOpenChange = jest.fn()
  const onComposed = jest.fn()
  render(<AutoComposeDialog open onOpenChange={onOpenChange} onComposed={onComposed} />)
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
  mockBuildClient.mockReturnValue(stubClient)
  mockPlan.mockResolvedValue(proposal)
  mockMaterialize.mockReturnValue({
    teamId: "team-9",
    leadId: "lead-9",
    teammateIds: ["lead-9"],
    taskIds: [],
  })
})

describe("AutoComposeDialog", () => {
  it("plans then renders the proposal preview via the default engine", async () => {
    setup()
    typeObjective()
    fireEvent.click(screen.getByTestId("auto-compose-submit"))

    await waitFor(() => expect(screen.getByTestId("auto-compose-preview")).toBeInTheDocument())
    expect(mockBuildClient).toHaveBeenCalledWith(
      expect.objectContaining({ featureId: "agent-team-auto" })
    )
    expect(mockPlan).toHaveBeenCalledWith(
      expect.objectContaining({ objective: "Audit the auth layer", client: stubClient })
    )
    expect(screen.getByText("Security")).toBeInTheDocument()
    expect(screen.getByText("Scan")).toBeInTheDocument()
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

  it("surfaces the PII refusal distinctly", async () => {
    mockPlan.mockRejectedValue(new AutoOrchestrationPiiError())
    setup()
    typeObjective("leak")
    fireEvent.click(screen.getByTestId("auto-compose-submit"))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("piiRefused"))
    // Returned to input phase.
    expect(screen.getByTestId("auto-compose-objective")).toBeInTheDocument()
  })

  it("surfaces a generic failure with the message", async () => {
    mockPlan.mockRejectedValue(new Error("model down"))
    setup()
    typeObjective("x")
    fireEvent.click(screen.getByTestId("auto-compose-submit"))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('failed:{"error":"model down"}'))
  })

  it("materializes and reports the team id on approve", async () => {
    const { onComposed } = setup()
    typeObjective("Audit")
    fireEvent.click(screen.getByTestId("auto-compose-submit"))
    await waitFor(() => screen.getByTestId("auto-compose-approve"))

    // Edit the team name, then approve.
    fireEvent.change(screen.getByTestId("auto-compose-name"), { target: { value: "Auth Squad" } })
    fireEvent.click(screen.getByTestId("auto-compose-approve"))
    expect(mockMaterialize).toHaveBeenCalledWith(proposal, { name: "Auth Squad" })
    expect(onComposed).toHaveBeenCalledWith("team-9")
    expect(toastSuccess).toHaveBeenCalledWith("created")
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

  it("approves with an empty name (defaults to the objective)", async () => {
    setup()
    typeObjective("Audit")
    fireEvent.click(screen.getByTestId("auto-compose-submit"))
    await waitFor(() => screen.getByTestId("auto-compose-approve"))
    fireEvent.change(screen.getByTestId("auto-compose-name"), { target: { value: "   " } })
    fireEvent.click(screen.getByTestId("auto-compose-approve"))
    expect(mockMaterialize).toHaveBeenCalledWith(proposal, { name: undefined })
  })

  it("renders an assignee fallback when a task index is out of range", async () => {
    mockPlan.mockResolvedValue({
      ...proposal,
      roster: [{ name: "Solo", role: "lead", description: "alone" }],
      tasks: [{ title: "Orphan", description: "x", assignedTo: 7, dependencies: [] }],
    })
    setup()
    typeObjective("x")
    fireEvent.click(screen.getByTestId("auto-compose-submit"))
    await waitFor(() => screen.getByTestId("auto-compose-preview"))
    expect(screen.getByText("→ #7")).toBeInTheDocument()
  })

  it("reject returns to the objective input", async () => {
    setup()
    typeObjective("Audit")
    fireEvent.click(screen.getByTestId("auto-compose-submit"))
    await waitFor(() => screen.getByTestId("auto-compose-reject"))

    fireEvent.click(screen.getByTestId("auto-compose-reject"))
    expect(screen.getByTestId("auto-compose-objective")).toBeInTheDocument()
  })

  it("cancel closes the dialog", () => {
    const { onOpenChange } = setup()
    fireEvent.click(screen.getByText("cancel"))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("resets when the dialog is closed via the overlay", async () => {
    setup()
    typeObjective("Audit")
    fireEvent.click(screen.getByTestId("auto-compose-submit"))
    await waitFor(() => screen.getByTestId("auto-compose-preview"))
    // Escape closes the Radix dialog → onOpenChange(false) wrapper runs reset().
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })
    await waitFor(() =>
      expect(screen.queryByTestId("auto-compose-preview")).not.toBeInTheDocument()
    )
  })
})
