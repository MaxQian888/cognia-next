import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { useGoalControls, type GoalControls } from "@/hooks/goal/use-goal-controls"

jest.mock("next/navigation", () => ({ useRouter: jest.fn() }))
// The hook owns the transport (local runtime or `goal_delete`) and the toasts;
// its own suite covers both. Here it is the seam the menu calls through.
jest.mock("@/hooks/goal/use-goal-controls", () => ({ useGoalControls: jest.fn() }))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
// The real dialog subscribes to sessions, templates and settings; this suite
// only needs to know it was opened, controlled, with the objective.
jest.mock("./goal-quick-create-dialog", () => ({
  GoalQuickCreateDialog: (props: {
    open?: boolean
    initialObjective?: string
    showTrigger?: boolean
    onOpenChange?: (open: boolean) => void
  }) => (
    <div
      data-testid="quick-create-stub"
      data-open={String(props.open)}
      data-show-trigger={String(props.showTrigger)}
    >
      {props.initialObjective}
      <button type="button" onClick={() => props.onOpenChange?.(false)}>
        close stub
      </button>
    </div>
  ),
}))

import { GoalActionsMenu, type GoalActionsMenuProps } from "./goal-actions-menu"

// next-intl globally mocked against en.json in jest.setup.ts.

const useRouterMock = useRouter as jest.Mock
const useGoalControlsMock = useGoalControls as jest.MockedFunction<typeof useGoalControls>
const deleteGoalMock = jest.fn<Promise<boolean>, []>()
const toastSuccess = toast.success as jest.Mock
const toastError = toast.error as jest.Mock

const push = jest.fn()
let remote = false
let allowed = true

function controls(): GoalControls {
  return {
    remote,
    allowed,
    busy: false,
    canContinue: false,
    pause: jest.fn(),
    resume: jest.fn(),
    stop: jest.fn(),
    continueTurn: jest.fn(),
    accept: jest.fn(),
    deleteGoal: deleteGoalMock,
    updateObjective: jest.fn(),
    updateConfig: jest.fn(),
    disableVerification: jest.fn(),
    retryVerification: jest.fn(),
    generateSubgoals: jest.fn(),
    setSubgoalDone: jest.fn(),
    clearSubgoals: jest.fn(),
  }
}

const goal: GoalActionsMenuProps["goal"] = {
  id: "g1",
  sessionId: "ses_1",
  rawObjective: "ship it for Alice",
  safeObjective: "ship it for [PERSON_1]",
  status: "completed",
  config: { maxTurns: 20, maxTokens: 200_000, maxJudgeFailures: 3, timeoutMs: 1_800_000 },
}

beforeEach(() => {
  remote = false
  allowed = true
  push.mockReset()
  useRouterMock.mockReset().mockReturnValue({ push })
  useGoalControlsMock.mockReset().mockImplementation(() => controls())
  deleteGoalMock.mockReset().mockResolvedValue(true)
  toastSuccess.mockClear()
  toastError.mockClear()
})

async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Goal actions" }))
  return screen.findByRole("menu")
}

