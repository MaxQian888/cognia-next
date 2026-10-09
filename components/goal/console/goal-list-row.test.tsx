import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ChatSession } from "@cognia/agent-config-types"

import { TooltipProvider } from "@/components/ui/tooltip"
import { GOAL_NOW, makeGoal } from "@/lib/storybook/fixtures/goal"
import type { Goal } from "@/types/goal"

// next-intl is globally mocked in jest.setup.ts (resolves keys against en.json).

// The row drives the local goal runtime (desktop platform in jsdom); stub the
// verbs so each control's effect is observable without a Dexie round-trip.
jest.mock("@/lib/goal/runtime", () => ({
  getGoalRuntime: jest.fn(),
}))
jest.mock("@/lib/goal/acceptance", () => ({
  resolveGoalAcceptance: jest.fn().mockResolvedValue(undefined),
}))

import { getGoalRuntime } from "@/lib/goal/runtime"
import { resolveGoalAcceptance } from "@/lib/goal/acceptance"
import { GoalListRow, type GoalListRowProps } from "./goal-list-row"

const runtime = {
  pauseGoal: jest.fn().mockResolvedValue(undefined),
  resumeGoal: jest.fn().mockResolvedValue(undefined),
  stopGoal: jest.fn().mockResolvedValue(undefined),
  requestManualContinue: jest.fn(),
  deleteGoal: jest.fn().mockResolvedValue(undefined),
}
const resolveAcceptanceMock = resolveGoalAcceptance as jest.Mock

const SESSION = { id: "ses_a", title: "Fix flaky checkout e2e test" } as ChatSession

function renderRow(goal: Goal, over: Partial<GoalListRowProps> = {}) {
  const props: GoalListRowProps = {
    goal,
    session: SESSION,
    agentName: "Coding Assistant",
    judgeNote: null,
    selected: false,
    onSelect: jest.fn(),
    onDeleted: jest.fn(),
    now: GOAL_NOW,
    ...over,
  }
  // `TooltipProvider` is mounted once in `app/layout.tsx`.
  render(
    <TooltipProvider>
      <ul>
        <GoalListRow {...props} />
      </ul>
    </TooltipProvider>
  )
  return props
}

beforeEach(() => {
  jest.clearAllMocks()
  ;(getGoalRuntime as jest.Mock).mockReturnValue(runtime)
})

