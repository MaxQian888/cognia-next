import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"

import { TooltipProvider } from "@/components/ui/tooltip"
import { useGoalControls, type GoalControls } from "@/hooks/goal/use-goal-controls"
import type { Goal, GoalStatus } from "@/types/goal"

jest.mock("@/hooks/goal/use-goal-controls", () => ({
  useGoalControls: jest.fn(),
}))

import { GoalControlBar } from "./goal-control-bar"

// next-intl globally mocked against en.json in jest.setup.ts.

const useGoalControlsMock = useGoalControls as jest.MockedFunction<typeof useGoalControls>

function makeControls(overrides: Partial<GoalControls> = {}): GoalControls {
  return {
    remote: false,
    allowed: true,
    busy: false,
    canContinue: false,
    pause: jest.fn().mockResolvedValue(true),
    resume: jest.fn().mockResolvedValue(true),
    stop: jest.fn().mockResolvedValue(true),
    continueTurn: jest.fn(),
    updateObjective: jest.fn().mockResolvedValue("updated"),
    updateConfig: jest.fn().mockResolvedValue(true),
    accept: jest.fn().mockResolvedValue(true),
    deleteGoal: jest.fn().mockResolvedValue(true),
    disableVerification: jest.fn().mockResolvedValue(true),
    retryVerification: jest.fn().mockResolvedValue(null),
    generateSubgoals: jest.fn().mockResolvedValue("generated"),
    setSubgoalDone: jest.fn().mockResolvedValue(true),
    clearSubgoals: jest.fn().mockResolvedValue(true),
    ...overrides,
  }
}

function buildGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "g1",
    sessionId: "ses_a",
    rawObjective: "ship feature",
    safeObjective: "ship feature",
    redactionMapEnc: "",
    status: "active",
    turnsUsed: 0,
    tokensUsed: 0,
    judgeFailureCount: 0,
    config: { maxTurns: 20, maxTokens: 200_000, maxJudgeFailures: 3, timeoutMs: 1_800_000 },
    generationId: "gen-1",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function wrapper({ children }: { children: ReactNode }) {
  return <TooltipProvider>{children}</TooltipProvider>
}

let controls: GoalControls

beforeEach(() => {
  controls = makeControls()
  useGoalControlsMock.mockReset().mockImplementation(() => controls)
})

