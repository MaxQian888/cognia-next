import "fake-indexeddb/auto"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import type { Goal } from "@/types/goal"
import { GoalDetailSheet } from "./goal-detail-sheet"

const goal: Goal = {
  id: "g1",
  sessionId: "ses_a",
  rawObjective: "ship feature",
  safeObjective: "ship feature",
  redactionMapEnc: "",
  status: "active",
  turnsUsed: 0,
  tokensUsed: 0,
  judgeFailureCount: 0,
  config: {
    maxTurns: 20,
    maxTokens: 200_000,
    maxJudgeFailures: 3,
    timeoutMs: 30 * 60_000,
  },
  generationId: "gen-1",
  createdAt: Date.now(),
  updatedAt: Date.now(),
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

describe("GoalDetailSheet", () => {
  it("does not render content when closed", () => {
    render(<GoalDetailSheet goal={goal} open={false} onOpenChange={() => {}} />)
    expect(screen.queryByText(/Goal · active/)).toBeNull()
  })

  it("renders all four tabs when open", () => {
    render(<GoalDetailSheet goal={goal} open onOpenChange={() => {}} />)
    expect(screen.getByTestId("goal-tab-overview")).toBeInTheDocument()
    expect(screen.getByTestId("goal-tab-subgoals")).toBeInTheDocument()
    expect(screen.getByTestId("goal-tab-activity")).toBeInTheDocument()
    expect(screen.getByTestId("goal-tab-settings")).toBeInTheDocument()
  })

  it("renders the title with the goal status", () => {
    render(<GoalDetailSheet goal={goal} open onOpenChange={() => {}} />)
    expect(screen.getByText(/Goal · active/)).toBeInTheDocument()
  })

  it("clicking a tab updates its data-state to active", async () => {
    const user = userEvent.setup()
    render(<GoalDetailSheet goal={goal} open onOpenChange={() => {}} />)
    const subgoalsTrigger = screen.getByTestId("goal-tab-subgoals")
    await user.click(subgoalsTrigger)
    expect(subgoalsTrigger).toHaveAttribute("data-state", "active")
    expect(screen.getByTestId("goal-tab-overview")).toHaveAttribute("data-state", "inactive")
  })
})