describe("GoalActionsMenu", () => {
  it("lists every action on the host", async () => {
    const user = userEvent.setup()
    render(<GoalActionsMenu goal={goal} onOpenDetails={jest.fn()} />)
    const menu = await openMenu(user)
    const items = within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent)
    expect(items).toEqual([
      "Open conversation",
      "Open goal details",
      "Run again",
      "Copy objective",
      "Delete",
    ])
  })

  it("offers Open details only when the opener handles it", async () => {
    const user = userEvent.setup()
    const onOpenDetails = jest.fn()
    const { unmount } = render(<GoalActionsMenu goal={goal} />)
    let menu = await openMenu(user)
    expect(within(menu).queryByRole("menuitem", { name: "Open goal details" })).toBeNull()
    unmount()

    render(<GoalActionsMenu goal={goal} onOpenDetails={onOpenDetails} />)
    menu = await openMenu(user)
    await user.click(within(menu).getByRole("menuitem", { name: "Open goal details" }))
    expect(onOpenDetails).toHaveBeenCalledTimes(1)
  })

  it("opens the goal's conversation", async () => {
    const user = userEvent.setup()
    render(<GoalActionsMenu goal={goal} />)
    const menu = await openMenu(user)
    await user.click(within(menu).getByRole("menuitem", { name: "Open conversation" }))
    expect(push).toHaveBeenCalledWith("/?session=ses_1")
  })

  it("withholds Open conversation when the conversation is gone", async () => {
    const user = userEvent.setup()
    render(<GoalActionsMenu goal={goal} conversationMissing />)
    const menu = await openMenu(user)
    expect(within(menu).queryByRole("menuitem", { name: "Open conversation" })).toBeNull()
    expect(within(menu).getByRole("menuitem", { name: "Copy objective" })).toBeInTheDocument()
  })

  it("offers Run again and Delete on a paired phone holding the grant", async () => {
    remote = true
    const user = userEvent.setup()
    render(<GoalActionsMenu goal={goal} onOpenDetails={jest.fn()} />)
    const menu = await openMenu(user)
    const items = within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent)
    expect(items).toEqual([
      "Open conversation",
      "Open goal details",
      "Run again",
      "Copy objective",
      "Delete",
    ])
  })

  it("deletes from a paired phone through the same verb", async () => {
    remote = true
    const user = userEvent.setup()
    const onDeleted = jest.fn()
    render(<GoalActionsMenu goal={goal} onDeleted={onDeleted} />)
    const menu = await openMenu(user)
    await user.click(within(menu).getByRole("menuitem", { name: "Delete" }))
    const dialog = await screen.findByRole("alertdialog", { name: "Delete goal?" })
    await user.click(within(dialog).getByRole("button", { name: "Delete" }))
    expect(deleteGoalMock).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1))
  })

  it("hides Run again and Delete from a phone without the remote-control grant", async () => {
    remote = true
    allowed = false
    const user = userEvent.setup()
    render(<GoalActionsMenu goal={goal} />)
    const menu = await openMenu(user)
    expect(within(menu).queryByRole("menuitem", { name: "Run again" })).toBeNull()
    expect(within(menu).queryByRole("menuitem", { name: "Delete" })).toBeNull()
    expect(within(menu).getByRole("menuitem", { name: "Copy objective" })).toBeInTheDocument()
  })

  it("copies the redacted objective to the clipboard", async () => {
    const user = userEvent.setup()
    render(<GoalActionsMenu goal={goal} />)
    const menu = await openMenu(user)
    await user.click(within(menu).getByRole("menuitem", { name: "Copy objective" }))
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Objective copied"))
    await expect(navigator.clipboard.readText()).resolves.toBe("ship it for [PERSON_1]")
  })

  it("says so when the clipboard refuses", async () => {
    const user = userEvent.setup()
    const spy = jest
      .spyOn(navigator.clipboard, "writeText")
      .mockRejectedValueOnce(new Error("denied"))
    render(<GoalActionsMenu goal={goal} />)
    const menu = await openMenu(user)
    await user.click(within(menu).getByRole("menuitem", { name: "Copy objective" }))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Couldn't copy the objective"))
    spy.mockRestore()
  })

  it("Run again opens New goal pre-filled with what the user wrote", async () => {
    const user = userEvent.setup()
    render(<GoalActionsMenu goal={goal} />)
    expect(screen.queryByTestId("quick-create-stub")).toBeNull()
    const menu = await openMenu(user)
    await user.click(within(menu).getByRole("menuitem", { name: "Run again" }))
    const stub = await screen.findByTestId("quick-create-stub")
    expect(stub).toHaveTextContent("ship it for Alice")
    expect(stub).toHaveAttribute("data-open", "true")
    expect(stub).toHaveAttribute("data-show-trigger", "false")
    // Unmounted again once it closes.
    await user.click(screen.getByRole("button", { name: "close stub" }))
    expect(screen.queryByTestId("quick-create-stub")).toBeNull()
  })

  it("Run again falls back to the safe objective without a raw one", async () => {
    const user = userEvent.setup()
    render(<GoalActionsMenu goal={{ ...goal, rawObjective: "" }} />)
    const menu = await openMenu(user)
    await user.click(within(menu).getByRole("menuitem", { name: "Run again" }))
    expect(await screen.findByTestId("quick-create-stub")).toHaveTextContent(
      "ship it for [PERSON_1]"
    )
  })

  it("asks before deleting, then deletes through the controls", async () => {
    const user = userEvent.setup()
    const onDeleted = jest.fn()
    render(<GoalActionsMenu goal={goal} onDeleted={onDeleted} />)
    const menu = await openMenu(user)
    await user.click(within(menu).getByRole("menuitem", { name: "Delete" }))
    const dialog = await screen.findByRole("alertdialog", { name: "Delete goal?" })
    expect(within(dialog).getByText("ship it for [PERSON_1]")).toBeInTheDocument()
    expect(deleteGoalMock).not.toHaveBeenCalled()

    await user.click(within(dialog).getByRole("button", { name: "Delete" }))
    expect(deleteGoalMock).toHaveBeenCalledTimes(1)
    expect(useGoalControlsMock).toHaveBeenCalledWith(goal)
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
  })

  it("Cancel keeps the goal", async () => {
    const user = userEvent.setup()
    const onDeleted = jest.fn()
    render(<GoalActionsMenu goal={goal} onDeleted={onDeleted} />)
    const menu = await openMenu(user)
    await user.click(within(menu).getByRole("menuitem", { name: "Delete" }))
    await user.click(await screen.findByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
    expect(deleteGoalMock).not.toHaveBeenCalled()
    expect(onDeleted).not.toHaveBeenCalled()
  })

  it("keeps the dialog open after a failed delete (the controls reported it)", async () => {
    const user = userEvent.setup()
    const onDeleted = jest.fn()
    deleteGoalMock.mockResolvedValueOnce(false)
    render(<GoalActionsMenu goal={goal} onDeleted={onDeleted} />)
    const menu = await openMenu(user)
    await user.click(within(menu).getByRole("menuitem", { name: "Delete" }))
    const dialog = await screen.findByRole("alertdialog")
    await user.click(within(dialog).getByRole("button", { name: "Delete" }))
    await waitFor(() => expect(deleteGoalMock).toHaveBeenCalledTimes(1))
    expect(onDeleted).not.toHaveBeenCalled()
    expect(screen.getByRole("alertdialog")).toBeInTheDocument()
    expect(within(dialog).getByRole("button", { name: "Delete" })).toBeEnabled()
  })

  it("keeps the trigger's click from selecting the row around it", async () => {
    const user = userEvent.setup()
    const onRowClick = jest.fn()
    render(
      <div onClick={onRowClick}>
        <GoalActionsMenu goal={goal} />
      </div>
    )
    await user.click(screen.getByRole("button", { name: "Goal actions" }))
    expect(onRowClick).not.toHaveBeenCalled()
  })
})
