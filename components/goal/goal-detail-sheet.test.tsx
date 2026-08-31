import "fake-indexeddb/auto"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import type { Goal } from "@/types/goal"

const isMobileMock = jest.fn(() => false)
const resolveGoalAcceptanceMock = jest.fn().mockResolvedValue(undefined)
jest.mock("@/hooks/ui/use-mobile", () => ({
  useIsMobile: () => isMobileMock(),
}))
jest.mock("@/lib/goal/acceptance", () => ({
  resolveGoalAcceptance: (...args: unknown[]) => resolveGoalAcceptanceMock(...args),
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

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  isMobileMock.mockReturnValue(false)
  resolveGoalAcceptanceMock.mockClear()
})
afterAll(dbFixture.dispose)

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

  it("accept submits an accepted resolution for the displayed goal", async () => {
    const user = userEvent.setup()
    render(<GoalDetailSheet goal={{ ...awaitingGoal, id: "g-acc" }} open onOpenChange={() => {}} />)
    await user.click(screen.getByTestId("goal-acceptance-accept"))
    await waitFor(() => expect(resolveGoalAcceptanceMock).toHaveBeenCalledWith("g-acc", true))
  })

  it("request changes submits a rejected resolution for the displayed goal", async () => {
    const user = userEvent.setup()
    render(<GoalDetailSheet goal={{ ...awaitingGoal, id: "g-rej" }} open onOpenChange={() => {}} />)
    await user.click(screen.getByTestId("goal-acceptance-request-changes"))
    await waitFor(() => expect(resolveGoalAcceptanceMock).toHaveBeenCalledWith("g-rej", false))
  })
})
