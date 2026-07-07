/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { PlanApprovalPanel } from "./plan-approval-panel"
import {
  approve,
  reject,
  waitForDecision,
  __resetForTesting,
  pendingCount,
} from "@/lib/ai/agent/plan-approval-bus"
import type { AgentTeam, AgentTeammate } from "@/types/agent/agent-team"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// The panel renders the proposed plan through the shared MarkdownRenderer;
// stub it (identity) so these tests don't pull in the heavy markdown pipeline.
jest.mock("@/components/chat/markdown-renderer", () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div data-testid="md">{content}</div>,
}))

// Drive the reduced-motion branch of the entrance animation deterministically.
let mockReducedMotion = false
jest.mock("motion/react", () => {
  const actual = jest.requireActual("motion/react")
  return { ...actual, useReducedMotion: () => mockReducedMotion }
})

const team: AgentTeam = {
  id: "team-x",
  name: "X",
  description: "",
  task: "",
  status: "executing",
  config: {
    maxTeammates: 5,
    maxConcurrentTeammates: 1,
    executionMode: "coordinated",
    displayMode: "compact",
  },
  leadId: "lead-1",
  teammateIds: ["lead-1"],
  taskIds: [],
  messageIds: [],
  progress: 0,
  totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  createdAt: new Date(),
}

const leadWithPlan: AgentTeammate = {
  id: "lead-1",
  teamId: "team-x",
  name: "Lead",
  description: "",
  role: "lead",
  status: "awaiting_approval",
  config: {},
  proposedPlan: '```json\n{"steps":["a"]}\n```',
  completedTaskIds: [],
  tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  progress: 0,
  createdAt: new Date(),
}

const leadWithoutPlan: AgentTeammate = { ...leadWithPlan, proposedPlan: undefined }

beforeEach(() => {
  __resetForTesting()
  mockReducedMotion = false
})

describe("PlanApprovalPanel", () => {
  it("renders the no-plan placeholder when lead has no proposedPlan", () => {
    render(<PlanApprovalPanel team={team} lead={leadWithoutPlan} />)
    expect(screen.getByText("noPlan")).toBeInTheDocument()
    // Buttons disabled until plan is present.
    expect(screen.getByTestId("plan-approval-approve")).toBeDisabled()
    expect(screen.getByTestId("plan-approval-reject")).toBeDisabled()
  })

  it("renders the proposed plan when present", () => {
    render(<PlanApprovalPanel team={team} lead={leadWithPlan} />)
    expect(screen.getByText(/steps/)).toBeInTheDocument()
  })

  it("renders the proposed plan as markdown, not a raw <pre>", () => {
    const { container } = render(<PlanApprovalPanel team={team} lead={leadWithPlan} />)
    expect(screen.getByTestId("plan-approval-panel-body")).toBeInTheDocument()
    expect(screen.getByTestId("md")).toBeInTheDocument()
    expect(container.querySelector("pre")).toBeNull()
  })

  it("drops the entrance offset when the user prefers reduced motion", () => {
    mockReducedMotion = true
    render(<PlanApprovalPanel team={team} lead={leadWithPlan} />)
    expect(screen.getByTestId("plan-approval-panel")).toBeInTheDocument()
  })

  it("approve resolves the bus waiter for this team", async () => {
    const promise = waitForDecision("team-x")
    expect(pendingCount("team-x")).toBe(1)
    render(<PlanApprovalPanel team={team} lead={leadWithPlan} />)
    fireEvent.click(screen.getByTestId("plan-approval-approve"))
    const decision = await promise
    expect(decision.outcome).toBe("approve")
  })

  it("reject resolves the bus waiter with the feedback string", async () => {
    const user = userEvent.setup()
    const promise = waitForDecision("team-x")
    render(<PlanApprovalPanel team={team} lead={leadWithPlan} />)
    await user.type(screen.getByTestId("plan-approval-feedback"), "needs more detail")
    fireEvent.click(screen.getByTestId("plan-approval-reject"))
    const decision = await promise
    expect(decision.outcome).toBe("reject")
    expect(decision.feedback).toBe("needs more detail")
  })

  it("reject without feedback sends undefined feedback (not empty string)", async () => {
    // Spy on reject to assert the arg shape.
    let captured: string | undefined = "untouched"
    const promise = waitForDecision("team-x").then((d) => {
      captured = d.feedback
      return d
    })
    render(<PlanApprovalPanel team={team} lead={leadWithPlan} />)
    fireEvent.click(screen.getByTestId("plan-approval-reject"))
    await promise
    expect(captured).toBeUndefined()
  })

  it("does nothing if lead is undefined", () => {
    render(<PlanApprovalPanel team={team} />)
    expect(screen.getByText("noPlan")).toBeInTheDocument()
    expect(screen.getByTestId("plan-approval-approve")).toBeDisabled()
  })

  it("does not throw when no waiter is registered (just no-ops)", () => {
    render(<PlanApprovalPanel team={team} lead={leadWithPlan} />)
    expect(() => fireEvent.click(screen.getByTestId("plan-approval-approve"))).not.toThrow()
    // Reset to make sure approve/reject still resolve nothing pending.
    expect(approve("team-x")).toBe(0)
    expect(reject("team-x", "x")).toBe(0)
  })
})
