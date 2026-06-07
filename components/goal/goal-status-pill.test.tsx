import "fake-indexeddb/auto"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { __resetRedactionKey } from "@/lib/twin/ingest/redaction-key"
import { __resetGoalRuntimeForTesting, getGoalRuntime } from "@/lib/goal/runtime"
import type { Goal } from "@/types/goal"
import { GoalStatusPill } from "./goal-status-pill"

const useBreakpointMock = jest.fn().mockReturnValue("desktop")
jest.mock("@/hooks/ui/use-breakpoint", () => ({
  useBreakpoint: () => useBreakpointMock(),
}))

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
  useBreakpointMock.mockReset().mockReturnValue("desktop")
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

  it("hides the Continue button unless manualContinue is on", () => {
    render(<GoalStatusPill sessionId="ses_a" goalOverride={baseGoal} />)
    expect(screen.queryByTestId("goal-continue-button")).not.toBeInTheDocument()
  })

  it("shows Continue when manualContinue is on and fires onManualContinue listeners", () => {
    const manualGoal: Goal = { ...baseGoal, config: { ...baseGoal.config, manualContinue: true } }
    const fired = jest.fn()
    const unsub = getGoalRuntime().onManualContinue(manualGoal.id, fired)
    render(<GoalStatusPill sessionId="ses_a" goalOverride={manualGoal} />)
    fireEvent.click(screen.getByTestId("goal-continue-button"))
    expect(fired).toHaveBeenCalledTimes(1)
    unsub()
  })

  it("renders the next-continuation footnote when the pacing gate stamped one", () => {
    const goal: Goal = {
      ...baseGoal,
      nextContinuationAt: Date.UTC(2026, 5, 7, 14, 30),
      nextContinuationSource: "model_suggested",
    }
    render(<GoalStatusPill sessionId="ses_a" goalOverride={goal} />)
    expect(screen.getByTestId("activity-pill-footnote")).toBeInTheDocument()
  })

  it("omits the footnote when no continuation is scheduled or goal is paused", () => {
    render(<GoalStatusPill sessionId="ses_a" goalOverride={baseGoal} />)
    expect(screen.queryByTestId("activity-pill-footnote")).toBeNull()
    render(
      <GoalStatusPill
        sessionId="ses_a"
        goalOverride={{ ...baseGoal, status: "paused", nextContinuationAt: Date.UTC(2026, 5, 7) }}
      />
    )
    expect(screen.queryByTestId("activity-pill-footnote")).toBeNull()
  })

  it("collapses stop/details behind the more menu on mobile, keeping pause inline", async () => {
    useBreakpointMock.mockReturnValue("mobile")
    render(<GoalStatusPill sessionId="ses_a" goalOverride={baseGoal} />)
    expect(screen.getByTestId("goal-pause-button")).toBeInTheDocument()
    expect(screen.queryByTestId("goal-stop-button")).toBeNull()
    await userEvent.click(screen.getByTestId("activity-pill-more"))
    expect(await screen.findByTestId("goal-stop-button")).toBeInTheDocument()
    expect(screen.getByTestId("goal-show-button")).toBeInTheDocument()
  })
})
