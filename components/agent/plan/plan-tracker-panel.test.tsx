/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import { PlanTrackerPanel } from "./plan-tracker-panel"
import type { AgentPlan, PlanStep } from "@/types/agent/plan"
import { DEFAULT_PLAN_CONFIG } from "@/types/agent/plan"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

function step(id: string, over: Partial<PlanStep> = {}): PlanStep {
  return {
    id,
    title: over.title ?? id,
    kind: "agent_turn",
    status: over.status ?? "pending",
    order: over.order ?? 0,
    dependencies: [],
  }
}

function plan(over: Partial<AgentPlan> = {}): AgentPlan {
  const steps = over.steps ?? [
    step("a", { title: "Build", status: "completed", order: 0 }),
    step("b", { title: "Test", status: "in_progress", order: 1 }),
  ]
  const completed = steps.filter((s) => s.status === "completed").length
  return {
    id: "p1",
    sessionId: "ses",
    title: over.title ?? "My plan",
    source: "manual",
    executionMode: "auto",
    steps,
    status: over.status ?? "executing",
    currentStepId: over.currentStepId,
    totalSteps: steps.length,
    completedSteps: over.completedSteps ?? completed,
    config: DEFAULT_PLAN_CONFIG,
    refinementCount: 0,
    generationId: "g",
    createdAt: 0,
    updatedAt: 0,
  }
}

describe("PlanTrackerPanel", () => {
  it("renders title, status, steps and per-step status labels", () => {
    render(<PlanTrackerPanel plan={plan()} />)
    expect(screen.getByTestId("plan-tracker-panel")).toBeInTheDocument()
    expect(screen.getByText("Build")).toBeInTheDocument()
    expect(screen.getByText("Test")).toBeInTheDocument()
    expect(screen.getByText("status.executing")).toBeInTheDocument()
    expect(screen.getByText("tracker.statusCompleted")).toBeInTheDocument()
    expect(screen.getByText("tracker.statusInProgress")).toBeInTheDocument()
  })

  it("computes the progress bar width from completed/total", () => {
    render(<PlanTrackerPanel plan={plan()} />)
    const bar = screen.getByTestId("plan-tracker-progress")
    expect(bar).toHaveStyle({ width: "50%" })
    expect(bar).toHaveAttribute("aria-valuenow", "50")
  })

  it("marks the current step", () => {
    render(<PlanTrackerPanel plan={plan({ currentStepId: "b" })} />)
    const current = screen.getByText("Test").closest("li")
    expect(current).toHaveAttribute("data-current", "true")
  })

  it("renders 0% with no steps and the empty state", () => {
    render(<PlanTrackerPanel plan={plan({ steps: [], completedSteps: 0 })} />)
    expect(screen.getByTestId("plan-tracker-progress")).toHaveStyle({ width: "0%" })
    expect(screen.getByText("tracker.empty")).toBeInTheDocument()
  })

  it("renders an icon for every step status (covers all glyph branches)", () => {
    const statuses = [
      "pending",
      "ready",
      "in_progress",
      "completed",
      "failed",
      "skipped",
      "blocked",
    ] as const
    const steps = statuses.map((s, i) => step(`s${i}`, { title: `step ${s}`, status: s, order: i }))
    render(<PlanTrackerPanel plan={plan({ steps, completedSteps: 1 })} />)
    for (const s of statuses) {
      expect(screen.getByText(`step ${s}`)).toBeInTheDocument()
    }
  })
})
