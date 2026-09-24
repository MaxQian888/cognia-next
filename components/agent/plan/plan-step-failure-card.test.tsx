/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { PlanStepFailureCard } from "./plan-step-failure-card"
import type { AgentPlan, PlanStepHalt } from "@/types/agent/plan"
import { DEFAULT_PLAN_CONFIG } from "@/types/agent/plan"

// Echo the key and its values so the assertions pin which message and which
// interpolation the card chose.
jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string, values?: Record<string, unknown>) =>
    `${ns}.${key}${values ? JSON.stringify(values) : ""}`,
}))

function plan(over: Partial<AgentPlan> = {}): AgentPlan {
  return {
    id: "p1",
    sessionId: "ses",
    title: "Ship it",
    source: "manual",
    executionMode: "auto",
    steps: [
      {
        id: "s0",
        title: "Prepare",
        kind: "agent_turn",
        status: "completed",
        order: 0,
        dependencies: [],
      },
      {
        id: "s1",
        title: "Run the migration",
        kind: "agent_turn",
        status: "failed",
        order: 1,
        dependencies: ["s0"],
        attempts: 2,
        error: "Pi process exited",
      },
    ],
    status: "paused",
    totalSteps: 2,
    completedSteps: 1,
    config: DEFAULT_PLAN_CONFIG,
    refinementCount: 0,
    generationId: "g",
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

const halt: PlanStepHalt = {
  stepId: "s1",
  cause: "turn_failed",
  detail: "Pi process exited before the Cognia extension was ready",
  at: 1,
}

function handlers() {
  return {
    onRetry: jest.fn(),
    onSkip: jest.fn(),
    onMarkDone: jest.fn(),
    onResume: jest.fn(),
    onCancel: jest.fn(),
  }
}

describe("PlanStepFailureCard", () => {
  it("names the step, the localized cause, the detail and the attempt", () => {
    render(<PlanStepFailureCard plan={plan()} halt={halt} canDispatch {...handlers()} />)
    expect(screen.getByRole("alert")).toHaveAttribute("data-cause", "turn_failed")
    expect(
      screen.getByText('plan.stepFailure.title.turn_failed{"index":2,"title":"Run the migration"}')
    ).toBeInTheDocument()
    expect(screen.getByText(/plan\.stepFailure\.hint\.turn_failed/)).toBeInTheDocument()
    expect(screen.getByTestId("plan-step-failure-detail")).toHaveTextContent(
      "Pi process exited before the Cognia extension was ready"
    )
    expect(screen.getByTestId("plan-step-failure-attempt")).toHaveTextContent('{"count":2}')
  })

  it("interpolates the watchdog budgets into the hint", () => {
    render(
      <PlanStepFailureCard
        plan={plan()}
        halt={{ ...halt, cause: "silent" }}
        canDispatch
        {...handlers()}
      />
    )
    expect(screen.getByText(/hint\.silent\{"seconds":90,"minutes":5\}/)).toBeInTheDocument()
  })

  it("wires retry / skip / mark done / cancel", async () => {
    const h = handlers()
    render(<PlanStepFailureCard plan={plan()} halt={halt} canDispatch {...h} />)
    await userEvent.click(screen.getByTestId("plan-step-retry"))
    await userEvent.click(screen.getByTestId("plan-step-skip"))
    await userEvent.click(screen.getByTestId("plan-step-mark-done"))
    await userEvent.click(screen.getByTestId("plan-step-cancel"))
    expect(h.onRetry).toHaveBeenCalledTimes(1)
    expect(h.onSkip).toHaveBeenCalledTimes(1)
    expect(h.onMarkDone).toHaveBeenCalledTimes(1)
    expect(h.onCancel).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId("plan-step-resume")).not.toBeInTheDocument()
  })

  it("offers Resume (not step actions) for a halt between steps", async () => {
    const h = handlers()
    render(
      <PlanStepFailureCard
        plan={plan()}
        halt={{ cause: "interrupted", detail: "restart", at: 1 }}
        canDispatch
        {...h}
      />
    )
    expect(screen.getByText("plan.stepFailure.betweenSteps")).toBeInTheDocument()
    expect(screen.queryByTestId("plan-step-retry")).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId("plan-step-resume"))
    expect(h.onResume).toHaveBeenCalledTimes(1)
  })

  it("leaves only Cancel actionable without a chat surface, and says why", () => {
    render(<PlanStepFailureCard plan={plan()} halt={halt} canDispatch={false} {...handlers()} />)
    expect(screen.getByTestId("plan-step-failure-no-chat")).toBeInTheDocument()
    expect(screen.getByTestId("plan-step-retry")).toBeDisabled()
    expect(screen.getByTestId("plan-step-skip")).toBeDisabled()
    expect(screen.getByTestId("plan-step-mark-done")).toBeDisabled()
    expect(screen.getByTestId("plan-step-cancel")).toBeEnabled()
  })

  it("disables everything while an action is in flight", () => {
    render(<PlanStepFailureCard plan={plan()} halt={halt} canDispatch busy {...handlers()} />)
    expect(screen.getByTestId("plan-step-retry")).toBeDisabled()
    expect(screen.getByTestId("plan-step-cancel")).toBeDisabled()
  })
})
