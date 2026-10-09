import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ChatSession } from "@cognia/agent-config-types"

import { TooltipProvider } from "@/components/ui/tooltip"
import { GOAL_NOW, makeGoal } from "@/lib/storybook/fixtures/goal"
import type { Goal } from "@/types/goal"

// next-intl is globally mocked in jest.setup.ts (resolves keys against en.json).

jest.mock("@/lib/goal/runtime", () => ({
  getGoalRuntime: jest.fn(),
}))
jest.mock("@/lib/goal/acceptance", () => ({
  resolveGoalAcceptance: jest.fn().mockResolvedValue(undefined),
}))

import { getGoalRuntime } from "@/lib/goal/runtime"
import { resolveGoalAcceptance } from "@/lib/goal/acceptance"
import { GoalGridTile, type GoalGridTileProps } from "./goal-grid-tile"

const runtime = {
  pauseGoal: jest.fn().mockResolvedValue(undefined),
  resumeGoal: jest.fn().mockResolvedValue(undefined),
  stopGoal: jest.fn().mockResolvedValue(undefined),
  requestManualContinue: jest.fn(),
  deleteGoal: jest.fn().mockResolvedValue(undefined),
}

const SESSION = { id: "ses_a", title: "Fix flaky checkout e2e test" } as ChatSession

function renderTile(goal: Goal, over: Partial<GoalGridTileProps> = {}) {
  const props: GoalGridTileProps = {
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
        <GoalGridTile {...props} />
      </ul>
    </TooltipProvider>
  )
  return props
}

beforeEach(() => {
  jest.clearAllMocks()
  ;(getGoalRuntime as jest.Mock).mockReturnValue(runtime)
})

describe("GoalGridTile", () => {
  it("renders status, objective, conversation, agent and both budget meters", () => {
    renderTile(makeGoal())
    const tile = screen.getByTestId("goal-grid-tile")
    expect(tile).toHaveAttribute("data-goal-id", "goal_1")
    expect(within(tile).getByTestId("goal-status-chip")).toHaveTextContent("active")
    expect(within(tile).getByTestId("goal-grid-tile-select")).toHaveTextContent(
      "Triage the open bug backlog and draft fixes for the top 3"
    )
    expect(within(tile).getByTestId("goal-conversation-link")).toHaveTextContent(
      "Fix flaky checkout e2e test"
    )
    expect(within(tile).getByText("Coding Assistant")).toBeInTheDocument()
    expect(within(tile).getByRole("group", { name: "Turns 7/20" })).toBeInTheDocument()
    expect(within(tile).getByRole("group", { name: /^Tokens / })).toBeInTheDocument()
  })

  it("selects the goal from the tile's select button", async () => {
    const user = userEvent.setup()
    const props = renderTile(makeGoal())
    await user.click(screen.getByTestId("goal-grid-tile-select"))
    expect(props.onSelect).toHaveBeenCalledWith("goal_1")
  })

  it("marks a selected tile", () => {
    renderTile(makeGoal(), { selected: true })
    expect(screen.getByTestId("goal-grid-tile")).toHaveAttribute("data-selected", "true")
    expect(screen.getByTestId("goal-grid-tile-select")).toHaveAttribute("aria-current", "true")
  })

  it("shows subgoal progress and the judge note when present", () => {
    renderTile(
      makeGoal({
        subgoals: [
          { id: "s1", text: "a", done: true, order: 0 },
          { id: "s2", text: "b", done: true, order: 1 },
          { id: "s3", text: "c", done: false, order: 2 },
        ],
      }),
      { judgeNote: "two of three drafted" }
    )
    expect(screen.getByText("Subgoals 2/3")).toBeInTheDocument()
    expect(screen.getByText("“two of three drafted”")).toBeInTheDocument()
  })

  it("omits subgoal progress and judge note when there are none", () => {
    renderTile(makeGoal())
    expect(screen.queryByText(/Subgoals/)).not.toBeInTheDocument()
    expect(screen.queryByText(/“/)).not.toBeInTheDocument()
  })

  it("pauses an active goal from the tile", async () => {
    const user = userEvent.setup()
    const props = renderTile(makeGoal())
    await user.click(screen.getByTestId("goal-control-pause"))
    await waitFor(() => expect(runtime.pauseGoal).toHaveBeenCalledWith("goal_1"))
    expect(props.onSelect).not.toHaveBeenCalled()
  })

  it("resumes a paused goal from the tile", async () => {
    const user = userEvent.setup()
    renderTile(makeGoal({ status: "paused" }))
    await user.click(screen.getByTestId("goal-control-resume"))
    await waitFor(() => expect(runtime.resumeGoal).toHaveBeenCalledWith("goal_1"))
  })

  it("confirms before stopping", async () => {
    const user = userEvent.setup()
    renderTile(makeGoal())
    await user.click(screen.getByTestId("goal-control-stop"))
    await user.click(await screen.findByTestId("goal-stop-confirm-action"))
    await waitFor(() => expect(runtime.stopGoal).toHaveBeenCalledWith("goal_1"))
  })

  it("shows the acceptance verdict instead of run controls while awaiting acceptance", async () => {
    const user = userEvent.setup()
    renderTile(makeGoal({ status: "paused", awaitingAcceptance: true }))
    expect(screen.queryByTestId("goal-control-bar-goal_1")).not.toBeInTheDocument()
    await user.click(screen.getByTestId("goal-acceptance-request-changes"))
    await waitFor(() =>
      expect(resolveGoalAcceptance as jest.Mock).toHaveBeenCalledWith("goal_1", false)
    )
  })

  it("reports a delete from the ⋯ menu", async () => {
    const user = userEvent.setup()
    const props = renderTile(makeGoal())
    await user.click(screen.getByTestId("goal-actions-goal_1"))
    await user.click(await screen.findByTestId("goal-action-delete"))
    await user.click(await screen.findByTestId("goal-delete-confirm"))
    await waitFor(() => expect(props.onDeleted).toHaveBeenCalledWith("goal_1"))
  })
})
