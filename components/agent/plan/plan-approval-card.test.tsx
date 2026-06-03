/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { PlanApprovalCard } from "./plan-approval-card"
import type { AgentPlan, PlanStep } from "@/types/agent/plan"
import { DEFAULT_PLAN_CONFIG } from "@/types/agent/plan"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

function step(id: string, over: Partial<PlanStep> = {}): PlanStep {
  return {
    id,
    title: over.title ?? id,
    kind: over.kind ?? "agent_turn",
    status: over.status ?? "pending",
    order: over.order ?? 0,
    dependencies: [],
  }
}

function plan(over: Partial<AgentPlan> = {}): AgentPlan {
  const steps = over.steps ?? [step("a", { title: "First step", order: 0 })]
  return {
    id: "p1",
    sessionId: "ses",
    title: over.title ?? "Ship the widget",
    source: over.source ?? "exit_plan_mode",
    executionMode: "auto",
    steps,
    status: over.status ?? "awaiting_approval",
    totalSteps: steps.length,
    completedSteps: 0,
    config: DEFAULT_PLAN_CONFIG,
    refinementCount: 0,
    generationId: "g",
    createdAt: 0,
    updatedAt: 0,
  }
}

describe("PlanApprovalCard", () => {
  it("renders the title, status, source and steps", () => {
    render(<PlanApprovalCard plan={plan()} onApprove={jest.fn()} onReject={jest.fn()} />)
    expect(screen.getByTestId("plan-approval-card")).toBeInTheDocument()
    expect(screen.getByText("Ship the widget")).toBeInTheDocument()
    expect(screen.getByText("First step")).toBeInTheDocument()
    expect(screen.getByText("status.awaiting_approval")).toBeInTheDocument()
  })

  it("fires onApprove", async () => {
    const onApprove = jest.fn()
    render(<PlanApprovalCard plan={plan()} onApprove={onApprove} onReject={jest.fn()} />)
    await userEvent.click(screen.getByTestId("plan-approval-approve"))
    expect(onApprove).toHaveBeenCalledTimes(1)
  })

  it("fires onReject with trimmed feedback", async () => {
    const onReject = jest.fn()
    render(<PlanApprovalCard plan={plan()} onApprove={jest.fn()} onReject={onReject} />)
    await userEvent.type(screen.getByTestId("plan-approval-feedback"), "  needs work  ")
    await userEvent.click(screen.getByTestId("plan-approval-reject"))
    expect(onReject).toHaveBeenCalledWith("needs work")
  })

  it("passes undefined feedback when blank", async () => {
    const onReject = jest.fn()
    render(<PlanApprovalCard plan={plan()} onApprove={jest.fn()} onReject={onReject} />)
    await userEvent.click(screen.getByTestId("plan-approval-reject"))
    expect(onReject).toHaveBeenCalledWith(undefined)
  })

  it("shows refine controls only when onRefine is provided, and forwards the type", async () => {
    const onRefine = jest.fn()
    const { rerender } = render(
      <PlanApprovalCard plan={plan()} onApprove={jest.fn()} onReject={jest.fn()} />
    )
    expect(screen.queryByTestId("plan-refine-optimize")).not.toBeInTheDocument()

    rerender(
      <PlanApprovalCard
        plan={plan()}
        onApprove={jest.fn()}
        onReject={jest.fn()}
        onRefine={onRefine}
      />
    )
    await userEvent.click(screen.getByTestId("plan-refine-expand"))
    expect(onRefine).toHaveBeenCalledWith("expand", undefined)
  })

  it("renders the empty state when there are no steps", () => {
    render(
      <PlanApprovalCard plan={plan({ steps: [] })} onApprove={jest.fn()} onReject={jest.fn()} />
    )
    expect(screen.getByText("approval.noSteps")).toBeInTheDocument()
    expect(screen.queryByTestId("plan-approval-steps")).not.toBeInTheDocument()
  })
})
