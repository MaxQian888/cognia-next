import "fake-indexeddb/auto"
import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { useCharacter } from "@/lib/data-hooks/context"
import { appendGoalEvent, updateGoal } from "@/lib/db/goals"
import { getDb } from "@/lib/db/schema"
import { createSession } from "@/lib/db/sessions"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import type { Goal } from "@/types/goal"

jest.mock("@/lib/data-hooks/context", () => ({
  useCharacter: jest.fn(() => undefined),
}))
jest.mock("@/lib/goal/acceptance", () => ({
  resolveGoalAcceptance: jest.fn().mockResolvedValue(undefined),
}))
// Completion linkage fires real notification/workflow side effects.
jest.mock("@/lib/goal/completion-linkage", () => ({
  onGoalTerminal: jest.fn().mockResolvedValue(undefined),
  toGoalHookPayload: (g: unknown) => g,
}))

import { resolveGoalAcceptance } from "@/lib/goal/acceptance"
import { GoalDetailPanel } from "./goal-detail-panel"

const useCharacterMock = useCharacter as jest.Mock
const resolveGoalAcceptanceMock = resolveGoalAcceptance as jest.Mock

function buildGoal(overrides: Partial<Goal> = {}): Goal {
  const now = Date.now()
  return {
    id: "g1",
    sessionId: "ses_missing",
    rawObjective: "ship feature",
    safeObjective: "ship feature",
    redactionMapEnc: "",
    status: "active",
    turnsUsed: 2,
    tokensUsed: 1_000,
    judgeFailureCount: 0,
    config: { maxTurns: 20, maxTokens: 200_000, maxJudgeFailures: 3, timeoutMs: 30 * 60_000 },
    generationId: "gen-1",
    createdAt: now - 5 * 60_000,
    updatedAt: now,
    ...overrides,
  }
}

/** Write the row as given — `createGoal` would restamp `createdAt`. */
async function seed(goal: Goal): Promise<void> {
  await getDb().chatGoals.put(goal)
}

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  useCharacterMock.mockReset().mockReturnValue(undefined)
  resolveGoalAcceptanceMock.mockClear()
})
afterAll(dbFixture.dispose)

