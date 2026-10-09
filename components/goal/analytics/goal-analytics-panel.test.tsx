/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import type { Goal } from "@/types/goal"
import { goalStatusChartColor } from "../goal-status-style"
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

  it("shows a skeleton, not the empty state, while the first read is in flight", () => {
    render(<GoalAnalyticsPanel goals={[]} loading now={NOW} />)
    expect(screen.getByTestId("goal-analytics-loading")).toHaveAttribute("aria-busy", "true")
    expect(screen.queryByTestId("goal-analytics-empty")).toBeNull()
    expect(screen.queryByTestId("goal-analytics-panel")).toBeNull()
  })

  it("lays the headline numbers out as one six-cell stat strip", () => {
    render(
      <GoalAnalyticsPanel
        goals={[
          goal({ status: "completed", turnsUsed: 4, tokensUsed: 2_000 }),
          goal({ status: "stopped", turnsUsed: 2, tokensUsed: 40_000 }),
        ]}
        now={NOW}
      />
    )
    const strip = screen.getByTestId("goal-analytics-stats")
    expect(strip.children).toHaveLength(6)
    expect(strip).toHaveClass("@4xl/console-pane:grid-cols-6")
    const cell = (id: string) => screen.getByTestId(`goal-analytics-stat-${id}`)
    expect(cell("total")).toHaveTextContent("2Total goals")
    expect(cell("completion")).toHaveTextContent("50%Completion rate")
    expect(cell("avg-turns")).toHaveTextContent("3.0Avg turns")
    expect(cell("avg-tokens")).toHaveTextContent("21KAvg tokens")
    expect(cell("token-spend")).toHaveTextContent("42KToken spend")
    expect(cell("judge-failure")).toHaveTextContent("0%Judge failure rate")
  })

  it("prints a dash for the completion rate before any goal has finished", () => {
    render(<GoalAnalyticsPanel goals={[goal({ status: "active" })]} now={NOW} />)
    expect(screen.getByTestId("goal-analytics-stat-completion")).toHaveTextContent("—")
  })

  it("flags a judge failure rate above a quarter", () => {
    render(
      <GoalAnalyticsPanel goals={[goal({ status: "completed", judgeFailureCount: 3 })]} now={NOW} />
    )
    const value = screen.getByTestId("goal-analytics-stat-judge-failure").querySelector("span")
    expect(value?.className).toContain("text-amber-600")
  })

  it("colours each legend swatch in the status's own tone", () => {
    render(
      <GoalAnalyticsPanel
        goals={[goal({ status: "completed" }), goal({ status: "paused" })]}
        now={NOW}
      />
    )
    const legend = screen.getAllByTestId("goal-analytics-legend")
    for (const [status, label] of [
      ["completed", "completed"],
      ["paused", "paused"],
    ] as const) {
      const entry = legend.find((li) => li.textContent?.startsWith(label))
      expect(entry).toBeDefined()
      const swatch = entry!.querySelector("span") as HTMLElement
      const tone = goalStatusChartColor(status)
      expect(swatch.style.backgroundColor).toBe(tone.fill)
      expect(swatch.style.opacity).toBe(String(tone.opacity))
      expect(entry).toHaveTextContent(`${label}1`)
    }
  })
})
