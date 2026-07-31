/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { PlanTrackerDock } from "./plan-tracker-dock"
import type { AgentPlan } from "@/types/agent/plan"
import { DEFAULT_PLAN_CONFIG } from "@/types/agent/plan"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const pausePlan = jest.fn().mockResolvedValue(null)
const resumePlan = jest.fn().mockResolvedValue(null)
const cancelPlan = jest.fn().mockResolvedValue(null)
jest.mock("@/lib/agent/plan/runtime", () => ({
  getPlanRuntime: () => ({ pausePlan, resumePlan, cancelPlan }),
}))

const mockPlan = jest.fn()
jest.mock("@/hooks/agent/use-session-plan", () => ({
  useSessionPlan: () => mockPlan(),
}))

function plan(over: Partial<AgentPlan> = {}): AgentPlan {
  return {
    id: "p1",
    sessionId: "ses",
    title: "Ship it",
    source: "exit_plan_mode",
    executionMode: "auto",
    steps: [],
    status: "executing",
    totalSteps: 0,
    completedSteps: 0,
    config: DEFAULT_PLAN_CONFIG,
    refinementCount: 0,
    generationId: "g",
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe("PlanTrackerDock", () => {
  it("renders only for executing / paused plans", () => {
    mockPlan.mockReturnValue(undefined)
    const { rerender, container } = render(<PlanTrackerDock sessionId="ses" />)
    expect(container).toBeEmptyDOMElement()

    for (const status of ["awaiting_approval", "approved", "completed", "cancelled"] as const) {
      mockPlan.mockReturnValue(plan({ status }))
      rerender(<PlanTrackerDock sessionId="ses" />)
      expect(screen.queryByTestId("plan-tracker-dock")).not.toBeInTheDocument()
    }

    mockPlan.mockReturnValue(plan({ status: "executing" }))
    rerender(<PlanTrackerDock sessionId="ses" />)
    expect(screen.getByTestId("plan-tracker-dock")).toBeInTheDocument()
    expect(screen.getByTestId("plan-tracker-panel")).toBeInTheDocument()
  })

  it("pauses an executing plan", async () => {
    mockPlan.mockReturnValue(plan({ status: "executing" }))
    render(<PlanTrackerDock sessionId="ses" />)
    expect(screen.queryByTestId("plan-tracker-resume")).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId("plan-tracker-pause"))
    await waitFor(() => expect(pausePlan).toHaveBeenCalledWith("p1"))
  })

  it("resumes a paused plan", async () => {
    mockPlan.mockReturnValue(plan({ status: "paused" }))
    render(<PlanTrackerDock sessionId="ses" />)
    expect(screen.queryByTestId("plan-tracker-pause")).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId("plan-tracker-resume"))
    await waitFor(() => expect(resumePlan).toHaveBeenCalledWith("p1"))
  })

  it("cancels from either live state", async () => {
    mockPlan.mockReturnValue(plan({ status: "executing" }))
    render(<PlanTrackerDock sessionId="ses" />)
    await userEvent.click(screen.getByTestId("plan-tracker-cancel"))
    await waitFor(() => expect(cancelPlan).toHaveBeenCalledWith("p1"))
  })
})
