import "fake-indexeddb/auto"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { appendGoalEvent, createGoal } from "@/lib/db/goals"
import { getDb } from "@/lib/db/schema"
import { applyGoalEventRows, projectGoalEventForSync } from "@/lib/sync/handlers/goals"
import type { Goal, GoalEvent } from "@/types/goal"
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

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

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
    // newest first — turn_completed has ts=200, should be on top. The kind
    // reads as its translated label, not the raw enum.
    expect(items[0]).toHaveTextContent("Turn completed")
    expect(items[0]).toHaveAttribute("data-kind", "turn_completed")
    expect(items[1]).toHaveTextContent("Turn started")
    expect(screen.queryByText("turn_completed")).toBeNull()
  })

  it("prints the event time relative to now, with the absolute time as a tooltip", async () => {
    await createGoal(goal)
    await appendGoalEvent({
      goalId: "g1",
      kind: "user_paused",
      payload: { kind: "user_paused" },
      ts: 1_700_000_000_000,
    })
    render(<GoalActivityTab goal={goal} />)
    await waitFor(() => expect(screen.getByTestId("goal-activity-list")).toBeInTheDocument())
    const item = screen.getByRole("listitem")
    const time = item.querySelector("time")
    expect(time).toHaveAttribute("dateTime", new Date(1_700_000_000_000).toISOString())
    // The jest next-intl formatter renders relativeTime / dateTime as ISO.
    expect(time).toHaveTextContent(new Date(1_700_000_000_000).toISOString())
    expect(time).toHaveAttribute("title", new Date(1_700_000_000_000).toISOString())
    expect(within(item).getByText("Paused")).toBeInTheDocument()
  })

  it("on a paired phone, lists the events the goalEvents sync mirrored", async () => {
    // The phone never runs the loop: these arrive projected from the desktop
    // and are written by the sync handler, not by `appendGoalEvent`.
    const desktopLog: GoalEvent[] = [
      {
        id: "ev-1",
        goalId: "g1",
        kind: "judge_parse_failed",
        ts: 100,
        payload: { kind: "judge_parse_failed", raw: "{garbled", failureCount: 1 },
      },
      {
        id: "ev-2",
        goalId: "g1",
        kind: "judge_evaluated",
        ts: 200,
        payload: { kind: "judge_evaluated", done: false, reason: "one test left", judgeTokens: 3 },
      },
    ]
    await applyGoalEventRows(desktopLog.map(projectGoalEventForSync))
    render(<GoalActivityTab goal={goal} />)
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2))
    const [newest, oldest] = screen.getAllByRole("listitem")
    expect(newest).toHaveAttribute("data-kind", "judge_evaluated")
    expect(newest).toHaveTextContent("one test left")
    // The emptied raw output was never shown; the failure count still is.
    expect(oldest).toHaveAttribute("data-kind", "judge_parse_failed")
    expect(oldest).not.toHaveTextContent("{garbled")
  })

  it("pages with Show more once there are more events than one page", async () => {
    await createGoal(goal)
    const rows: GoalEvent[] = Array.from({ length: 205 }, (_, i) => ({
      id: `ev-${i}`,
      goalId: "g1",
      kind: "turn_started",
      ts: i + 1,
      payload: { kind: "turn_started", turnNumber: i + 1 },
    }))
    await getDb().chatGoalEvents.bulkPut(rows)
    const user = userEvent.setup()
    render(<GoalActivityTab goal={goal} />)
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(200))
    expect(screen.getByText("Showing 200 of 205")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Show more" }))
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(205))
    expect(screen.queryByTestId("goal-activity-more")).toBeNull()
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
      expect(screen.getByText("Turn budget reached — budget exhausted")).toBeInTheDocument()
    )
    expect(screen.getByText("Goal ended")).toBeInTheDocument()
  })

  // ── ADR-0070 Phase 2 — risk-raised ceremony provenance ──────────────────
  it("names the risk surfaces, localized, when the ceremony was risk-raised", async () => {
    await createGoal(goal)
    await appendGoalEvent({
      goalId: "g1",
      kind: "goal_created",
      payload: {
        kind: "goal_created",
        safeObjective: "x",
        config: goal.config,
        risk: { tier: "high", surfaces: ["computer-use"], reason: "high — computer-use" },
      },
    })
    render(<GoalActivityTab goal={goal} />)
    // The label comes from `policy.risk.surfaces.*`, NOT the classifier's
    // English-only `reason` string.
    await waitFor(() => expect(screen.getByText(/Computer use/)).toBeInTheDocument())
    expect(screen.getByText(/High risk/)).toBeInTheDocument()
  })

  it("omits the risk line entirely for a goal that was never risk-raised", async () => {
    await createGoal(goal)
    await appendGoalEvent({
      goalId: "g1",
      kind: "goal_created",
      payload: { kind: "goal_created", safeObjective: "x", config: goal.config },
    })
    render(<GoalActivityTab goal={goal} />)
    await waitFor(() => expect(screen.getByTestId("goal-activity-list")).toBeInTheDocument())
    expect(screen.queryByText(/approval required/i)).not.toBeInTheDocument()
  })

  it("renders all event kinds with their kind-specific summaries", async () => {
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
      {
        goalId: "g1",
        kind: "verification_requested",
        payload: { kind: "verification_requested", attempt: 1 },
      },
      {
        goalId: "g1",
        kind: "verification_started",
        payload: { kind: "verification_started", attempt: 1, workflowRunId: "workflow-run-1" },
      },
      {
        goalId: "g1",
        kind: "verification_passed",
        payload: { kind: "verification_passed", attempt: 1, summary: "checks passed" },
      },
      {
        goalId: "g1",
        kind: "verification_failed",
        payload: {
          kind: "verification_failed",
          attempt: 2,
          failureCount: 1,
          summary: "missing test",
          paused: false,
        },
      },
      {
        goalId: "g1",
        kind: "verification_error",
        payload: { kind: "verification_error", attempt: 3, error: "deployment unavailable" },
      },
      {
        goalId: "g1",
        kind: "verification_disabled",
        payload: { kind: "verification_disabled" },
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
    expect(screen.getByText("Judge confirmed done — done")).toBeInTheDocument()
    expect(screen.getByText("User paused")).toBeInTheDocument()
    expect(screen.getByText("User resumed")).toBeInTheDocument()
    expect(screen.getByText("User stopped")).toBeInTheDocument()
    expect(screen.getByText("Config updated")).toBeInTheDocument()
    expect(screen.getByText(/Workflow verification requested/)).toBeInTheDocument()
    expect(screen.getByText(/workflow-run-1/)).toBeInTheDocument()
    expect(screen.getByText(/checks passed/)).toBeInTheDocument()
    expect(screen.getByText(/missing test/)).toBeInTheDocument()
    expect(screen.getByText(/deployment unavailable/)).toBeInTheDocument()
    expect(screen.getByText(/verifier disabled/)).toBeInTheDocument()
    // Each row is headed by its translated kind label.
    expect(screen.getByText("Goal created")).toBeInTheDocument()
    expect(screen.getByText("Judge verdict")).toBeInTheDocument()
    expect(screen.getByText("Judge reply unreadable")).toBeInTheDocument()
    expect(screen.getByText("Settings changed")).toBeInTheDocument()
    expect(screen.getByText("Verifier passed")).toBeInTheDocument()
  })

  it("renders the loading state before the live query resolves", () => {
    // No goal row in Dexie yet → useLiveQuery returns undefined first
    render(<GoalActivityTab goal={goal} />)
    expect(screen.getByTestId("goal-activity-loading")).toHaveAttribute("aria-busy", "true")
  })
})
