/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import type { Goal } from "@/types/goal"
import { GoalAnalyticsPanel } from "./goal-analytics-panel"

// next-intl globally mocked against en.json in jest.setup.ts.

const NOW = new Date(2026, 4, 31, 12, 0, 0).getTime()

function goal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: crypto.randomUUID(),
    sessionId: "ses",
    rawObjective: "obj",
    safeObjective: "obj",
    redactionMapEnc: "",
    status: "completed",
    turnsUsed: 4,
    tokensUsed: 1000,
    judgeFailureCount: 0,
    config: { maxTurns: 20, maxTokens: 200_000, maxJudgeFailures: 3, timeoutMs: 1_800_000 },
    generationId: "gen",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

describe("GoalAnalyticsPanel", () => {
  it("renders an empty state with no goals", () => {
    render(<GoalAnalyticsPanel goals={[]} now={NOW} />)
    expect(screen.getByTestId("goal-analytics-empty")).toBeInTheDocument()
    expect(screen.queryByTestId("goal-analytics-panel")).not.toBeInTheDocument()
  })

  it("renders stat cards and three charts with goals", () => {
    render(
      <GoalAnalyticsPanel
        goals={[goal({ status: "completed" }), goal({ status: "active" })]}
        now={NOW}
      />
    )
    expect(screen.getByTestId("goal-analytics-panel")).toBeInTheDocument()
    expect(screen.getByTestId("goal-analytics-stat-total")).toBeInTheDocument()
    expect(screen.getByTestId("goal-analytics-stat-completion")).toBeInTheDocument()
    expect(screen.getByTestId("goal-analytics-donut")).toBeInTheDocument()
    expect(screen.getByTestId("goal-analytics-created-chart")).toBeInTheDocument()
    expect(screen.getByTestId("goal-analytics-tokens-chart")).toBeInTheDocument()
  })

  it("renders a status legend entry per distinct status", () => {
    render(
      <GoalAnalyticsPanel
        goals={[
          goal({ status: "completed" }),
          goal({ status: "completed" }),
          goal({ status: "paused" }),
        ]}
        now={NOW}
      />
    )
    expect(screen.getAllByTestId("goal-analytics-legend")).toHaveLength(2)
  })
})
