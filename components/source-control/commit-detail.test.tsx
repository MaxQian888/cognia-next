jest.mock("@/lib/git/commands", () => ({
  gitCommitFiles: jest.fn(),
  gitDiffCommit: jest.fn(),
}))
jest.mock("./diff-viewer", () => ({
  DiffViewer: ({ diff }: { diff: unknown }) => (
    <div data-testid="diff-viewer-stub" data-has-diff={diff ? "yes" : "no"} />
  ),
}))

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { gitCommitFiles, gitDiffCommit } from "@/lib/git/commands"
import { CommitDetail } from "./commit-detail"
import { useGitStore } from "@/stores/git/git-store"
import type { GitCommit } from "@/types/git"

const filesMock = gitCommitFiles as jest.Mock
const diffMock = gitDiffCommit as jest.Mock

const commit: GitCommit = {
  hash: "abcdef1234567890",
  shortHash: "abcdef1",
  summary: "feat: thing",
  body: "details here",
  authorName: "Tester",
  authorEmail: "t@e.com",
  authoredAtMs: 0,
  parents: [],
}

beforeEach(() => {
  filesMock
    .mockReset()
    .mockResolvedValue([
      { path: "a.ts", origPath: null, status: "modified", staged: false, group: "changes" },
    ])
  diffMock.mockReset().mockResolvedValue({
    path: "a.ts",
    oldContent: "o",
    newContent: "n",
    hunks: [],
    isBinary: false,
  })
  act(() => useGitStore.getState().reset())
})

describe("CommitDetail", () => {
  it("renders commit metadata and the file list", async () => {
    render(<CommitDetail rootDir="/r" commit={commit} />)
    expect(screen.getByText("feat: thing")).toBeInTheDocument()
    expect(screen.getByText("details here")).toBeInTheDocument()
    expect(screen.getByText("abcdef1")).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId("commit-file-a.ts")).toBeInTheDocument())
  })

  it("loads the diff when a file is selected", async () => {
    render(<CommitDetail rootDir="/r" commit={commit} />)
    const file = await screen.findByTestId("commit-file-a.ts")
    await act(async () => {
      fireEvent.click(file)
    })
    await waitFor(() => expect(diffMock).toHaveBeenCalledWith("/r", commit.hash, "a.ts"))
  })

  it("hides the reset control without actions", () => {
    render(<CommitDetail rootDir="/r" commit={commit} />)
    expect(screen.queryByTestId("commit-reset")).not.toBeInTheDocument()
  })

  it("performs a soft reset to the commit", async () => {
    const user = userEvent.setup()
    const reset = jest.fn().mockResolvedValue(undefined)
    render(<CommitDetail rootDir="/r" commit={commit} actions={{ reset }} />)
    await user.click(screen.getByTestId("commit-reset"))
    await user.click(await screen.findByTestId("reset-soft"))
    expect(reset).toHaveBeenCalledWith("soft", commit.hash)
  })

  it("confirms before a hard reset", async () => {
    const user = userEvent.setup()
    const reset = jest.fn().mockResolvedValue(undefined)
    render(<CommitDetail rootDir="/r" commit={commit} actions={{ reset }} />)
    await user.click(screen.getByTestId("commit-reset"))
    await user.click(await screen.findByTestId("reset-hard"))
    // Not reset yet — confirmation dialog is shown.
    expect(reset).not.toHaveBeenCalled()
    await user.click(await screen.findByTestId("reset-hard-confirm-action"))
    expect(reset).toHaveBeenCalledWith("hard", commit.hash)
  })
})
