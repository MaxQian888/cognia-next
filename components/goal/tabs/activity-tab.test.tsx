import "fake-indexeddb/auto"
import { render, screen, waitFor } from "@testing-library/react"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { appendGoalEvent, createGoal } from "@/lib/db/goals"
import type { Goal } from "@/types/goal"
import { GoalActivityTab } from "./activity-tab"

const goal: Goal = {
  id: "g1",
  sessionId: "ses_a",
  rawObjective: "x",
  safeObjective: "x",
  redactionMapEnc: "",
  status: "active",
  turnsUsed: 0,
  tokensUsed: 0,
  judgeFailureCount: 0,
  config: { maxTurns: 20, maxTokens: 200_000, maxJudgeFailures: 3, timeoutMs: 30 * 60_000 },
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

describe("GoalActivityTab", () => {
  it("shows the empty-state message when no events exist", async () => {
    await createGoal(goal)
    render(<GoalActivityTab goal={goal} />)
    await waitFor(() => expect(screen.getByTestId("goal-activity-empty")).toBeInTheDocument())
  })

  it("renders event rows newest-first", async () => {
    await createGoal(goal)
    await appendGoalEvent({
      goalId: "g1",
      kind: "turn_started",
      payload: { kind: "turn_started", turnNumber: 1 },
      ts: 100,
    })
    await appendGoalEvent({
      goalId: "g1",
      kind: "turn_completed",
      payload: { kind: "turn_completed", turnNumber: 1, tokensDelta: 50 },
      ts: 200,
    })
    render(<GoalActivityTab goal={goal} />)
    await waitFor(() => expect(screen.getByTestId("goal-activity-list")).toBeInTheDocument())
    const items = screen.getAllByRole("listitem")
    expect(items).toHaveLength(2)
    // newest first — turn_completed has ts=200, should be on top
    expect(items[0]?.textContent).toContain("turn_completed")
  })

  it("surfaces exit_triggered with the reason in the summary", async () => {
    await createGoal(goal)
    await appendGoalEvent({
      goalId: "g1",
      kind: "exit_triggered",
      payload: { kind: "exit_triggered", exit: "turn_limited", reason: "budget exhausted" },
    })
    render(<GoalActivityTab goal={goal} />)
    await waitFor(() =>
      expect(screen.getByText(/turn_limited — budget exhausted/)).toBeInTheDocument()
    )
  })

  it("renders all 11 event kinds with their kind-specific summaries", async () => {
    await createGoal(goal)
    const baseConfig = { maxTurns: 20, maxTokens: 200_000, maxJudgeFailures: 3, timeoutMs: 1 }
    const all: Array<Parameters<typeof appendGoalEvent>[0]> = [
      {
        goalId: "g1",
        kind: "goal_created",
        payload: { kind: "goal_created", safeObjective: "x", config: baseConfig },
      },
      {
        goalId: "g1",
        kind: "objective_updated",
        payload: { kind: "objective_updated", oldSafeObjective: "a", newSafeObjective: "b" },
      },
      {
        goalId: "g1",
        kind: "turn_started",
        payload: { kind: "turn_started", turnNumber: 1 },
      },
      {
        goalId: "g1",
        kind: "turn_completed",
        payload: { kind: "turn_completed", turnNumber: 1, tokensDelta: 10 },
      },
      {
        goalId: "g1",
        kind: "judge_evaluated",
        payload: { kind: "judge_evaluated", done: false, reason: "x", judgeTokens: 5 },
      },
      {
        goalId: "g1",
        kind: "judge_parse_failed",
        payload: { kind: "judge_parse_failed", raw: "bad", failureCount: 1 },
      },
      {
        goalId: "g1",
        kind: "exit_triggered",
        payload: { kind: "exit_triggered", exit: "judge_done", reason: "done" },
      },
      { goalId: "g1", kind: "user_paused", payload: { kind: "user_paused" } },
      { goalId: "g1", kind: "user_resumed", payload: { kind: "user_resumed" } },
      { goalId: "g1", kind: "user_stopped", payload: { kind: "user_stopped" } },
      {
        goalId: "g1",
        kind: "config_updated",
        payload: { kind: "config_updated", before: baseConfig, after: baseConfig },
      },
    ]
    for (let i = 0; i < all.length; i++) {
      await appendGoalEvent({ ...all[i]!, ts: i })
    }
    render(<GoalActivityTab goal={goal} />)
    await waitFor(() => expect(screen.getByTestId("goal-activity-list")).toBeInTheDocument())
    expect(screen.getByText(/Created with 20-turn/)).toBeInTheDocument()
    expect(screen.getByText("Objective replaced")).toBeInTheDocument()
    expect(screen.getByText("Turn 1 started")).toBeInTheDocument()
    expect(screen.getByText(/Turn 1 completed/)).toBeInTheDocument()
    expect(screen.getByText(/done=false/)).toBeInTheDocument()
    expect(screen.getByText("Parse failure #1")).toBeInTheDocument()
    expect(screen.getByText(/judge_done — done/)).toBeInTheDocument()
    expect(screen.getByText("User paused")).toBeInTheDocument()
    expect(screen.getByText("User resumed")).toBeInTheDocument()
    expect(screen.getByText("User stopped")).toBeInTheDocument()
    expect(screen.getByText("Config updated")).toBeInTheDocument()
  })

  it("renders the loading state before the live query resolves", () => {
    // No goal row in Dexie yet → useLiveQuery returns undefined first
    render(<GoalActivityTab goal={goal} />)
    expect(screen.getByText("Loading…")).toBeInTheDocument()
  })
})
