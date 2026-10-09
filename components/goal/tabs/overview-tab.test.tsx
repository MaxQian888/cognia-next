import "fake-indexeddb/auto"
import { render, screen, waitFor } from "@testing-library/react"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { appendGoalEvent, createGoal } from "@/lib/db/goals"
import { syncGoalEvents } from "@/lib/sync/handlers/goals"
import type { Transport } from "@/lib/tauri/transport-types"
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
  it("shows budget meters without repeating the inspector header", () => {
    render(<GoalOverviewTab goal={buildGoal()} />)
    // Objective / status / created live in the inspector header now.
    expect(screen.queryByText("ship feature")).toBeNull()
    expect(screen.queryByText(/Status:/)).toBeNull()
    expect(screen.queryByText(/Created/)).toBeNull()
    expect(screen.getByText("Budget")).toBeInTheDocument()
    expect(screen.getByText("5 / 20")).toBeInTheDocument()
    expect(screen.getByText("50K / 200K")).toBeInTheDocument()
    const turns = screen.getByRole("progressbar", { name: "Turn budget used" })
    expect(turns).toHaveAttribute("aria-valuenow", "25")
    const tokens = screen.getByRole("progressbar", { name: "Token budget used" })
    expect(tokens).toHaveAttribute("aria-valuenow", "25")
  })

  it("shows the time left for an open goal", () => {
    const createdAt = Date.now() - 10 * 60_000
    render(<GoalOverviewTab goal={buildGoal({ createdAt })} />)
    const meter = screen.getByTestId("goal-overview-time-left")
    expect(meter).toHaveTextContent("Time left")
    // ~20 of 30 minutes remain.
    expect(meter).toHaveTextContent(/(19|20) min/)
    expect(screen.getByRole("progressbar", { name: "Time budget used" })).toBeInTheDocument()
  })

  it("says the time limit is reached once past the wall-clock cap", () => {
    const createdAt = Date.now() - 60 * 60_000
    render(<GoalOverviewTab goal={buildGoal({ createdAt })} />)
    expect(screen.getByTestId("goal-overview-time-left")).toHaveTextContent("Time limit reached")
    expect(screen.getByRole("progressbar", { name: "Time budget used" })).toHaveAttribute(
      "aria-valuenow",
      "100"
    )
  })

  it("omits the time meter for a finished goal", () => {
    render(<GoalOverviewTab goal={buildGoal({ status: "completed", endedAt: Date.now() })} />)
    expect(screen.queryByTestId("goal-overview-time-left")).toBeNull()
  })

  it("shows the per-turn cost ceiling only when one is set", () => {
    const { rerender } = render(<GoalOverviewTab goal={buildGoal()} />)
    expect(screen.queryByTestId("goal-overview-cost-ceiling")).toBeNull()
    rerender(<GoalOverviewTab goal={buildGoal({ config: { ...CONFIG, maxBudgetUsd: 2 } })} />)
    // The jest next-intl formatter stringifies numbers.
    expect(screen.getByTestId("goal-overview-cost-ceiling")).toHaveTextContent(
      "Each turn is capped at 2."
    )
  })

  it("shows the next continuation and a pending promise for an active goal", () => {
    render(
      <GoalOverviewTab
        goal={buildGoal({
          nextContinuationAt: 1_700_000_000_000,
          nextContinuationSource: "quiet_hours",
          awaitingPromise: true,
        })}
      />
    )
    expect(screen.getByText("Loop")).toBeInTheDocument()
    expect(screen.getByTestId("goal-overview-next-continuation")).toHaveTextContent("(quiet hours)")
    expect(screen.getByText("Awaiting completion confirmation")).toBeInTheDocument()
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

  it("on a paired phone, reads the judge and exit sections from the synced event log", async () => {
    // Nothing was appended on this device: the rows arrive through the
    // `goalEvents` pull, exactly as the desktop wrote them.
    const desktop: Transport = {
      call: jest.fn(async () => ({
        rows: [
          {
            id: "ev-judge",
            goalId: "g3",
            kind: "judge_evaluated",
            ts: 10,
            payload: { kind: "judge_evaluated", done: true, reason: "all green", judgeTokens: 4 },
          },
          {
            id: "ev-exit",
            goalId: "g3",
            kind: "exit_triggered",
            ts: 11,
            payload: { kind: "exit_triggered", exit: "judge_done", reason: "objective met" },
          },
        ],
        deleted_ids: [],
        next_since: 11,
        next_cursor: "c",
      })) as unknown as Transport["call"],
      subscribe: jest.fn(() => () => {}) as unknown as Transport["subscribe"],
    }
    expect((await syncGoalEvents(desktop, { since: 0 })).ok).toBe(true)
    render(<GoalOverviewTab goal={buildGoal({ id: "g3", status: "completed", endedAt: 12 })} />)
    await waitFor(() => expect(screen.getByText("“all green”")).toBeInTheDocument())
    expect(screen.getByText("objective met")).toBeInTheDocument()
  })

  it("shows the exit reason of a finished goal", async () => {
    await createGoal({ ...buildGoal(), id: "g2", status: "timed_out" })
    await appendGoalEvent({
      goalId: "g2",
      kind: "exit_triggered",
      payload: { kind: "exit_triggered", exit: "timed_out", reason: "ran out of time" },
    })
    render(<GoalOverviewTab goal={buildGoal({ id: "g2", status: "timed_out", endedAt: 1 })} />)
    await waitFor(() => expect(screen.getByText("ran out of time")).toBeInTheDocument())
    expect(screen.getByText("Exit reason")).toBeInTheDocument()
  })

  it("pins the foreground-dormancy note to active goals only (contract, no boot re-arm)", () => {
    const { rerender } = render(<GoalOverviewTab goal={buildGoal({ status: "active" })} />)
    expect(screen.getByTestId("goal-foreground-dormancy-note")).toBeInTheDocument()
    // Terminal goals have nothing to resume — the note must not show.
    rerender(<GoalOverviewTab goal={buildGoal({ status: "completed", endedAt: 1 })} />)
    expect(screen.queryByTestId("goal-foreground-dormancy-note")).not.toBeInTheDocument()
  })
})
