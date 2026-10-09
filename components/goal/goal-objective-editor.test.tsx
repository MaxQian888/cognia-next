import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { toast } from "sonner"

import { useGoalControls, type GoalControls } from "@/hooks/goal/use-goal-controls"
import type { GoalStatus } from "@/types/goal"

jest.mock("@/hooks/goal/use-goal-controls", () => ({
  useGoalControls: jest.fn(),
}))
jest.mock("sonner", () => ({
  toast: { success: jest.fn(), info: jest.fn(), error: jest.fn() },
}))

import { GoalObjectiveEditor, type GoalObjectiveEditorProps } from "./goal-objective-editor"

// next-intl globally mocked against en.json in jest.setup.ts.

const useGoalControlsMock = useGoalControls as jest.MockedFunction<typeof useGoalControls>
const toastSuccess = toast.success as jest.Mock
const toastInfo = toast.info as jest.Mock

let updateObjective: jest.Mock<Promise<"updated" | "unchanged" | "failed">, [string]>
let allowed = true

function makeControls(): GoalControls {
  return {
    remote: false,
    allowed,
    busy: false,
    canContinue: false,
    pause: jest.fn(),
    resume: jest.fn(),
    stop: jest.fn(),
    continueTurn: jest.fn(),
    updateObjective,
    updateConfig: jest.fn(),
    accept: jest.fn().mockResolvedValue(true),
    deleteGoal: jest.fn().mockResolvedValue(true),
    disableVerification: jest.fn().mockResolvedValue(true),
    retryVerification: jest.fn().mockResolvedValue(null),
    generateSubgoals: jest.fn().mockResolvedValue("generated"),
    setSubgoalDone: jest.fn().mockResolvedValue(true),
    clearSubgoals: jest.fn().mockResolvedValue(true),
  }
}

function buildGoal(
  overrides: Partial<GoalObjectiveEditorProps["goal"]> = {}
): GoalObjectiveEditorProps["goal"] {
  return {
    id: "g1",
    status: "active",
    config: { maxTurns: 20, maxTokens: 200_000, maxJudgeFailures: 3, timeoutMs: 1_800_000 },
    rawObjective: "ship the feature for Alice",
    safeObjective: "ship the feature for [PERSON_1]",
    ...overrides,
  }
}

beforeEach(() => {
  allowed = true
  updateObjective = jest.fn<Promise<"updated" | "unchanged" | "failed">, [string]>()
  updateObjective.mockResolvedValue("updated")
  useGoalControlsMock.mockReset().mockImplementation(() => makeControls())
  toastSuccess.mockClear()
  toastInfo.mockClear()
})

