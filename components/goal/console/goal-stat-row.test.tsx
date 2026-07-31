import { fireEvent, render, screen } from "@testing-library/react"
import type { GoalAnalytics } from "@/lib/goal/analytics"
import { GoalStatRow } from "./goal-stat-row"

// next-intl globally mocked in jest.setup.ts (resolves keys against en.json).

const analytics: GoalAnalytics = {
  total: 6,
  active: 2,
  paused: 1,
  completed: 3,
  terminal: 3,
  completionRate: 1,
  avgTurns: 4.2,
  avgTokens: 1200,
  totalTokens: 15400,
  judgeFailureRate: 0,
  statusDistribution: [],
  timeline: [],
}

function renderRow(overrides: Partial<React.ComponentProps<typeof GoalStatRow>> = {}) {
  const onScope = jest.fn()
  const onSwitchSection = jest.fn()
  render(
    <GoalStatRow
      analytics={analytics}
      statusFilter="__all__"
      onScope={onScope}
      onSwitchSection={onSwitchSection}
      {...overrides}
    />
  )
  return { onScope, onSwitchSection }
}

describe("GoalStatRow", () => {
  it("renders both clusters with all five stat cards", () => {
    renderRow()
    expect(screen.getByText("Open")).toBeInTheDocument()
    expect(screen.getByText("Lifetime")).toBeInTheDocument()
    for (const id of [
      "goal-stat-active",
      "goal-stat-paused",
      "goal-stat-done",
      "goal-stat-avg-turns",
      "goal-stat-token-spend",
    ]) {
      expect(screen.getByTestId(id)).toBeInTheDocument()
    }
  })

  it("filter cards scope by status", () => {
    const { onScope } = renderRow()
    fireEvent.click(screen.getByTestId("goal-stat-active"))
    expect(onScope).toHaveBeenCalledWith("active")
    fireEvent.click(screen.getByTestId("goal-stat-paused"))
    expect(onScope).toHaveBeenCalledWith("paused")
  })

  it("reflects the active scope via aria-pressed", () => {
    renderRow({ statusFilter: "active" })
    expect(screen.getByTestId("goal-stat-active")).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByTestId("goal-stat-paused")).toHaveAttribute("aria-pressed", "false")
  })

  it("metric cards switch section (done → history, averages → analytics)", () => {
    const { onSwitchSection } = renderRow()
    fireEvent.click(screen.getByTestId("goal-stat-done"))
    expect(onSwitchSection).toHaveBeenCalledWith("history")
    fireEvent.click(screen.getByTestId("goal-stat-avg-turns"))
    expect(onSwitchSection).toHaveBeenCalledWith("analytics")
    fireEvent.click(screen.getByTestId("goal-stat-token-spend"))
    expect(onSwitchSection).toHaveBeenCalledWith("analytics")
  })

  it("activates cards from the keyboard", () => {
    const { onScope, onSwitchSection } = renderRow()
    fireEvent.keyDown(screen.getByTestId("goal-stat-active"), { key: "Enter" })
    expect(onScope).toHaveBeenCalledWith("active")
    fireEvent.keyDown(screen.getByTestId("goal-stat-done"), { key: " " })
    expect(onSwitchSection).toHaveBeenCalledWith("history")
  })

  it("formats token spend below and above 1k", () => {
    const { unmount } = render(
      <GoalStatRow
        analytics={{ ...analytics, totalTokens: 640 }}
        statusFilter="__all__"
        onScope={jest.fn()}
        onSwitchSection={jest.fn()}
      />
    )
    expect(screen.getByTestId("goal-stat-token-spend")).toHaveTextContent("640")
    unmount()
    render(
      <GoalStatRow
        analytics={{ ...analytics, totalTokens: 2400 }}
        statusFilter="__all__"
        onScope={jest.fn()}
        onSwitchSection={jest.fn()}
      />
    )
    expect(screen.getByTestId("goal-stat-token-spend")).toHaveTextContent("2.4k")
  })
})
