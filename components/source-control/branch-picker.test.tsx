import { fireEvent, render, screen } from "@testing-library/react"
import { BranchPicker } from "./branch-picker"
import type { GitBranch } from "@/lib/git/types"

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
  }
}

describe("BranchPicker", () => {
  it("lists branches and checks out on select", () => {
    const actions = makeActions()
    const onPicked = jest.fn()
    render(<BranchPicker branches={branches} actions={actions} onPicked={onPicked} />)
    fireEvent.click(screen.getByTestId("branch-item-feature"))
    expect(actions.checkout).toHaveBeenCalledWith("feature")
    expect(onPicked).toHaveBeenCalled()
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

  it("creates a branch from the footer input", () => {
    const actions = makeActions()
    render(<BranchPicker branches={branches} actions={actions} />)
    fireEvent.change(screen.getByTestId("branch-name-input"), { target: { value: "hotfix" } })
    fireEvent.click(screen.getByTestId("branch-submit"))
    expect(actions.createBranch).toHaveBeenCalledWith("hotfix", true)
  })

  it("renames the current branch in rename mode", () => {
    const actions = makeActions()
    render(<BranchPicker branches={branches} actions={actions} />)
    fireEvent.click(screen.getByTestId("branch-mode-rename"))
    fireEvent.change(screen.getByTestId("branch-name-input"), { target: { value: "renamed" } })
    fireEvent.click(screen.getByTestId("branch-submit"))
    expect(actions.renameBranch).toHaveBeenCalledWith("renamed")
  })
})
