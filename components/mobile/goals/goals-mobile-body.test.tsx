/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { GoalsMobileBody } from "./goals-mobile-body"
import { useLiveQuery } from "dexie-react-hooks"
import { runSyncDown } from "@/lib/sync/companion-sync"
import type { Goal } from "@/types/goal"

jest.mock("dexie-react-hooks", () => ({ useLiveQuery: jest.fn() }))
jest.mock("@/lib/sync/companion-sync", () => ({ runSyncDown: jest.fn().mockResolvedValue([]) }))
jest.mock("@/lib/db/goals", () => ({ listAllGoals: jest.fn() }))
jest.mock("@/components/interactions/pull-to-refresh", () => ({
  PullToRefresh: ({
    children,
    onRefresh,
  }: {
    children: React.ReactNode
    onRefresh: () => void
  }) => (
    <div>
      <button data-testid="ptr-refresh" onClick={() => onRefresh()} />
      {children}
    </div>
  ),
}))
jest.mock("@/components/goal/goal-detail-sheet", () => ({
  GoalDetailSheet: ({
    open,
    onOpenChange,
  }: {
    open: boolean
    onOpenChange: (open: boolean) => void
  }) =>
    open ? <button data-testid="goal-detail-sheet" onClick={() => onOpenChange(false)} /> : null,
}))
jest.mock("@/components/goal/analytics/goal-analytics-panel", () => ({
  GoalAnalyticsPanel: () => <div data-testid="mock-analytics-panel" />,
}))

const liveQuery = useLiveQuery as jest.Mock
const syncDown = runSyncDown as jest.Mock

function goal(over: Partial<Goal>): Goal {
  return {
    id: "g1",
    safeObjective: "ship the thing",
    status: "active",
    turnsUsed: 2,
    config: { maxTurns: 10 },
    ...over,
  } as unknown as Goal
}

describe("<GoalsMobileBody />", () => {
  it("renders goals with a status stat strip", () => {
    liveQuery.mockReturnValue([
      goal({ id: "g1", status: "active", safeObjective: "ship the thing" }),
      goal({ id: "g2", status: "paused", safeObjective: "write the docs" }),
      goal({ id: "g3", status: "completed", safeObjective: "fix the bug" }),
    ])
    render(<GoalsMobileBody />)
    expect(screen.getByTestId("mobile-goal-g1")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-goals-stats")).toBeInTheDocument()
    expect(screen.getByText("ship the thing")).toBeInTheDocument()
  })

  it("shows the empty state when there are no goals", () => {
    liveQuery.mockReturnValue([])
    render(<GoalsMobileBody />)
    expect(screen.getByTestId("empty-state")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-spot-icon-goals")).toBeInTheDocument()
  })

  it("opens the goal detail sheet on tap", async () => {
    liveQuery.mockReturnValue([goal({ id: "g1" })])
    const user = userEvent.setup()
    render(<GoalsMobileBody />)
    await user.click(screen.getByTestId("mobile-goal-g1"))
    expect(screen.getByTestId("goal-detail-sheet")).toBeInTheDocument()
  })

  it("defaults to the Overview section and lists only open goals", () => {
    liveQuery.mockReturnValue([
      goal({ id: "g1", status: "active", safeObjective: "open one" }),
      goal({ id: "g2", status: "completed", safeObjective: "done one" }),
    ])
    render(<GoalsMobileBody />)
    expect(screen.getByTestId("mobile-goals-switcher")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-goal-g1")).toBeInTheDocument()
    // A completed goal is not "open" — hidden from Overview.
    expect(screen.queryByTestId("mobile-goal-g2")).not.toBeInTheDocument()
  })

  it("shows the History empty state when there are no goals", async () => {
    liveQuery.mockReturnValue([])
    const user = userEvent.setup()
    render(<GoalsMobileBody />)
    await user.click(screen.getByTestId("mobile-goals-section-history"))
    expect(screen.getByTestId("empty-state")).toBeInTheDocument()
  })

  it("switches to the History section to show terminal goals", async () => {
    liveQuery.mockReturnValue([
      goal({ id: "g1", status: "active", safeObjective: "open one" }),
      goal({ id: "g2", status: "completed", safeObjective: "done one" }),
    ])
    const user = userEvent.setup()
    render(<GoalsMobileBody />)
    await user.click(screen.getByTestId("mobile-goals-section-history"))
    expect(screen.getByTestId("mobile-goal-g2")).toBeInTheDocument()
  })

  it("switches to the Analytics section", async () => {
    liveQuery.mockReturnValue([goal({ id: "g1" })])
    const user = userEvent.setup()
    render(<GoalsMobileBody />)
    await user.click(screen.getByTestId("mobile-goals-section-analytics"))
    expect(screen.getByTestId("mock-analytics-panel")).toBeInTheDocument()
  })

  it("syncs goals on pull-to-refresh", async () => {
    liveQuery.mockReturnValue([goal({ id: "g1" })])
    syncDown.mockClear()
    const user = userEvent.setup()
    render(<GoalsMobileBody />)
    await user.click(screen.getByTestId("ptr-refresh"))
    expect(syncDown).toHaveBeenCalledWith({ only: ["goals"] })
  })

  it("swallows a failed refresh", async () => {
    liveQuery.mockReturnValue([goal({ id: "g1" })])
    syncDown.mockRejectedValueOnce(new Error("offline"))
    const user = userEvent.setup()
    render(<GoalsMobileBody />)
    await user.click(screen.getByTestId("ptr-refresh"))
    // No throw — the handler catches. The list is still rendered.
    expect(screen.getByTestId("mobile-goal-g1")).toBeInTheDocument()
  })

  it("opens a goal via keyboard and closes the detail sheet", async () => {
    liveQuery.mockReturnValue([goal({ id: "g1" })])
    const user = userEvent.setup()
    render(<GoalsMobileBody />)
    screen.getByTestId("mobile-goal-g1").focus()
    await user.keyboard("{Enter}")
    const sheet = screen.getByTestId("goal-detail-sheet")
    await user.click(sheet) // mock fires onOpenChange(false)
    expect(screen.queryByTestId("goal-detail-sheet")).not.toBeInTheDocument()
  })
})
