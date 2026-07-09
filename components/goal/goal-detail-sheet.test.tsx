import "fake-indexeddb/auto"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import type { Goal } from "@/types/goal"

const isMobileMock = jest.fn(() => false)
jest.mock("@/hooks/ui/use-mobile", () => ({
  useIsMobile: () => isMobileMock(),
}))

// Completion linkage fires real notification/workflow side effects — stub it
// so the acceptance-banner tests stay hermetic.
jest.mock("@/lib/goal/completion-linkage", () => ({
  onGoalTerminal: jest.fn().mockResolvedValue(undefined),
  toGoalHookPayload: (g: unknown) => g,
}))

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
  isMobileMock.mockReturnValue(false)
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

  it("renders the bottom Drawer (with the same tabs) on mobile", () => {
    isMobileMock.mockReturnValue(true)
    render(<GoalDetailSheet goal={goal} open onOpenChange={() => {}} />)
    // Same tab content, different container — title + tabs still present.
    expect(screen.getByText(/Goal · active/)).toBeInTheDocument()
    expect(screen.getByTestId("goal-tab-overview")).toBeInTheDocument()
  })
})

describe("GoalDetailSheet — acceptance banner", () => {
  const awaitingGoal: Goal = {
    ...goal,
    status: "paused",
    awaitingAcceptance: true,
    config: { ...goal.config, requireAcceptance: true },
  }

  it("renders the banner only while paused + awaitingAcceptance", () => {
    const { rerender } = render(
      <GoalDetailSheet goal={awaitingGoal} open onOpenChange={() => {}} />
    )
    expect(screen.getByTestId("goal-acceptance-banner")).toBeInTheDocument()
    rerender(<GoalDetailSheet goal={goal} open onOpenChange={() => {}} />)
    expect(screen.queryByTestId("goal-acceptance-banner")).toBeNull()
  })

  it("accept resolves the acceptance and completes the goal", async () => {
    const { createGoal, getGoal, updateGoal } = await import("@/lib/db/goals")
    await createGoal({
      id: "g-acc",
      sessionId: "ses_a",
      rawObjective: "x",
      safeObjective: "x",
      redactionMapEnc: "",
      status: "paused",
      turnsUsed: 1,
      tokensUsed: 0,
      judgeFailureCount: 0,
      config: awaitingGoal.config,
      generationId: "gen-1",
    })
    await updateGoal("g-acc", { awaitingAcceptance: true })
    const user = userEvent.setup()
    render(<GoalDetailSheet goal={{ ...awaitingGoal, id: "g-acc" }} open onOpenChange={() => {}} />)
    await user.click(screen.getByTestId("goal-acceptance-accept"))
    await waitFor(async () => {
      expect((await getGoal("g-acc"))?.status).toBe("completed")
    })
  })

  it("request changes resumes the goal", async () => {
    const { createGoal, getGoal, updateGoal } = await import("@/lib/db/goals")
    await createGoal({
      id: "g-rej",
      sessionId: "ses_a",
      rawObjective: "x",
      safeObjective: "x",
      redactionMapEnc: "",
      status: "paused",
      turnsUsed: 1,
      tokensUsed: 0,
      judgeFailureCount: 0,
      config: awaitingGoal.config,
      generationId: "gen-1",
    })
    await updateGoal("g-rej", { awaitingAcceptance: true })
    const user = userEvent.setup()
    render(<GoalDetailSheet goal={{ ...awaitingGoal, id: "g-rej" }} open onOpenChange={() => {}} />)
    await user.click(screen.getByTestId("goal-acceptance-request-changes"))
    await waitFor(async () => {
      expect((await getGoal("g-rej"))?.status).toBe("active")
    })
  })
})
