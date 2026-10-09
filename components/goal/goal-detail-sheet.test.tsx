import "fake-indexeddb/auto"
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { updateGoal } from "@/lib/db/goals"
import { getDb } from "@/lib/db/schema"
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

jest.mock("@/lib/data-hooks/context", () => ({
  useCharacter: () => undefined,
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
  // The panel reads the goal live by id; the opener's row only paints first.
  await getDb().chatGoals.put(goal)
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

  it("names the sheet with the goal status for assistive tech only", () => {
    render(<GoalDetailSheet goal={goal} open onOpenChange={() => {}} />)
    expect(screen.getByRole("dialog", { name: "Goal · active" })).toBeInTheDocument()
    // The panel draws its own header, so the sheet header is visually hidden.
    expect(screen.getByText("Goal · active").parentElement).toHaveClass("sr-only")
  })

  it("wraps GoalDetailPanel, painting the opener's goal first", () => {
    render(<GoalDetailSheet goal={goal} open onOpenChange={() => {}} />)
    expect(screen.getByTestId("goal-detail-panel")).toBeInTheDocument()
    expect(screen.getByTestId("goal-objective-text")).toHaveTextContent("ship feature")
  })

  it("has a single close button — the panel's — which closes the sheet", async () => {
    const user = userEvent.setup()
    const onOpenChange = jest.fn()
    render(<GoalDetailSheet goal={goal} open onOpenChange={onOpenChange} />)
    // The sheet's own corner close is off.
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull()
    await user.click(screen.getByRole("button", { name: "Close details" }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("clicking a tab updates its data-state to active", async () => {
    const user = userEvent.setup()
    render(<GoalDetailSheet goal={goal} open onOpenChange={() => {}} />)
    const subgoalsTrigger = screen.getByTestId("goal-tab-subgoals")
    await user.click(subgoalsTrigger)
    await waitFor(() =>
      expect(screen.getByTestId("goal-tab-subgoals")).toHaveAttribute("data-state", "active")
    )
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

  it("renders the banner only while paused + awaitingAcceptance", async () => {
    await getDb().chatGoals.put(awaitingGoal)
    render(<GoalDetailSheet goal={awaitingGoal} open onOpenChange={() => {}} />)
    expect(screen.getByTestId("goal-acceptance-banner")).toBeInTheDocument()
    // The sheet follows the stored row, not the snapshot it was opened with.
    await act(async () => {
      await updateGoal("g1", { status: "active", awaitingAcceptance: false })
    })
    await waitFor(() => expect(screen.queryByTestId("goal-acceptance-banner")).toBeNull())
  })

  it("shows the missing state when the goal is gone from storage", async () => {
    await getDb().chatGoals.delete("g1")
    render(<GoalDetailSheet goal={goal} open onOpenChange={() => {}} />)
    expect(await screen.findByText("Goal not found")).toBeInTheDocument()
  })

  it("accept submits an accepted resolution for the displayed goal", async () => {
    const user = userEvent.setup()
    await getDb().chatGoals.put({ ...awaitingGoal, id: "g-acc" })
    render(<GoalDetailSheet goal={{ ...awaitingGoal, id: "g-acc" }} open onOpenChange={() => {}} />)
    await user.click(screen.getByTestId("goal-acceptance-accept"))
    await waitFor(() => expect(resolveGoalAcceptanceMock).toHaveBeenCalledWith("g-acc", true))
  })

  it("request changes submits a rejected resolution for the displayed goal", async () => {
    const user = userEvent.setup()
    await getDb().chatGoals.put({ ...awaitingGoal, id: "g-rej" })
    render(<GoalDetailSheet goal={{ ...awaitingGoal, id: "g-rej" }} open onOpenChange={() => {}} />)
    await user.click(screen.getByTestId("goal-acceptance-request-changes"))
    await waitFor(() => expect(resolveGoalAcceptanceMock).toHaveBeenCalledWith("g-rej", false))
  })
})
