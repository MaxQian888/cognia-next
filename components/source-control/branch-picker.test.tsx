import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { BranchPicker } from "./branch-picker"
import type { GitBranch } from "@/types/git"

const branches: GitBranch[] = [
  { name: "main", isCurrent: true, isRemote: false, upstream: "origin/main", ahead: 0, behind: 0 },
  { name: "feature", isCurrent: false, isRemote: false, upstream: null, ahead: 0, behind: 0 },
  { name: "origin/main", isCurrent: false, isRemote: true, upstream: null, ahead: 0, behind: 0 },
]

function makeActions() {
  return {
    checkout: jest.fn().mockResolvedValue(undefined),
    createBranch: jest.fn().mockResolvedValue(undefined),
    deleteBranch: jest.fn().mockResolvedValue(undefined),
    renameBranch: jest.fn().mockResolvedValue(undefined),
    rebase: jest.fn().mockResolvedValue(undefined),
    merge: jest.fn().mockResolvedValue(undefined),
  }
}

describe("BranchPicker", () => {
  it("lists branches and checks out on select", async () => {
    const actions = makeActions()
    const onPicked = jest.fn()
    render(<BranchPicker branches={branches} actions={actions} onPicked={onPicked} />)
    fireEvent.click(screen.getByTestId("branch-item-feature"))
    expect(actions.checkout).toHaveBeenCalledWith("feature")
    await waitFor(() => expect(onPicked).toHaveBeenCalled())
  })

  it("deletes a non-current local branch", () => {
    const actions = makeActions()
    render(<BranchPicker branches={branches} actions={actions} />)
    fireEvent.click(screen.getByTestId("branch-delete-feature"))
    expect(actions.deleteBranch).toHaveBeenCalledWith("feature", false)
  })

  it("does not offer delete for the current branch", () => {
    render(<BranchPicker branches={branches} actions={makeActions()} />)
    expect(screen.queryByTestId("branch-delete-main")).not.toBeInTheDocument()
  })

  it("rebases the current branch onto a chosen branch", () => {
    const actions = makeActions()
    render(<BranchPicker branches={branches} actions={actions} />)
    fireEvent.click(screen.getByTestId("branch-rebase-feature"))
    expect(actions.rebase).toHaveBeenCalledWith("feature")
  })

  it("merges a chosen branch into the current branch", async () => {
    const actions = makeActions()
    const onPicked = jest.fn()
    render(<BranchPicker branches={branches} actions={actions} onPicked={onPicked} />)
    fireEvent.click(screen.getByTestId("branch-merge-feature"))
    expect(actions.merge).toHaveBeenCalledWith("feature")
    expect(actions.checkout).not.toHaveBeenCalled()
    await waitFor(() => expect(onPicked).toHaveBeenCalled())
  })

  it("does not offer merge for the current branch", () => {
    render(<BranchPicker branches={branches} actions={makeActions()} />)
    expect(screen.queryByTestId("branch-merge-main")).not.toBeInTheDocument()
  })

  it("creates a branch from the footer input", async () => {
    const actions = makeActions()
    render(<BranchPicker branches={branches} actions={actions} />)
    fireEvent.change(screen.getByTestId("branch-name-input"), { target: { value: "hotfix" } })
    await act(async () => {
      fireEvent.click(screen.getByTestId("branch-submit"))
    })
    expect(actions.createBranch).toHaveBeenCalledWith("hotfix", true)
  })

  it("renames the current branch in rename mode", async () => {
    const actions = makeActions()
    render(<BranchPicker branches={branches} actions={actions} />)
    fireEvent.click(screen.getByTestId("branch-mode-rename"))
    fireEvent.change(screen.getByTestId("branch-name-input"), { target: { value: "renamed" } })
    await act(async () => {
      fireEvent.click(screen.getByTestId("branch-submit"))
    })
    expect(actions.renameBranch).toHaveBeenCalledWith("renamed")
  })

  it("keeps the picker open and preserves input after a failed branch create", async () => {
    const actions = makeActions()
    actions.createBranch.mockResolvedValue({ kind: "commandFailed", detail: "branch exists" })
    const onPicked = jest.fn()
    render(<BranchPicker branches={branches} actions={actions} onPicked={onPicked} />)
    fireEvent.change(screen.getByTestId("branch-name-input"), { target: { value: "existing" } })
    fireEvent.click(screen.getByTestId("branch-submit"))

    await waitFor(() => expect(actions.createBranch).toHaveBeenCalled())
    expect(onPicked).not.toHaveBeenCalled()
    expect(screen.getByTestId("branch-name-input")).toHaveValue("existing")
  })

  it("does not close the picker after a failed checkout", async () => {
    const actions = makeActions()
    actions.checkout.mockResolvedValue({ kind: "dirtyWorkingTree", detail: "local changes" })
    const onPicked = jest.fn()
    render(<BranchPicker branches={branches} actions={actions} onPicked={onPicked} />)
    fireEvent.click(screen.getByTestId("branch-item-feature"))

    await waitFor(() => expect(actions.checkout).toHaveBeenCalled())
    expect(onPicked).not.toHaveBeenCalled()
  })

  it("disables every branch mutation independently when unavailable", () => {
    const actions = { ...makeActions(), can: jest.fn().mockReturnValue(false) }
    render(<BranchPicker branches={branches} actions={actions} />)

    expect(screen.getByTestId("branch-item-feature")).toHaveAttribute("data-disabled", "true")
    expect(screen.getByTestId("branch-merge-feature")).toBeDisabled()
    expect(screen.getByTestId("branch-rebase-feature")).toBeDisabled()
    expect(screen.getByTestId("branch-delete-feature")).toBeDisabled()
    fireEvent.change(screen.getByTestId("branch-name-input"), { target: { value: "blocked" } })
    expect(screen.getByTestId("branch-submit")).toBeDisabled()
  })
})
