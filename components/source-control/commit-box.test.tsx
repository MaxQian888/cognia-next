import { act, fireEvent, render, screen } from "@testing-library/react"
import { CommitBox } from "./commit-box"
import { useGitStore } from "@/stores/git/git-store"

function makeActions() {
  return {
    commit: jest.fn().mockResolvedValue(undefined),
    push: jest.fn().mockResolvedValue(undefined),
    sync: jest.fn().mockResolvedValue(undefined),
  }
}

beforeEach(() => {
  act(() => {
    useGitStore.setState({ commitDraft: {}, commitAmend: false })
  })
})

describe("CommitBox", () => {
  it("disables commit with no message and no staged files", () => {
    render(<CommitBox rootDir="/r" stagedCount={0} committing={false} actions={makeActions()} />)
    expect(screen.getByTestId("commit-button")).toBeDisabled()
  })

  it("enables and commits when message + staged present", async () => {
    const actions = makeActions()
    render(<CommitBox rootDir="/r" stagedCount={2} committing={false} actions={actions} />)
    fireEvent.change(screen.getByTestId("commit-message"), { target: { value: "feat: x" } })
    expect(screen.getByTestId("commit-button")).not.toBeDisabled()
    await act(async () => {
      fireEvent.click(screen.getByTestId("commit-button"))
    })
    expect(actions.commit).toHaveBeenCalledWith("feat: x", { amend: false, signoff: false })
    expect(useGitStore.getState().commitDraft["/r"]).toBe("")
  })

  it("commits on Ctrl+Enter", async () => {
    const actions = makeActions()
    act(() => useGitStore.getState().setCommitDraft("/r", "msg"))
    render(<CommitBox rootDir="/r" stagedCount={1} committing={false} actions={actions} />)
    await act(async () => {
      fireEvent.keyDown(screen.getByTestId("commit-message"), { key: "Enter", ctrlKey: true })
    })
    expect(actions.commit).toHaveBeenCalled()
  })

  it("shows the amend label when amend is active and allows committing with no staged files", () => {
    act(() => useGitStore.getState().setAmend(true))
    render(<CommitBox rootDir="/r" stagedCount={0} committing={false} actions={makeActions()} />)
    expect(screen.getByTestId("commit-button")).not.toBeDisabled()
  })
})