describe("GoalObjectiveEditor", () => {
  it("shows the redacted objective, with an edit button while the goal can move", () => {
    render(<GoalObjectiveEditor goal={buildGoal()} />)
    expect(screen.getByTestId("goal-objective-text")).toHaveTextContent(
      "ship the feature for [PERSON_1]"
    )
    expect(screen.getByRole("button", { name: "Edit objective" })).toBeInTheDocument()
  })

  it.each<GoalStatus>(["completed", "stopped", "timed_out", "budget_limited"])(
    "is read-only for a %s goal",
    (status) => {
      render(<GoalObjectiveEditor goal={buildGoal({ status })} />)
      expect(screen.getByTestId("goal-objective-text")).toBeInTheDocument()
      expect(screen.queryByRole("button", { name: "Edit objective" })).toBeNull()
    }
  )

  it("is read-only when this surface may not drive the goal", () => {
    allowed = false
    render(<GoalObjectiveEditor goal={buildGoal()} />)
    expect(screen.queryByRole("button", { name: "Edit objective" })).toBeNull()
  })

  it("starts the edit from what the user wrote, not the redacted text", async () => {
    const user = userEvent.setup()
    render(<GoalObjectiveEditor goal={buildGoal()} />)
    await user.click(screen.getByRole("button", { name: "Edit objective" }))
    expect(screen.getByRole("textbox", { name: "Objective" })).toHaveValue(
      "ship the feature for Alice"
    )
  })

  it("falls back to the safe objective when no raw objective is stored", async () => {
    const user = userEvent.setup()
    render(<GoalObjectiveEditor goal={buildGoal({ rawObjective: "" })} />)
    await user.click(screen.getByRole("button", { name: "Edit objective" }))
    expect(screen.getByRole("textbox", { name: "Objective" })).toHaveValue(
      "ship the feature for [PERSON_1]"
    )
  })

  it("disables Save until the text changes, and for whitespace-only edits", async () => {
    const user = userEvent.setup()
    render(<GoalObjectiveEditor goal={buildGoal()} />)
    await user.click(screen.getByRole("button", { name: "Edit objective" }))
    const save = screen.getByRole("button", { name: "Save objective" })
    expect(save).toBeDisabled()
    const input = screen.getByRole("textbox", { name: "Objective" })
    await user.type(input, "   ")
    // Trailing whitespace alone is not a change.
    expect(save).toBeDisabled()
    await user.clear(input)
    await user.type(input, "   ")
    expect(save).toBeDisabled()
  })

  it("saves the trimmed text through controls.updateObjective", async () => {
    const user = userEvent.setup()
    render(<GoalObjectiveEditor goal={buildGoal()} />)
    await user.click(screen.getByRole("button", { name: "Edit objective" }))
    const input = screen.getByRole("textbox", { name: "Objective" })
    await user.clear(input)
    await user.type(input, "  ship v2  ")
    await user.click(screen.getByRole("button", { name: "Save objective" }))
    expect(updateObjective).toHaveBeenCalledWith("ship v2")
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(
        "Objective updated. The agent will see it on its next turn."
      )
    )
    expect(screen.queryByRole("textbox")).toBeNull()
  })

  it("saves with Cmd/Ctrl + Enter", async () => {
    const user = userEvent.setup()
    render(<GoalObjectiveEditor goal={buildGoal()} />)
    await user.click(screen.getByRole("button", { name: "Edit objective" }))
    const input = screen.getByRole("textbox", { name: "Objective" })
    await user.clear(input)
    await user.type(input, "ship v3")
    await user.keyboard("{Control>}{Enter}{/Control}")
    expect(updateObjective).toHaveBeenCalledWith("ship v3")
  })

  it("closes with an explanation when the runtime reports nothing changed", async () => {
    const user = userEvent.setup()
    updateObjective.mockResolvedValueOnce("unchanged")
    render(<GoalObjectiveEditor goal={buildGoal()} />)
    await user.click(screen.getByRole("button", { name: "Edit objective" }))
    await user.type(screen.getByRole("textbox", { name: "Objective" }), " now")
    await user.click(screen.getByRole("button", { name: "Save objective" }))
    await waitFor(() =>
      expect(toastInfo).toHaveBeenCalledWith(
        "Nothing changed — the objective is the same, or the goal has ended."
      )
    )
    expect(screen.queryByRole("textbox")).toBeNull()
  })

  it("keeps the draft for a retry when the save failed", async () => {
    const user = userEvent.setup()
    updateObjective.mockResolvedValueOnce("failed")
    render(<GoalObjectiveEditor goal={buildGoal()} />)
    await user.click(screen.getByRole("button", { name: "Edit objective" }))
    await user.type(screen.getByRole("textbox", { name: "Objective" }), " now")
    await user.click(screen.getByRole("button", { name: "Save objective" }))
    await waitFor(() => expect(screen.getByRole("textbox")).toBeEnabled())
    expect(screen.getByRole("textbox")).toHaveValue("ship the feature for Alice now")
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it("Escape cancels without saving", async () => {
    const user = userEvent.setup()
    render(<GoalObjectiveEditor goal={buildGoal()} />)
    await user.click(screen.getByRole("button", { name: "Edit objective" }))
    await user.type(screen.getByRole("textbox", { name: "Objective" }), " more")
    await user.keyboard("{Escape}")
    expect(screen.queryByRole("textbox")).toBeNull()
    expect(screen.getByTestId("goal-objective-text")).toBeInTheDocument()
    expect(updateObjective).not.toHaveBeenCalled()
  })

  it("Cancel closes the editor without saving", async () => {
    const user = userEvent.setup()
    render(<GoalObjectiveEditor goal={buildGoal()} />)
    await user.click(screen.getByRole("button", { name: "Edit objective" }))
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    expect(screen.queryByRole("textbox")).toBeNull()
    expect(updateObjective).not.toHaveBeenCalled()
  })

  it("closes the editor when the goal ends while it is open", async () => {
    const user = userEvent.setup()
    const { rerender } = render(<GoalObjectiveEditor goal={buildGoal()} />)
    await user.click(screen.getByRole("button", { name: "Edit objective" }))
    expect(screen.getByRole("textbox")).toBeInTheDocument()
    rerender(<GoalObjectiveEditor goal={buildGoal({ status: "completed" })} />)
    expect(screen.queryByRole("textbox")).toBeNull()
    expect(screen.queryByRole("button", { name: "Edit objective" })).toBeNull()
  })

  it("closes the editor when another goal is selected", async () => {
    const user = userEvent.setup()
    const { rerender } = render(<GoalObjectiveEditor goal={buildGoal()} />)
    await user.click(screen.getByRole("button", { name: "Edit objective" }))
    rerender(<GoalObjectiveEditor goal={buildGoal({ id: "g2", safeObjective: "other goal" })} />)
    expect(screen.queryByRole("textbox")).toBeNull()
    expect(screen.getByTestId("goal-objective-text")).toHaveTextContent("other goal")
  })
})