describe("GoalListRow", () => {
  it("renders the objective, status chip, conversation, agent and budgets", () => {
    renderRow(
      makeGoal({
        subgoals: [
          { id: "s1", text: "a", done: true, order: 0 },
          { id: "s2", text: "b", done: false, order: 1 },
        ],
      })
    )
    const row = screen.getByTestId("goal-list-row")
    expect(row).toHaveAttribute("data-goal-id", "goal_1")
    expect(within(row).getByTestId("goal-list-row-select")).toHaveTextContent(
      "Triage the open bug backlog and draft fixes for the top 3"
    )
    expect(within(row).getByTestId("goal-status-chip")).toHaveTextContent("active")
    expect(within(row).getByTestId("goal-conversation-link")).toHaveTextContent(
      "Fix flaky checkout e2e test"
    )
    expect(within(row).getByText("Coding Assistant")).toBeInTheDocument()
    expect(within(row).getByText("Subgoals 1/2")).toBeInTheDocument()
    // Budgets as meters (wide container) and as inline text (narrow).
    expect(within(row).getByRole("group", { name: "Turns 7/20" })).toBeInTheDocument()
    expect(within(row).getByText(/7\/20 turns ·/)).toBeInTheDocument()
  })

  it("selects the goal when the row's select button is clicked", async () => {
    const user = userEvent.setup()
    const props = renderRow(makeGoal())
    await user.click(screen.getByTestId("goal-list-row-select"))
    expect(props.onSelect).toHaveBeenCalledWith("goal_1")
  })

  it("marks the selected row and its select button", () => {
    renderRow(makeGoal(), { selected: true })
    expect(screen.getByTestId("goal-list-row")).toHaveAttribute("data-selected", "true")
    expect(screen.getByTestId("goal-list-row-select")).toHaveAttribute("aria-current", "true")
  })

  it("leaves an unselected row unmarked", () => {
    renderRow(makeGoal())
    expect(screen.getByTestId("goal-list-row")).not.toHaveAttribute("data-selected")
    expect(screen.getByTestId("goal-list-row-select")).not.toHaveAttribute("aria-current")
  })

  it("quotes the latest judge note when one is given", () => {
    renderRow(makeGoal(), { judgeNote: "needs a retry" })
    expect(screen.getByText("“needs a retry”")).toBeInTheDocument()
  })

  it("says the conversation is gone when the session is known missing", () => {
    renderRow(makeGoal(), { session: null })
    expect(screen.getByTestId("goal-conversation-missing")).toBeInTheDocument()
    expect(screen.queryByTestId("goal-conversation-link")).not.toBeInTheDocument()
  })

  it("pauses an active goal without selecting the row", async () => {
    const user = userEvent.setup()
    const props = renderRow(makeGoal())
    expect(screen.queryByTestId("goal-control-resume")).not.toBeInTheDocument()
    await user.click(screen.getByTestId("goal-control-pause"))
    await waitFor(() => expect(runtime.pauseGoal).toHaveBeenCalledWith("goal_1"))
    expect(props.onSelect).not.toHaveBeenCalled()
  })

  it("resumes a paused goal", async () => {
    const user = userEvent.setup()
    renderRow(makeGoal({ status: "paused" }))
    expect(screen.queryByTestId("goal-control-pause")).not.toBeInTheDocument()
    await user.click(screen.getByTestId("goal-control-resume"))
    await waitFor(() => expect(runtime.resumeGoal).toHaveBeenCalledWith("goal_1"))
  })

  it("asks before stopping, and stops only on confirm", async () => {
    const user = userEvent.setup()
    renderRow(makeGoal())
    await user.click(screen.getByTestId("goal-control-stop"))
    expect(await screen.findByTestId("goal-stop-confirm")).toBeInTheDocument()
    expect(runtime.stopGoal).not.toHaveBeenCalled()
    await user.click(screen.getByTestId("goal-stop-confirm-action"))
    await waitFor(() => expect(runtime.stopGoal).toHaveBeenCalledWith("goal_1"))
  })

  it("offers Continue only for a manual-continue goal", async () => {
    const user = userEvent.setup()
    const goal = makeGoal()
    renderRow(makeGoal({ config: { ...goal.config, manualContinue: true } }))
    await user.click(screen.getByTestId("goal-control-continue"))
    expect(runtime.requestManualContinue).toHaveBeenCalledWith("goal_1")
  })

  it("carries Accept / Request changes instead of run controls while awaiting acceptance", async () => {
    const user = userEvent.setup()
    const props = renderRow(makeGoal({ status: "paused", awaitingAcceptance: true }))
    expect(screen.getByTestId("goal-status-chip")).toHaveTextContent("awaiting acceptance")
    expect(screen.queryByTestId("goal-control-resume")).not.toBeInTheDocument()
    expect(screen.queryByTestId("goal-control-stop")).not.toBeInTheDocument()
    await user.click(screen.getByTestId("goal-acceptance-accept"))
    await waitFor(() => expect(resolveAcceptanceMock).toHaveBeenCalledWith("goal_1", true))
    expect(props.onSelect).not.toHaveBeenCalled()
  })

  it("opens details and reports a delete through the ⋯ menu", async () => {
    const user = userEvent.setup()
    const props = renderRow(makeGoal())
    await user.click(screen.getByTestId("goal-actions-goal_1"))
    await user.click(await screen.findByTestId("goal-action-details"))
    expect(props.onSelect).toHaveBeenCalledWith("goal_1")

    await user.click(screen.getByTestId("goal-actions-goal_1"))
    await user.click(await screen.findByTestId("goal-action-delete"))
    await user.click(await screen.findByTestId("goal-delete-confirm"))
    await waitFor(() => expect(props.onDeleted).toHaveBeenCalledWith("goal_1"))
    expect(runtime.deleteGoal).toHaveBeenCalledWith("goal_1")
  })
})
