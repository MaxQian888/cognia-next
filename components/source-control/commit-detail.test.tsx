jest.mock("@/lib/git/commands", () => ({
  gitCommitFiles: jest.fn(),
  gitDiffCommit: jest.fn(),
}))
let mockSettings: unknown = { gitSettings: {} }
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (sel: (s: unknown) => unknown) => sel({ settings: mockSettings }),
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
  mockSettings = { gitSettings: {} }
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

  it("hides the reset control without actions", async () => {
    render(<CommitDetail rootDir="/r" commit={commit} />)
    expect(screen.queryByTestId("commit-reset")).not.toBeInTheDocument()
    await screen.findByTestId("commit-file-a.ts")
  })

  it("shows the explain button for a selected file when the feature is enabled", async () => {
    mockSettings = { gitSettings: { explainAI: { enabled: true } } }
    diffMock.mockResolvedValue({
      path: "a.ts",
      oldContent: "o",
      newContent: "n",
      hunks: [
        { header: "@@", oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, patch: "P", lines: [] },
      ],
      isBinary: false,
    })
    render(<CommitDetail rootDir="/r" commit={commit} />)
    const file = await screen.findByTestId("commit-file-a.ts")
    await act(async () => {
      fireEvent.click(file)
    })
    expect(await screen.findByTestId("ai-explain-trigger")).toBeInTheDocument()
  })

  it("hides the explain button when the feature is disabled", async () => {
    render(<CommitDetail rootDir="/r" commit={commit} />)
    const file = await screen.findByTestId("commit-file-a.ts")
    await act(async () => {
      fireEvent.click(file)
    })
    expect(screen.queryByTestId("ai-explain-trigger")).not.toBeInTheDocument()
  })

  it("cherry-picks and reverts the commit", async () => {
    const user = userEvent.setup()
    const cherryPick = jest.fn().mockResolvedValue(undefined)
    const revert = jest.fn().mockResolvedValue(undefined)
    const reset = jest.fn().mockResolvedValue(undefined)
    render(<CommitDetail rootDir="/r" commit={commit} actions={{ reset, cherryPick, revert }} />)
    await user.click(screen.getByTestId("commit-reset"))
    await user.click(await screen.findByTestId("commit-cherry-pick"))
    expect(cherryPick).toHaveBeenCalledWith(commit.hash)

    await user.click(screen.getByTestId("commit-reset"))
    await user.click(await screen.findByTestId("commit-revert"))
    expect(revert).toHaveBeenCalledWith(commit.hash)
  })

  it("starts an interactive rebase from the commit", async () => {
    const user = userEvent.setup()
    const onInteractiveRebase = jest.fn()
    render(
      <CommitDetail
        rootDir="/r"
        commit={commit}
        actions={{ reset: jest.fn() }}
        onInteractiveRebase={onInteractiveRebase}
      />
    )
    await user.click(screen.getByTestId("commit-reset"))
    await user.click(await screen.findByTestId("commit-interactive-rebase"))
    expect(onInteractiveRebase).toHaveBeenCalledWith(commit.hash)
  })

  it("opens commit-pinned blame for a file", async () => {
    const onViewBlame = jest.fn()
    render(<CommitDetail rootDir="/r" commit={commit} onViewBlame={onViewBlame} />)
    const blameBtn = await screen.findByTestId("commit-blame-a.ts")
    fireEvent.click(blameBtn)
    expect(onViewBlame).toHaveBeenCalledWith("a.ts", commit.hash)
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

  it("creates a branch from the commit via the dialog", async () => {
    const user = userEvent.setup()
    const createBranch = jest.fn().mockResolvedValue(undefined)
    render(
      <CommitDetail rootDir="/r" commit={commit} actions={{ reset: jest.fn(), createBranch }} />
    )
    await user.click(screen.getByTestId("commit-reset"))
    await user.click(await screen.findByTestId("commit-create-branch"))
    const input = await screen.findByTestId("create-branch-name")
    // Empty name keeps confirm disabled.
    expect(screen.getByTestId("create-branch-confirm")).toBeDisabled()
    await user.type(input, "hotfix/from-commit")
    await user.click(screen.getByTestId("create-branch-confirm"))
    expect(createBranch).toHaveBeenCalledWith("hotfix/from-commit", true, commit.hash)
  })

  it("keeps the branch dialog and name after a failed create", async () => {
    const user = userEvent.setup()
    const createBranch = jest
      .fn()
      .mockResolvedValue({ kind: "commandFailed", detail: "branch exists" })
    render(
      <CommitDetail rootDir="/r" commit={commit} actions={{ reset: jest.fn(), createBranch }} />
    )
    await user.click(screen.getByTestId("commit-reset"))
    await user.click(await screen.findByTestId("commit-create-branch"))
    await user.type(await screen.findByTestId("create-branch-name"), "existing")
    await user.click(screen.getByTestId("create-branch-confirm"))

    expect(screen.getByTestId("create-branch-dialog")).toBeInTheDocument()
    expect(screen.getByTestId("create-branch-name")).toHaveValue("existing")
  })

  it("checks out the commit after the detached-HEAD confirm", async () => {
    const user = userEvent.setup()
    const checkout = jest.fn().mockResolvedValue(undefined)
    render(<CommitDetail rootDir="/r" commit={commit} actions={{ reset: jest.fn(), checkout }} />)
    await user.click(screen.getByTestId("commit-reset"))
    await user.click(await screen.findByTestId("commit-checkout"))
    // Not checked out yet — confirmation dialog is shown.
    expect(checkout).not.toHaveBeenCalled()
    await user.click(await screen.findByTestId("checkout-commit-confirm-action"))
    expect(checkout).toHaveBeenCalledWith(commit.hash)
  })

  it("keeps the checkout confirmation open after a failed checkout", async () => {
    const user = userEvent.setup()
    const checkout = jest
      .fn()
      .mockResolvedValue({ kind: "dirtyWorkingTree", detail: "local changes" })
    render(<CommitDetail rootDir="/r" commit={commit} actions={{ reset: jest.fn(), checkout }} />)
    await user.click(screen.getByTestId("commit-reset"))
    await user.click(await screen.findByTestId("commit-checkout"))
    await user.click(await screen.findByTestId("checkout-commit-confirm-action"))
    expect(screen.getByTestId("checkout-commit-confirm")).toBeInTheDocument()
  })

  it("hides branch/checkout items when those actions are absent", async () => {
    const user = userEvent.setup()
    render(<CommitDetail rootDir="/r" commit={commit} actions={{ reset: jest.fn() }} />)
    await user.click(screen.getByTestId("commit-reset"))
    await screen.findByTestId("reset-soft")
    expect(screen.queryByTestId("commit-create-branch")).not.toBeInTheDocument()
    expect(screen.queryByTestId("commit-checkout")).not.toBeInTheDocument()
  })

  it("keeps the menu mounted while the hard-reset confirm opens (preventDefault)", async () => {
    const user = userEvent.setup()
    render(<CommitDetail rootDir="/r" commit={commit} actions={{ reset: jest.fn() }} />)
    await user.click(screen.getByTestId("commit-reset"))
    await user.click(await screen.findByTestId("reset-hard"))
    // The overlay opened AND the menu item is still mounted — the select was
    // preventDefault'ed so the dialog never races the menu's focus restore.
    expect(await screen.findByTestId("reset-hard-confirm")).toBeInTheDocument()
    expect(screen.getByTestId("reset-hard")).toBeInTheDocument()
  })
})
