import "fake-indexeddb/auto"
import { render, screen, waitFor } from "@testing-library/react"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { appendGoalEvent, createGoal } from "@/lib/db/goals"
import type { Goal } from "@/types/goal"
import { GoalOverviewTab } from "./overview-tab"

const CONFIG: Goal["config"] = {
  maxTurns: 20,
  maxTokens: 200_000,
  maxJudgeFailures: 3,
  timeoutMs: 30 * 60_000,
}

function buildGoal(overrides: Partial<Goal> = {}): Goal {
  const now = Date.now()
  return {
    id: "g1",
    sessionId: "ses_a",
    rawObjective: "ship feature",
    safeObjective: "ship feature",
    redactionMapEnc: "",
    status: "active",
    turnsUsed: 5,
    tokensUsed: 50_000,
    judgeFailureCount: 0,
    config: CONFIG,
    generationId: "gen-1",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

describe("GoalOverviewTab", () => {
  it("renders objective + status + progress text", async () => {
    render(<GoalOverviewTab goal={buildGoal()} />)
    expect(screen.getByText("ship feature")).toBeInTheDocument()
    expect(screen.getByText("Status: active")).toBeInTheDocument()
    expect(screen.getByText("5 / 20")).toBeInTheDocument()
    expect(screen.getByText("50,000 / 200,000")).toBeInTheDocument()
  })

  it("shows the last judge reason when an event exists", async () => {
    await createGoal({ ...buildGoal(), id: "g1" })
    await appendGoalEvent({
      goalId: "g1",
      kind: "judge_evaluated",
      payload: { kind: "judge_evaluated", done: false, reason: "needs more work", judgeTokens: 0 },
    })
    render(<GoalOverviewTab goal={buildGoal({ id: "g1" })} />)
    // Curly quotes from &ldquo;/&rdquo; entities used in the component for
    // typographic correctness — match the actual rendered string.
    await waitFor(() => expect(screen.getByText("“needs more work”")).toBeInTheDocument())
  })

  it("shows endedAt badge when the goal has ended", () => {
    const ended = buildGoal({ status: "completed", endedAt: 1_700_000_000_000 })
    render(<GoalOverviewTab goal={ended} />)
    expect(screen.getByText(/Ended:/)).toBeInTheDocument()
  })

  it("pins the foreground-dormancy note to active goals only (contract, no boot re-arm)", () => {
    const { rerender } = render(<GoalOverviewTab goal={buildGoal({ status: "active" })} />)
    expect(screen.getByTestId("goal-foreground-dormancy-note")).toBeInTheDocument()
    // Terminal goals have nothing to resume — the note must not show.
    rerender(<GoalOverviewTab goal={buildGoal({ status: "completed", endedAt: 1 })} />)
    expect(screen.queryByTestId("goal-foreground-dormancy-note")).not.toBeInTheDocument()
  })
})
