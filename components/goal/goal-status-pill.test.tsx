import "fake-indexeddb/auto"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { __resetRedactionKey } from "@/lib/twin/ingest/redaction-key"
import { __resetGoalRuntimeForTesting, getGoalRuntime } from "@/lib/goal/runtime"
import type { Goal } from "@/types/goal"
import { GoalStatusPill } from "./goal-status-pill"

// next-intl is globally mocked in jest.setup.ts (key-resolving translator backed by
// i18n/messages/en.json). Inline override removed — this suite asserts on goal fixture
// fields (objective, status), not translation strings.

const baseGoal: Goal = {
  id: "g1",
  sessionId: "ses_a",
  rawObjective: "ship feature flag",
  safeObjective: "ship feature flag",
  redactionMapEnc: "",
  status: "active",
  turnsUsed: 3,
  tokensUsed: 12_340,
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
  await __resetRedactionKey()
  __resetGoalRuntimeForTesting()
})

describe("GoalStatusPill", () => {
  it("renders nothing when goalOverride is null", () => {
    const { container } = render(<GoalStatusPill sessionId="ses_a" goalOverride={null} />)
    expect(container.firstChild).toBeNull()
  })

  it("renders objective + status + progress when goal is active", () => {
    render(<GoalStatusPill sessionId="ses_a" goalOverride={baseGoal} />)
    expect(screen.getByText("ship feature flag")).toBeInTheDocument()
    expect(screen.getByText(/3\/20 turns/)).toBeInTheDocument()
    expect(screen.getByText("active")).toBeInTheDocument()
  })

  it("shows Pause button when active, NOT Resume", () => {
    render(<GoalStatusPill sessionId="ses_a" goalOverride={baseGoal} />)
    expect(screen.getByTestId("goal-pause-button")).toBeInTheDocument()
    expect(screen.queryByTestId("goal-resume-button")).not.toBeInTheDocument()
  })

  it("shows Resume button when paused, NOT Pause", () => {
    render(<GoalStatusPill sessionId="ses_a" goalOverride={{ ...baseGoal, status: "paused" }} />)
    expect(screen.getByTestId("goal-resume-button")).toBeInTheDocument()
    expect(screen.queryByTestId("goal-pause-button")).not.toBeInTheDocument()
  })

  it("clicking Pause calls runtime.pauseGoal", async () => {
    await getGoalRuntime().createGoal({ sessionId: "ses_a", rawObjective: "x" })
    const goal = (await getGoalRuntime().getActiveGoalForSession("ses_a"))!
    render(<GoalStatusPill sessionId="ses_a" goalOverride={goal} />)
    fireEvent.click(screen.getByTestId("goal-pause-button"))
    await waitFor(async () => {
      const updated = await getGoalRuntime().getOpenGoalForSession("ses_a")
      expect(updated?.status).toBe("paused")
    })
  })

  it("clicking Stop calls runtime.stopGoal", async () => {
    await getGoalRuntime().createGoal({ sessionId: "ses_a", rawObjective: "x" })
    const goal = (await getGoalRuntime().getActiveGoalForSession("ses_a"))!
    render(<GoalStatusPill sessionId="ses_a" goalOverride={goal} />)
    fireEvent.click(screen.getByTestId("goal-stop-button"))
    await waitFor(async () => {
      const updated = await getGoalRuntime().listGoalsBySession("ses_a")
      expect(updated[0]?.status).toBe("stopped")
    })
  })

  it("clicking the search icon opens the detail sheet", () => {
    render(<GoalStatusPill sessionId="ses_a" goalOverride={baseGoal} />)
    fireEvent.click(screen.getByTestId("goal-show-button"))
    // SheetTitle includes "Goal · active"
    expect(screen.getByText(/Goal · active/)).toBeInTheDocument()
  })
})