describe("GoalControlBar", () => {
  it.each<GoalStatus>([
    "completed",
    "stopped",
    "budget_limited",
    "turn_limited",
    "timed_out",
    "preempted",
  ])("renders nothing for a %s goal", (status) => {
    const { container } = render(<GoalControlBar goal={buildGoal({ status })} />, { wrapper })
    expect(container).toBeEmptyDOMElement()
  })

  it("renders nothing when this surface may not drive the goal", () => {
    controls = makeControls({ allowed: false })
    const { container } = render(<GoalControlBar goal={buildGoal()} />, { wrapper })
    expect(container).toBeEmptyDOMElement()
  })

  it("passes the goal to useGoalControls", () => {
    const goal = buildGoal()
    render(<GoalControlBar goal={goal} />, { wrapper })
    expect(useGoalControlsMock).toHaveBeenCalledWith(goal)
  })

  it("offers Pause and Stop for an active goal, not Resume", async () => {
    const user = userEvent.setup()
    render(<GoalControlBar goal={buildGoal()} />, { wrapper })
    const group = screen.getByRole("group", { name: "Goal controls" })
    expect(within(group).queryByRole("button", { name: "Resume goal" })).toBeNull()
    await user.click(within(group).getByRole("button", { name: "Pause goal" }))
    expect(controls.pause).toHaveBeenCalledTimes(1)
    expect(within(group).getByRole("button", { name: "Stop goal" })).toBeInTheDocument()
  })

  it("offers Resume for a paused goal, not Pause", async () => {
    const user = userEvent.setup()
    render(<GoalControlBar goal={buildGoal({ status: "paused" })} />, { wrapper })
    expect(screen.queryByRole("button", { name: "Pause goal" })).toBeNull()
    await user.click(screen.getByRole("button", { name: "Resume goal" }))
    expect(controls.resume).toHaveBeenCalledTimes(1)
  })

  it("offers no Resume for a goal waiting on the acceptance verdict", () => {
    render(<GoalControlBar goal={buildGoal({ status: "paused", awaitingAcceptance: true })} />, {
      wrapper,
    })
    expect(screen.queryByRole("button", { name: "Resume goal" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Pause goal" })).toBeNull()
    expect(screen.getByRole("button", { name: "Stop goal" })).toBeInTheDocument()
  })

  it("offers Continue only when the controls say a manual turn is possible", async () => {
    const user = userEvent.setup()
    const { rerender } = render(<GoalControlBar goal={buildGoal()} />, { wrapper })
    expect(screen.queryByRole("button", { name: "Continue goal" })).toBeNull()
    controls = makeControls({ canContinue: true })
    rerender(<GoalControlBar goal={buildGoal()} />)
    await user.click(screen.getByRole("button", { name: "Continue goal" }))
    expect(controls.continueTurn).toHaveBeenCalledTimes(1)
  })

  it("offers Continue on a paired phone too (the verb rides goal_continue)", async () => {
    const user = userEvent.setup()
    controls = makeControls({ remote: true, canContinue: true })
    render(<GoalControlBar goal={buildGoal()} />, { wrapper })
    await user.click(screen.getByRole("button", { name: "Continue goal" }))
    expect(controls.continueTurn).toHaveBeenCalledTimes(1)
  })

  it("asks before stopping, and only stops after confirming", async () => {
    const user = userEvent.setup()
    render(<GoalControlBar goal={buildGoal({ safeObjective: "ship the release" })} />, { wrapper })
    await user.click(screen.getByRole("button", { name: "Stop goal" }))
    const dialog = await screen.findByRole("alertdialog", { name: "Stop this goal?" })
    expect(within(dialog).getByText("ship the release")).toBeInTheDocument()
    expect(controls.stop).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole("button", { name: "Stop goal" }))
    expect(controls.stop).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
  })

  it("does not stop when the confirmation is dismissed", async () => {
    const user = userEvent.setup()
    render(<GoalControlBar goal={buildGoal()} />, { wrapper })
    await user.click(screen.getByRole("button", { name: "Stop goal" }))
    await user.click(await screen.findByRole("button", { name: "Keep running" }))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
    expect(controls.stop).not.toHaveBeenCalled()
  })

  it("disables every button while a verb is in flight", () => {
    controls = makeControls({ busy: true, canContinue: true })
    render(<GoalControlBar goal={buildGoal()} />, { wrapper })
    for (const name of ["Continue goal", "Pause goal", "Stop goal"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled()
    }
  })

  it("keeps clicks from reaching the row or tile around it", async () => {
    const user = userEvent.setup()
    const onRowClick = jest.fn()
    controls = makeControls({ canContinue: true })
    render(
      <div onClick={onRowClick}>
        <GoalControlBar goal={buildGoal()} />
      </div>,
      { wrapper }
    )
    await user.click(screen.getByRole("button", { name: "Pause goal" }))
    await user.click(screen.getByRole("button", { name: "Continue goal" }))
    await user.click(screen.getByRole("button", { name: "Stop goal" }))
    await user.click(await screen.findByRole("button", { name: "Keep running" }))
    expect(onRowClick).not.toHaveBeenCalled()
  })

  it("icon variant: icon-only buttons named by aria-label, with a tooltip", async () => {
    const user = userEvent.setup()
    render(<GoalControlBar goal={buildGoal()} />, { wrapper })
    const pause = screen.getByRole("button", { name: "Pause goal" })
    expect(pause).toHaveAttribute("aria-label", "Pause goal")
    expect(pause).toHaveTextContent(/^$/)
    await user.hover(pause)
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Pause goal")
  })

  it("labelled variant: buttons say what they do", () => {
    render(<GoalControlBar goal={buildGoal()} variant="labelled" />, { wrapper })
    const pause = screen.getByTestId("goal-control-pause")
    expect(pause).toHaveTextContent("Pause goal")
    expect(pause).not.toHaveAttribute("aria-label")
    expect(screen.getByTestId("goal-control-stop")).toHaveTextContent("Stop goal")
  })
})
