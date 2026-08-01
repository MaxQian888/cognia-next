import { act, fireEvent, render, screen } from "@testing-library/react"
import { StashPanel } from "./stash-panel"
import type { GitStashEntry } from "@/types/git"

const stashes: GitStashEntry[] = [
  { index: 0, message: "WIP on main: abc tweak", branch: "main" },
  { index: 1, message: "WIP on dev: def fix", branch: "dev" },
]

function makeActions() {
  return {
    stashPush: jest.fn().mockResolvedValue(undefined),
    stashPop: jest.fn().mockResolvedValue(undefined),
    stashApply: jest.fn().mockResolvedValue(undefined),
    stashDrop: jest.fn().mockResolvedValue(undefined),
  }
}

describe("StashPanel", () => {
  it("pushes a stash with message + options", async () => {
    const actions = makeActions()
    render(<StashPanel open onOpenChange={() => {}} stashes={[]} actions={actions} />)
    fireEvent.change(screen.getByTestId("stash-message"), { target: { value: "wip" } })
    fireEvent.click(screen.getByTestId("stash-untracked"))
    await act(async () => {
      fireEvent.click(screen.getByTestId("stash-push"))
    })
    expect(actions.stashPush).toHaveBeenCalledWith({
      message: "wip",
      includeUntracked: true,
      keepIndex: false,
    })
  })

  it("keeps the stash message when the backend rejects the push", async () => {
    const actions = makeActions()
    actions.stashPush.mockResolvedValue({ kind: "commandFailed", detail: "nothing to stash" })
    render(<StashPanel open onOpenChange={() => {}} stashes={[]} actions={actions} />)
    fireEvent.change(screen.getByTestId("stash-message"), { target: { value: "keep this" } })

    await act(async () => {
      fireEvent.click(screen.getByTestId("stash-push"))
    })

    expect(screen.getByTestId("stash-message")).toHaveValue("keep this")
  })

  it("renders stash entries with pop/apply/drop", () => {
    const actions = makeActions()
    render(<StashPanel open onOpenChange={() => {}} stashes={stashes} actions={actions} />)
    fireEvent.click(screen.getByTestId("stash-pop-0"))
    expect(actions.stashPop).toHaveBeenCalledWith(0)
    fireEvent.click(screen.getByTestId("stash-apply-1"))
    expect(actions.stashApply).toHaveBeenCalledWith(1)
    fireEvent.click(screen.getByTestId("stash-drop-0"))
    expect(actions.stashDrop).toHaveBeenCalledWith(0)
  })

  it("shows empty state with no stashes", () => {
    render(<StashPanel open onOpenChange={() => {}} stashes={[]} actions={makeActions()} />)
    expect(screen.getByTestId("stash-panel")).toBeInTheDocument()
  })
})