describe("GoalDetailPanel", () => {
  it("shows a loading skeleton until the live read lands when no initial row is given", () => {
    render(<GoalDetailPanel goalId="g1" />)
    expect(screen.getByTestId("goal-detail-loading")).toHaveAttribute("aria-busy", "true")
  })

  it("paints initialGoal before the live read lands", () => {
    render(
      <GoalDetailPanel goalId="g1" initialGoal={buildGoal({ safeObjective: "from opener" })} />
    )
    expect(screen.getByTestId("goal-detail-panel")).toBeInTheDocument()
    expect(screen.getByText("from opener")).toBeInTheDocument()
  })

  it("says the goal is missing once the read finds nothing", async () => {
    const onClose = jest.fn()
    const user = userEvent.setup()
    render(<GoalDetailPanel goalId="nope" onClose={onClose} />)
    expect(await screen.findByTestId("goal-detail-missing")).toBeInTheDocument()
    expect(screen.getByText("Goal not found")).toBeInTheDocument()
    expect(
      screen.getByText("It was deleted, or it belongs to another workspace.")
    ).toBeInTheDocument()
    // The missing state has no header, so the frame draws the close button.
    await user.click(screen.getByRole("button", { name: "Close details" }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("reads the goal live by id, replacing the opener's stale snapshot", async () => {
    await seed(buildGoal({ safeObjective: "stored objective" }))
    render(
      <GoalDetailPanel goalId="g1" initialGoal={buildGoal({ safeObjective: "stale snapshot" })} />
    )
    expect(await screen.findByText("stored objective")).toBeInTheDocument()
    expect(screen.queryByText("stale snapshot")).toBeNull()
    expect(screen.getByTestId("goal-status-chip")).toHaveAttribute("data-status", "active")

    await act(async () => {
      await updateGoal("g1", { status: "paused" })
    })
    await waitFor(() =>
      expect(screen.getByTestId("goal-status-chip")).toHaveAttribute("data-status", "paused")
    )
  })

  it("lists the facts: conversation, agent, started and running time", async () => {
    const session = await createSession({ title: "Refactor auth" })
    useCharacterMock.mockReturnValue({ id: "c1", name: "Goal Tracker" })
    await seed(buildGoal({ sessionId: session.id, characterId: "c1" }))
    render(<GoalDetailPanel goalId="g1" />)
    const facts = await screen.findByTestId("goal-detail-facts")
    await waitFor(() =>
      expect(
        within(facts).getByRole("link", { name: "Open conversation “Refactor auth”" })
      ).toHaveAttribute("href", `/?session=${session.id}`)
    )
    expect(useCharacterMock).toHaveBeenCalledWith("c1")
    expect(within(facts).getByText("Goal Tracker")).toBeInTheDocument()
    expect(within(facts).getByText("Started")).toBeInTheDocument()
    expect(within(facts).getByText("Running for")).toBeInTheDocument()
    expect(within(facts).getByText("5 min")).toBeInTheDocument()
    expect(within(facts).queryByText("Ended")).toBeNull()
    // A live conversation also gets the labelled open button beside the controls.
    expect(screen.getByTestId("goal-detail-open-conversation")).toHaveAttribute(
      "href",
      `/?session=${session.id}`
    )
  })

  it("falls back to the default agent, and marks a deleted conversation", async () => {
    await seed(buildGoal({ sessionId: "ses_gone" }))
    render(<GoalDetailPanel goalId="g1" />)
    const facts = await screen.findByTestId("goal-detail-facts")
    expect(within(facts).getByText("Default agent")).toBeInTheDocument()
    await waitFor(() =>
      expect(within(facts).getByTestId("goal-conversation-missing")).toHaveTextContent(
        "Conversation deleted"
      )
    )
    expect(screen.queryByTestId("goal-detail-open-conversation")).toBeNull()
  })

  it("shows when a finished goal ended and how long it ran", async () => {
    const createdAt = Date.now() - 3 * 60 * 60_000
    await seed(buildGoal({ status: "completed", createdAt, endedAt: createdAt + 2 * 60 * 60_000 }))
    render(<GoalDetailPanel goalId="g1" />)
    const facts = await screen.findByTestId("goal-detail-facts")
    expect(within(facts).getByText("Ended")).toBeInTheDocument()
    expect(within(facts).getByText(/ran 2 hr/)).toBeInTheDocument()
    expect(within(facts).queryByText("Running for")).toBeNull()
    // A finished goal has no run controls.
    expect(screen.queryByRole("group", { name: "Goal controls" })).toBeNull()
  })

  it("draws the run controls for an open goal", async () => {
    await seed(buildGoal())
    render(<GoalDetailPanel goalId="g1" />)
    const controls = await screen.findByRole("group", { name: "Goal controls" })
    expect(within(controls).getByRole("button", { name: "Pause goal" })).toBeInTheDocument()
    expect(within(controls).getByRole("button", { name: "Stop goal" })).toBeInTheDocument()
  })

  it("shows the acceptance banner only while the gate holds the goal", async () => {
    const user = userEvent.setup()
    await seed(buildGoal({ status: "paused", awaitingAcceptance: true }))
    render(<GoalDetailPanel goalId="g1" />)
    const banner = await screen.findByTestId("goal-acceptance-banner")
    expect(banner).toHaveTextContent("Awaiting your acceptance")
    expect(screen.getByTestId("goal-status-chip")).toHaveTextContent("awaiting acceptance")
    await user.click(within(banner).getByRole("button", { name: "Accept" }))
    await waitFor(() => expect(resolveGoalAcceptanceMock).toHaveBeenCalledWith("g1", true))

    await act(async () => {
      await updateGoal("g1", { awaitingAcceptance: false })
    })
    await waitFor(() => expect(screen.queryByTestId("goal-acceptance-banner")).toBeNull())
  })

  it("does not show the acceptance banner for a plain paused goal", async () => {
    await seed(buildGoal({ status: "paused" }))
    render(<GoalDetailPanel goalId="g1" />)
    await screen.findByTestId("goal-detail-panel")
    await waitFor(() =>
      expect(screen.getByTestId("goal-status-chip")).toHaveAttribute("data-status", "paused")
    )
    expect(screen.queryByTestId("goal-acceptance-banner")).toBeNull()
  })

  it("labels the tabs with subgoal progress and the activity count", async () => {
    const user = userEvent.setup()
    await seed(
      buildGoal({
        subgoals: [
          { id: "s1", text: "Plan", done: true, order: 0 },
          { id: "s2", text: "Build", done: false, order: 1 },
        ],
      })
    )
    await appendGoalEvent({ goalId: "g1", kind: "user_paused", payload: { kind: "user_paused" } })
    await appendGoalEvent({ goalId: "g1", kind: "user_resumed", payload: { kind: "user_resumed" } })
    render(<GoalDetailPanel goalId="g1" />)
    const subgoalsTab = await screen.findByRole("tab", { name: /Subgoals/ })
    expect(subgoalsTab).toHaveTextContent("Subgoals1/2")
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /Activity/ })).toHaveTextContent("Activity2")
    )
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("data-state", "active")
    expect(screen.getByRole("tab", { name: "Settings" })).toBeInTheDocument()

    await user.click(subgoalsTab)
    expect(subgoalsTab).toHaveAttribute("data-state", "active")
    expect(await screen.findByTestId("goal-subgoals-tab")).toBeInTheDocument()
  })

  it("omits the counts when there are no subgoals or events", async () => {
    await seed(buildGoal())
    render(<GoalDetailPanel goalId="g1" />)
    expect(await screen.findByRole("tab", { name: "Subgoals" })).toHaveTextContent(/^Subgoals$/)
    expect(screen.getByRole("tab", { name: "Activity" })).toHaveTextContent(/^Activity$/)
  })

  it("draws its close button in the header row only when onClose is given", async () => {
    const user = userEvent.setup()
    await seed(buildGoal())
    const onClose = jest.fn()
    const { rerender } = render(<GoalDetailPanel goalId="g1" onClose={onClose} />)
    await screen.findByTestId("goal-detail-panel")
    const closes = screen.getAllByRole("button", { name: "Close details" })
    expect(closes).toHaveLength(1)
    await user.click(closes[0]!)
    expect(onClose).toHaveBeenCalledTimes(1)

    rerender(<GoalDetailPanel goalId="g1" />)
    expect(screen.queryByRole("button", { name: "Close details" })).toBeNull()
  })

  it("is a labelled region with the shared actions menu", async () => {
    await seed(buildGoal())
    render(<GoalDetailPanel goalId="g1" />)
    await screen.findByTestId("goal-detail-panel")
    const region = screen.getByRole("region", { name: "Goal details" })
    expect(within(region).getByRole("button", { name: "Goal actions" })).toBeInTheDocument()
  })
})
