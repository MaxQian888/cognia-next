import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { Goal } from "@/types/goal"
import { useGoalConsoleView } from "@/hooks/goal/use-goal-console-view"
import { GoalOverviewSection } from "./goal-overview-section"

// next-intl globally mocked in jest.setup.ts (resolves keys against en.json).

// Heavy children are covered by their own suites; stub them so this suite
// focuses on the section's own branching (loading / empty / toolbar / filter).
jest.mock("@/components/goal/views/active-goal-card", () => ({
  ActiveGoalCard: ({ goal }: { goal: Goal }) => (
    <div data-testid="mock-active-card">{goal.safeObjective}</div>
  ),
}))
jest.mock("@/components/goal/goal-console-view-toggle", () => ({
  GoalConsoleViewToggle: () => <div data-testid="mock-view-toggle" />,
}))
jest.mock("@/components/goal/goal-quick-create-dialog", () => ({
  GoalQuickCreateDialog: () => <button data-testid="mock-quick-create" />,
}))
jest.mock("@/hooks/goal/use-goal-console-view", () => ({
  useGoalConsoleView: jest.fn(() => ({ view: "grid", setView: jest.fn() })),
}))
jest.mock("@/hooks/goal/use-goal-console-prefs", () => ({
  useGoalConsolePrefs: () => ({
    prefs: { defaultTab: "overview", openGoalsSort: "created", openGoalsDir: "desc" },
    setPrefs: jest.fn(),
  }),
}))

let goalSeq = 0
function goal(over: Partial<Goal> = {}): Goal {
  goalSeq += 1
  return {
    id: `goal_${goalSeq}`,
    status: "active",
    safeObjective: `objective ${goalSeq}`,
    turnsUsed: 1,
    tokensUsed: 100,
    judgeFailureCount: 0,
    createdAt: 1_700_000_000_000 + goalSeq,
    config: { maxTurns: 10, maxTokens: 1000 },
    ...over,
  } as Goal
}

describe("GoalOverviewSection", () => {
  beforeEach(() => {
    ;(useGoalConsoleView as jest.Mock).mockReturnValue({ view: "grid", setView: jest.fn() })
  })

  it("shows the skeleton while loading and hides the empty state", () => {
    render(<GoalOverviewSection goals={[]} loading onSwitchSection={jest.fn()} />)
    expect(screen.getByTestId("goal-console-overview-skeleton")).toBeInTheDocument()
    expect(screen.queryByTestId("goal-console-active-empty")).not.toBeInTheDocument()
  })

  it("shows the empty state when there are no open goals", () => {
    render(<GoalOverviewSection goals={[]} loading={false} onSwitchSection={jest.fn()} />)
    expect(screen.getByTestId("goal-console-active-empty")).toBeInTheDocument()
    expect(screen.queryByTestId("goal-console-overview-skeleton")).not.toBeInTheDocument()
  })

  it("renders the toolbar and the open-goals list", () => {
    render(
      <GoalOverviewSection
        goals={[goal({ safeObjective: "ship the thing" })]}
        loading={false}
        onSwitchSection={jest.fn()}
      />
    )
    expect(screen.getByTestId("goal-console-open-toolbar")).toBeInTheDocument()
    expect(screen.getByTestId("goal-console-open-list")).toBeInTheDocument()
    expect(screen.getByText("ship the thing")).toBeInTheDocument()
  })

  it("filters the list by search query", () => {
    render(
      <GoalOverviewSection
        goals={[goal({ safeObjective: "ship the thing" })]}
        loading={false}
        onSwitchSection={jest.fn()}
      />
    )
    const search = screen.getByTestId("goal-console-open-search") as HTMLInputElement
    fireEvent.change(search, { target: { value: "no-such-objective" } })
    expect(screen.getByTestId("goal-console-open-no-results")).toBeInTheDocument()
  })

  it("scoping to paused hides an active-only goal", () => {
    render(
      <GoalOverviewSection
        goals={[goal({ status: "active", safeObjective: "active one" })]}
        loading={false}
        onSwitchSection={jest.fn()}
      />
    )
    expect(screen.getByTestId("goal-console-open-list")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("goal-stat-paused"))
    expect(screen.getByTestId("goal-console-open-no-results")).toBeInTheDocument()
  })

  it("metric stat card switches section", () => {
    const onSwitchSection = jest.fn()
    render(
      <GoalOverviewSection goals={[goal()]} loading={false} onSwitchSection={onSwitchSection} />
    )
    fireEvent.click(screen.getByTestId("goal-stat-done"))
    expect(onSwitchSection).toHaveBeenCalledWith("history")
  })

  it("toggles the sort direction", () => {
    render(<GoalOverviewSection goals={[goal()]} loading={false} onSwitchSection={jest.fn()} />)
    const dir = screen.getByTestId("goal-console-open-dir")
    fireEvent.click(dir) // desc → asc
    fireEvent.click(dir) // asc → desc
    expect(dir).toBeInTheDocument()
  })

  it("changes the sort key via the sort select", async () => {
    const user = userEvent.setup()
    render(
      <GoalOverviewSection goals={[goal(), goal()]} loading={false} onSwitchSection={jest.fn()} />
    )
    await user.click(screen.getByTestId("goal-console-open-sort"))
    await user.click(await screen.findByRole("option", { name: /turns/i }))
    expect(screen.getByTestId("goal-console-open-list")).toBeInTheDocument()
  })

  it("renders the compact list view", () => {
    ;(useGoalConsoleView as jest.Mock).mockReturnValue({ view: "list", setView: jest.fn() })
    render(
      <GoalOverviewSection
        goals={[goal({ safeObjective: "listed goal" })]}
        loading={false}
        onSwitchSection={jest.fn()}
      />
    )
    expect(screen.getByTestId("goal-console-open-list")).toBeInTheDocument()
    expect(screen.getByText("listed goal")).toBeInTheDocument()
  })
})
