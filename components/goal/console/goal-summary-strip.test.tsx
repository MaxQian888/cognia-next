import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { computeGoalAnalytics, type GoalAnalytics } from "@/lib/goal/analytics"
import { GOAL_NOW, makeGoal } from "@/lib/storybook/fixtures/goal"

import { GoalSummaryStrip } from "./goal-summary-strip"

// next-intl is globally mocked in jest.setup.ts (resolves keys against en.json).

function analyticsFor(): GoalAnalytics {
  return computeGoalAnalytics(
    [
      makeGoal({ id: "a", status: "completed", turnsUsed: 4, tokensUsed: 40_000 }),
      makeGoal({ id: "b", status: "stopped", turnsUsed: 2, tokensUsed: 20_000 }),
      makeGoal({ id: "c", status: "active", turnsUsed: 3, tokensUsed: 30_000 }),
    ],
    { now: GOAL_NOW }
  )
}

function renderStrip(analytics: GoalAnalytics, loading = false) {
  const onOpenCompleted = jest.fn()
  const onOpenAnalytics = jest.fn()
  render(
    <GoalSummaryStrip
      analytics={analytics}
      loading={loading}
      onOpenCompleted={onOpenCompleted}
      onOpenAnalytics={onOpenAnalytics}
    />
  )
  return { onOpenCompleted, onOpenAnalytics }
}

describe("GoalSummaryStrip", () => {
  it("shows a same-shaped skeleton while loading", () => {
    renderStrip(analyticsFor(), true)
    expect(screen.getByTestId("goal-summary-strip-loading")).toHaveAttribute("aria-busy", "true")
    expect(screen.queryByTestId("goal-summary-strip")).not.toBeInTheDocument()
  })

  it("renders the four lifetime cells", () => {
    renderStrip(analyticsFor())
    expect(screen.getByTestId("goal-summary-strip")).toBeInTheDocument()
    // Completed out of finished (completed + stopped), not out of every goal.
    const completed = screen.getByTestId("goal-stat-completed")
    expect(completed).toHaveTextContent("1")
    expect(completed).toHaveTextContent("/2")
    expect(completed).toHaveTextContent("Completed of finished")
    expect(screen.getByTestId("goal-stat-avg-turns")).toHaveTextContent("3.0")
    expect(screen.getByTestId("goal-stat-avg-tokens")).toHaveTextContent("30K")
    expect(screen.getByTestId("goal-stat-token-spend")).toHaveTextContent("90K")
  })

  it("prints a dash for averages when there are no goals", () => {
    renderStrip(computeGoalAnalytics([], { now: GOAL_NOW }))
    expect(screen.getByTestId("goal-stat-avg-turns")).toHaveTextContent("—")
    expect(screen.getByTestId("goal-stat-avg-tokens")).toHaveTextContent("—")
    expect(screen.getByTestId("goal-stat-token-spend")).toHaveTextContent("0")
    expect(screen.getByTestId("goal-stat-completed")).toHaveTextContent("0/0")
  })

  it("opens History from the Completed cell", async () => {
    const user = userEvent.setup()
    const { onOpenCompleted, onOpenAnalytics } = renderStrip(analyticsFor())
    await user.click(screen.getByRole("button", { name: /Open the History tab/ }))
    expect(onOpenCompleted).toHaveBeenCalledTimes(1)
    expect(onOpenAnalytics).not.toHaveBeenCalled()
  })

  it("opens Analytics from each of the other cells", async () => {
    const user = userEvent.setup()
    const { onOpenAnalytics, onOpenCompleted } = renderStrip(analyticsFor())
    await user.click(screen.getByTestId("goal-stat-avg-turns"))
    await user.click(screen.getByTestId("goal-stat-avg-tokens"))
    await user.click(screen.getByTestId("goal-stat-token-spend"))
    expect(onOpenAnalytics).toHaveBeenCalledTimes(3)
    expect(onOpenCompleted).not.toHaveBeenCalled()
  })
})
