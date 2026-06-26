/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { GoalsMobileBody } from "./goals-mobile-body"
import { useLiveQuery } from "dexie-react-hooks"
import type { Goal } from "@/types/goal"

jest.mock("dexie-react-hooks", () => ({ useLiveQuery: jest.fn() }))
jest.mock("@/lib/sync/companion-sync", () => ({ runSyncDown: jest.fn().mockResolvedValue([]) }))
jest.mock("@/lib/db/goals", () => ({ listAllGoals: jest.fn() }))
jest.mock("@/components/interactions/pull-to-refresh", () => ({
  PullToRefresh: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))
jest.mock("@/components/goal/goal-detail-sheet", () => ({
  GoalDetailSheet: ({ open }: { open: boolean }) =>
    open ? <div data-testid="goal-detail-sheet" /> : null,
}))

const liveQuery = useLiveQuery as jest.Mock

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
  })

  it("opens the goal detail sheet on tap", async () => {
    liveQuery.mockReturnValue([goal({ id: "g1" })])
    const user = userEvent.setup()
    render(<GoalsMobileBody />)
    await user.click(screen.getByTestId("mobile-goal-g1"))
    expect(screen.getByTestId("goal-detail-sheet")).toBeInTheDocument()
  })
})
