import { fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { useGoalConsoleView } from "@/hooks/goal/use-goal-console-view"
import { computeGoalAnalytics } from "@/lib/goal/analytics"
import { GOAL_NOW, makeGoal } from "@/lib/storybook/fixtures/goal"
import type { Goal } from "@/types/goal"

import { GoalOverviewSection, type GoalOverviewSectionProps } from "./goal-overview-section"

// next-intl is globally mocked in jest.setup.ts (resolves keys against en.json).

// Rows and tiles have their own suites (goal-list-row / goal-grid-tile). The
// stubs keep the contract this section relies on: one `[data-goal-select]`
// button per goal, which the ↑/↓ handler walks, and the props it hands down.
jest.mock("./goal-list-row", () => ({
  GoalListRow: ({
    goal,
    selected,
    onSelect,
  }: {
    goal: Goal
    selected: boolean
    onSelect: (id: string) => void
  }) => (
    <li data-testid="mock-list-row" data-selected={selected || undefined}>
      <button type="button" data-goal-select={goal.id} onClick={() => onSelect(goal.id)}>
        {goal.safeObjective}
      </button>
    </li>
  ),
}))
jest.mock("./goal-grid-tile", () => ({
  GoalGridTile: ({ goal, onSelect }: { goal: Goal; onSelect: (id: string) => void }) => (
    <li data-testid="mock-grid-tile">
      <button type="button" data-goal-select={goal.id} onClick={() => onSelect(goal.id)}>
        {goal.safeObjective}
      </button>
    </li>
  ),
}))
jest.mock("@/components/goal/goal-console-view-toggle", () => ({
  GoalConsoleViewToggle: () => <div data-testid="mock-view-toggle" />,
}))
jest.mock("@/components/goal/goal-quick-create-dialog", () => ({
  GoalQuickCreateDialog: ({ triggerTestId }: { triggerTestId?: string }) => (
    <button type="button" data-testid={triggerTestId ?? "mock-quick-create"} />
  ),
}))
jest.mock("@/hooks/goal/use-goal-console-view", () => ({
  useGoalConsoleView: jest.fn(() => ({ view: "list", setView: jest.fn() })),
}))
jest.mock("@/hooks/goal/use-goal-console-prefs", () => ({
  useGoalConsolePrefs: () => ({
    prefs: { defaultTab: "overview", openGoalsSort: "created", openGoalsDir: "desc" },
    setPrefs: jest.fn(),
  }),
}))
// Sessions, agent names and judge notes come from Dexie; the rows are stubs.
jest.mock("@/hooks/goal/use-goal-row-context", () => ({
  useGoalRowContext: () => ({
    sessionFor: () => undefined,
    agentNameFor: () => undefined,
    judgeNoteFor: () => null,
  }),
}))

// jsdom has no `CSS.escape`; the ↑/↓ handler uses it to find the next row.
if (typeof globalThis.CSS === "undefined" || typeof globalThis.CSS.escape !== "function") {
  Object.defineProperty(globalThis, "CSS", {
    configurable: true,
    value: { escape: (value: string) => value.replace(/["\\]/g, "\\$&") },
  })
}

const viewMock = useGoalConsoleView as jest.Mock

function goal(id: string, over: Partial<Goal> = {}): Goal {
  return makeGoal({
    id,
    safeObjective: `objective ${id}`,
    rawObjective: `objective ${id}`,
    ...over,
  })
}

function renderSection(over: Partial<GoalOverviewSectionProps> = {}) {
  const props: GoalOverviewSectionProps = {
    openGoals: [],
    analytics: computeGoalAnalytics([], { now: GOAL_NOW }),
    analyticsLoading: false,
    selectedGoalId: null,
    onSelect: jest.fn(),
    onDeleted: jest.fn(),
    onOpenCompleted: jest.fn(),
    onOpenAnalytics: jest.fn(),
    ...over,
  }
  const utils = render(<GoalOverviewSection {...props} />)
  return { ...utils, props }
}

beforeEach(() => {
  viewMock.mockReturnValue({ view: "list", setView: jest.fn() })
})

describe("GoalOverviewSection", () => {
  it("shows the list skeleton while the first read is in flight", () => {
    renderSection({ openGoals: undefined })
    expect(screen.getByTestId("goal-console-overview-skeleton")).toBeInTheDocument()
    expect(screen.queryByTestId("goal-console-active-empty")).not.toBeInTheDocument()
    expect(screen.queryByTestId("goal-needs-you")).not.toBeInTheDocument()
  })

  it("shows the empty state with its own create trigger when nothing is open", () => {
    renderSection({ openGoals: [] })
    expect(screen.getByTestId("goal-console-active-empty")).toHaveTextContent("Nothing running")
    expect(screen.getByTestId("goal-console-empty-create")).toBeInTheDocument()
    expect(screen.queryByTestId("goal-console-open-toolbar")).not.toBeInTheDocument()
  })

  it("leads with the lifetime summary strip and routes its cells", () => {
    const { props } = renderSection({
      analytics: computeGoalAnalytics([goal("done", { status: "completed" })], { now: GOAL_NOW }),
    })
    fireEvent.click(screen.getByTestId("goal-stat-completed"))
    expect(props.onOpenCompleted).toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("goal-stat-avg-turns"))
    expect(props.onOpenAnalytics).toHaveBeenCalled()
  })

  it("shows the summary strip skeleton while analytics load", () => {
    renderSection({ analyticsLoading: true })
    expect(screen.getByTestId("goal-summary-strip-loading")).toBeInTheDocument()
  })

  it("lists running goals with the toolbar, scope counts and view toggle", () => {
    renderSection({
      openGoals: [goal("a"), goal("b", { status: "paused" }), goal("c")],
    })
    expect(screen.getByTestId("goal-console-open-toolbar")).toBeInTheDocument()
    expect(screen.getByTestId("mock-view-toggle")).toBeInTheDocument()
    const list = screen.getByTestId("goal-console-open-list")
    expect(list).toHaveAttribute("data-view", "list")
    expect(within(list).getAllByTestId("mock-list-row")).toHaveLength(3)
    expect(screen.getByTestId("goal-console-scope-all")).toHaveTextContent("All3")
    expect(screen.getByTestId("goal-console-scope-active")).toHaveTextContent("Active2")
    expect(screen.getByTestId("goal-console-scope-paused")).toHaveTextContent("Paused1")
    expect(screen.queryByTestId("goal-needs-you")).not.toBeInTheDocument()
  })

  it("puts goals awaiting acceptance under Needs you, not in the open list", () => {
    renderSection({
      openGoals: [goal("run"), goal("wait", { status: "paused", awaitingAcceptance: true })],
    })
    const needsYou = screen.getByTestId("goal-needs-you")
    expect(within(needsYou).getByRole("heading", { name: /Needs you/ })).toHaveTextContent("1")
    expect(
      within(screen.getByTestId("goal-needs-you-list")).getByText("objective wait")
    ).toBeInTheDocument()
    const open = screen.getByTestId("goal-console-open-list")
    expect(within(open).queryByText("objective wait")).not.toBeInTheDocument()
    expect(within(open).getByText("objective run")).toBeInTheDocument()
    // The paused scope does not count the awaiting goal.
    expect(screen.getByTestId("goal-console-scope-paused")).toHaveTextContent("Paused0")
  })

  it("says so when every open goal is waiting on a verdict", () => {
    renderSection({ openGoals: [goal("wait", { status: "paused", awaitingAcceptance: true })] })
    expect(screen.getByTestId("goal-needs-you")).toBeInTheDocument()
    expect(screen.getByTestId("goal-console-only-awaiting")).toBeInTheDocument()
    expect(screen.queryByTestId("goal-console-active-empty")).not.toBeInTheDocument()
    expect(screen.queryByTestId("goal-console-open-toolbar")).not.toBeInTheDocument()
  })

  it("scopes the list to paused goals", async () => {
    const user = userEvent.setup()
    renderSection({ openGoals: [goal("a"), goal("b", { status: "paused" })] })
    await user.click(screen.getByTestId("goal-console-scope-paused"))
    const list = screen.getByTestId("goal-console-open-list")
    expect(within(list).getByText("objective b")).toBeInTheDocument()
    expect(within(list).queryByText("objective a")).not.toBeInTheDocument()
  })

  it("filters by search, clears with Escape, and offers Clear filters on no match", async () => {
    const user = userEvent.setup()
    renderSection({ openGoals: [goal("a"), goal("b")] })
    const search = screen.getByTestId("goal-console-open-search")
    await user.type(search, "objective b")
    expect(
      within(screen.getByTestId("goal-console-open-list")).getAllByTestId("mock-list-row")
    ).toHaveLength(1)

    await user.keyboard("{Escape}")
    expect(search).toHaveValue("")
    expect(
      within(screen.getByTestId("goal-console-open-list")).getAllByTestId("mock-list-row")
    ).toHaveLength(2)

    await user.type(search, "no-such-objective")
    expect(screen.getByTestId("goal-console-open-no-results")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Clear filters" }))
    expect(search).toHaveValue("")
    expect(screen.getByTestId("goal-console-open-list")).toBeInTheDocument()
  })

  it("clears the search from its inline button", async () => {
    const user = userEvent.setup()
    renderSection({ openGoals: [goal("a")] })
    const search = screen.getByTestId("goal-console-open-search")
    await user.type(search, "zzz")
    await user.click(screen.getByRole("button", { name: "Clear search" }))
    expect(search).toHaveValue("")
  })

  it("sorts by turns and flips the direction", async () => {
    const user = userEvent.setup()
    renderSection({
      openGoals: [
        goal("few", { turnsUsed: 1, createdAt: GOAL_NOW - 1 }),
        goal("many", { turnsUsed: 9, createdAt: GOAL_NOW - 2 }),
      ],
    })
    const order = () =>
      within(screen.getByTestId("goal-console-open-list"))
        .getAllByTestId("mock-list-row")
        .map((row) => row.textContent)
    // Default: newest first.
    expect(order()).toEqual(["objective few", "objective many"])

    await user.click(screen.getByTestId("goal-console-open-sort"))
    await user.click(await screen.findByRole("option", { name: "Turns" }))
    expect(order()).toEqual(["objective many", "objective few"])

    const dir = screen.getByTestId("goal-console-open-dir")
    expect(dir).toHaveAccessibleName("Descending")
    await user.click(dir)
    expect(dir).toHaveAccessibleName("Ascending")
    expect(order()).toEqual(["objective few", "objective many"])
  })

  it("renders tiles in a bare grid in grid view", () => {
    viewMock.mockReturnValue({ view: "grid", setView: jest.fn() })
    renderSection({ openGoals: [goal("a"), goal("b")] })
    const grid = screen.getByTestId("goal-console-open-list")
    expect(grid).toHaveAttribute("data-view", "grid")
    expect(within(grid).getAllByTestId("mock-grid-tile")).toHaveLength(2)
    expect(screen.queryByTestId("mock-list-row")).not.toBeInTheDocument()
  })

  it("hands the selection down and selects on click", async () => {
    const user = userEvent.setup()
    const { props } = renderSection({ openGoals: [goal("a"), goal("b")], selectedGoalId: "b" })
    const rows = screen.getAllByTestId("mock-list-row")
    expect(rows.filter((row) => row.dataset.selected === "true")).toHaveLength(1)
    await user.click(screen.getByText("objective a"))
    expect(props.onSelect).toHaveBeenCalledWith("a")
  })

  it("walks the selection with ↑/↓, awaiting goals first, and moves focus", () => {
    const onSelect = jest.fn()
    renderSection({
      onSelect,
      openGoals: [
        goal("run1", { createdAt: GOAL_NOW - 1 }),
        goal("run2", { createdAt: GOAL_NOW - 2 }),
        goal("wait", { status: "paused", awaitingAcceptance: true }),
      ],
    })
    const waitButton = screen.getByText("objective wait")
    fireEvent.keyDown(waitButton, { key: "ArrowDown" })
    expect(onSelect).toHaveBeenLastCalledWith("run1")
    expect(screen.getByText("objective run1")).toHaveFocus()

    fireEvent.keyDown(screen.getByText("objective run1"), { key: "ArrowDown" })
    expect(onSelect).toHaveBeenLastCalledWith("run2")

    fireEvent.keyDown(screen.getByText("objective run2"), { key: "ArrowUp" })
    expect(onSelect).toHaveBeenLastCalledWith("run1")
  })

  it("stops at the ends of the list and ignores other keys", () => {
    const onSelect = jest.fn()
    renderSection({ onSelect, openGoals: [goal("only")] })
    const button = screen.getByText("objective only")
    fireEvent.keyDown(button, { key: "ArrowUp" })
    fireEvent.keyDown(button, { key: "ArrowDown" })
    fireEvent.keyDown(button, { key: "Enter" })
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("ignores arrow keys that do not come from a goal row", () => {
    const onSelect = jest.fn()
    renderSection({ onSelect, openGoals: [goal("a"), goal("b")] })
    fireEvent.keyDown(screen.getByTestId("goal-console-open-dir"), { key: "ArrowDown" })
    expect(onSelect).not.toHaveBeenCalled()
  })
})
