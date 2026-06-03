import { fireEvent, render, screen } from "@testing-library/react"
import { BranchHeader } from "./branch-header"
import type { GitBranch } from "@/types/git"

const branches: GitBranch[] = [
  { name: "main", isCurrent: true, isRemote: false, upstream: null, ahead: 0, behind: 0 },
]
const actions = {
  checkout: jest.fn(),
  createBranch: jest.fn(),
  deleteBranch: jest.fn(),
  renameBranch: jest.fn(),
  rebase: jest.fn(),
}

describe("BranchHeader", () => {
  it("shows the branch name and ahead/behind counts", () => {
    render(
      <BranchHeader branch="main" ahead={2} behind={3} branches={branches} actions={actions} />
    )
    expect(screen.getByText("main")).toBeInTheDocument()
    expect(screen.getByText("2")).toBeInTheDocument()
    expect(screen.getByText("3")).toBeInTheDocument()
  })

  it("falls back to the detached label when no branch", () => {
    render(
      <BranchHeader branch={null} ahead={0} behind={0} branches={branches} actions={actions} />
    )
    expect(screen.getByTestId("branch-header")).toBeInTheDocument()
  })

  it("opens the branch picker on click", () => {
    render(
      <BranchHeader branch="main" ahead={0} behind={0} branches={branches} actions={actions} />
    )
    fireEvent.click(screen.getByTestId("branch-header"))
    expect(screen.getByTestId("branch-picker")).toBeInTheDocument()
  })
})
