import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { GitWorktree } from "@/types/git"
import { WorktreePanel } from "./worktree-panel"

const gitWorktreeAdd = jest.fn<Promise<void>, [string, string, string, string?]>()
const gitWorktreeList = jest.fn<Promise<GitWorktree[]>, [string]>()
const gitWorktreePrune = jest.fn<Promise<void>, [string]>()
const gitWorktreeRemove = jest.fn<Promise<void>, [string, string, boolean, string?]>()
const pickDirectory = jest.fn<Promise<string | null>, []>()
const openPathAsWorkspace = jest.fn()
const toastError = jest.fn()
const toastSuccess = jest.fn()

jest.mock("@/lib/git/commands", () => ({
  gitWorktreeAdd: (...args: [string, string, string, string?]) => gitWorktreeAdd(...args),
  gitWorktreeList: (...args: [string]) => gitWorktreeList(...args),
  gitWorktreePrune: (...args: [string]) => gitWorktreePrune(...args),
  gitWorktreeRemove: (...args: [string, string, boolean, string?]) => gitWorktreeRemove(...args),
}))
jest.mock("@/lib/files/file-bridge", () => ({
  pickDirectory: () => pickDirectory(),
}))
jest.mock("@/lib/workspace/open-folder", () => ({
  openPathAsWorkspace: (path: string) => openPathAsWorkspace(path),
}))
jest.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: (...args: unknown[]) => toastSuccess(...args),
  },
}))

const worktrees: GitWorktree[] = [
  { path: "/repo", branch: "main", head: "1111111", isMain: true },
  { path: "/work/feature-a", branch: "feature/a", head: "2222222", isMain: false },
]

beforeEach(() => {
  jest.clearAllMocks()
  gitWorktreeAdd.mockResolvedValue(undefined)
  gitWorktreeList.mockResolvedValue(worktrees)
  gitWorktreePrune.mockResolvedValue(undefined)
  gitWorktreeRemove.mockResolvedValue(undefined)
  pickDirectory.mockResolvedValue("/work/feature-b")
})

describe("WorktreePanel", () => {
  it("loads worktrees on open and protects the main worktree", async () => {
    render(<WorktreePanel open rootDir="/repo" onOpenChange={() => {}} />)

    await waitFor(() => expect(gitWorktreeList).toHaveBeenCalledWith("/repo"))
    expect(await screen.findByTestId("worktree-entry-/repo")).toBeInTheDocument()
    expect(screen.getByTestId("worktree-entry-/work/feature-a")).toBeInTheDocument()
    expect(screen.queryByTestId("worktree-remove-/repo")).not.toBeInTheDocument()
    expect(screen.getByTestId("worktree-remove-/work/feature-a")).toBeInTheDocument()
  })

  it("opens a linked worktree as a workspace", async () => {
    const user = userEvent.setup()
    render(<WorktreePanel open rootDir="/repo" onOpenChange={() => {}} />)

    await user.click(await screen.findByTestId("worktree-open-/work/feature-a"))
    expect(openPathAsWorkspace).toHaveBeenCalledWith("/work/feature-a")
  })

  it("creates a worktree in a picked directory and reloads the list", async () => {
    const user = userEvent.setup()
    render(<WorktreePanel open rootDir="/repo" onOpenChange={() => {}} />)

    await waitFor(() => expect(gitWorktreeList).toHaveBeenCalledTimes(1))
    fireEvent.change(screen.getByTestId("worktree-branch"), {
      target: { value: "feature/b" },
    })
    fireEvent.change(screen.getByTestId("worktree-base-ref"), {
      target: { value: "origin/main" },
    })
    await user.click(screen.getByTestId("worktree-pick-directory"))
    await waitFor(() => expect(screen.getByTestId("worktree-path")).toHaveValue("/work/feature-b"))

    await user.click(screen.getByTestId("worktree-create"))

    await waitFor(() =>
      expect(gitWorktreeAdd).toHaveBeenCalledWith(
        "/repo",
        "/work/feature-b",
        "feature/b",
        "origin/main"
      )
    )
    await waitFor(() => expect(gitWorktreeList).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByTestId("worktree-branch")).toHaveValue(""))
    expect(screen.getByTestId("worktree-path")).toHaveValue("")
  })

  it("keeps create inputs and reports a typed mutation failure", async () => {
    gitWorktreeAdd.mockRejectedValueOnce({ kind: "commandFailed", detail: "branch exists" })
    const user = userEvent.setup()
    render(<WorktreePanel open rootDir="/repo" onOpenChange={() => {}} />)

    await waitFor(() => expect(gitWorktreeList).toHaveBeenCalledTimes(1))
    fireEvent.change(screen.getByTestId("worktree-branch"), {
      target: { value: "feature/existing" },
    })
    await user.click(screen.getByTestId("worktree-pick-directory"))
    await waitFor(() => expect(screen.getByTestId("worktree-create")).toBeEnabled())
    await user.click(screen.getByTestId("worktree-create"))

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Worktree operation failed: branch exists")
    )
    expect(screen.getByTestId("worktree-branch")).toHaveValue("feature/existing")
    expect(screen.getByTestId("worktree-path")).toHaveValue("/work/feature-b")
    expect(gitWorktreeList).toHaveBeenCalledTimes(1)
  })

  it("leaves the target path empty when directory picking is cancelled", async () => {
    pickDirectory.mockResolvedValueOnce(null)
    const user = userEvent.setup()
    render(<WorktreePanel open rootDir="/repo" onOpenChange={() => {}} />)

    await user.click(screen.getByTestId("worktree-pick-directory"))
    expect(screen.getByTestId("worktree-path")).toHaveValue("")
    expect(screen.getByTestId("worktree-create")).toBeDisabled()
  })

  it("reports directory picker failures", async () => {
    pickDirectory.mockRejectedValueOnce(new Error("dialog unavailable"))
    const user = userEvent.setup()
    render(<WorktreePanel open rootDir="/repo" onOpenChange={() => {}} />)

    await user.click(screen.getByTestId("worktree-pick-directory"))

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Worktree operation failed: dialog unavailable")
    )
    expect(screen.getByTestId("worktree-path")).toHaveValue("")
  })

  it("removes a linked worktree only after confirmation", async () => {
    const user = userEvent.setup()
    render(<WorktreePanel open rootDir="/repo" onOpenChange={() => {}} />)

    await user.click(await screen.findByTestId("worktree-remove-/work/feature-a"))
    expect(gitWorktreeRemove).not.toHaveBeenCalled()
    await user.click(screen.getByTestId("worktree-remove-confirm"))

    await waitFor(() =>
      expect(gitWorktreeRemove).toHaveBeenCalledWith("/repo", "/work/feature-a", false, undefined)
    )
    await waitFor(() => expect(gitWorktreeList).toHaveBeenCalledTimes(2))
  })

  it("supports forced removal with branch deletion", async () => {
    const user = userEvent.setup()
    render(<WorktreePanel open rootDir="/repo" onOpenChange={() => {}} />)

    await user.click(await screen.findByTestId("worktree-remove-/work/feature-a"))
    await user.click(screen.getByTestId("worktree-remove-force"))
    await user.click(screen.getByTestId("worktree-delete-branch"))
    await user.click(screen.getByTestId("worktree-remove-confirm"))

    await waitFor(() =>
      expect(gitWorktreeRemove).toHaveBeenCalledWith("/repo", "/work/feature-a", true, "feature/a")
    )
  })

  it("keeps the confirmation open when removal fails", async () => {
    gitWorktreeRemove.mockRejectedValueOnce("remove failed")
    const user = userEvent.setup()
    render(<WorktreePanel open rootDir="/repo" onOpenChange={() => {}} />)

    await user.click(await screen.findByTestId("worktree-remove-/work/feature-a"))
    await user.click(screen.getByTestId("worktree-remove-confirm"))

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Worktree operation failed: remove failed")
    )
    expect(screen.getByTestId("worktree-remove-dialog")).toBeInTheDocument()
  })

  it("prunes stale worktree records and reloads", async () => {
    const user = userEvent.setup()
    render(<WorktreePanel open rootDir="/repo" onOpenChange={() => {}} />)

    await waitFor(() => expect(gitWorktreeList).toHaveBeenCalledTimes(1))
    await user.click(screen.getByTestId("worktree-prune"))

    await waitFor(() => expect(gitWorktreePrune).toHaveBeenCalledWith("/repo"))
    await waitFor(() => expect(gitWorktreeList).toHaveBeenCalledTimes(2))
  })

  it("does not load while closed", () => {
    render(<WorktreePanel open={false} rootDir="/repo" onOpenChange={() => {}} />)
    expect(gitWorktreeList).not.toHaveBeenCalled()
  })

  it("reports initial load errors and leaves an empty state", async () => {
    gitWorktreeList.mockRejectedValueOnce(new Error("offline"))
    render(<WorktreePanel open rootDir="/repo" onOpenChange={() => {}} />)

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Worktree operation failed: offline")
    )
    expect(screen.getByText("No worktrees found")).toBeInTheDocument()
  })

  it("falls back to a typed error kind when no detail is provided", async () => {
    gitWorktreeList.mockRejectedValueOnce({ kind: "networkFailed" })
    render(<WorktreePanel open rootDir="/repo" onOpenChange={() => {}} />)

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Worktree operation failed: networkFailed")
    )
  })

  it("ignores a pending load after the panel closes", async () => {
    let resolveLoad: (value: GitWorktree[]) => void = () => {}
    gitWorktreeList.mockReturnValueOnce(
      new Promise<GitWorktree[]>((resolve) => {
        resolveLoad = resolve
      })
    )
    const { rerender } = render(<WorktreePanel open rootDir="/repo" onOpenChange={() => {}} />)

    rerender(<WorktreePanel open={false} rootDir="/repo" onOpenChange={() => {}} />)
    resolveLoad(worktrees)
    await waitFor(() => expect(gitWorktreeList).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId("worktree-entry-/repo")).not.toBeInTheDocument()
  })

  it("renders a detached worktree and disables branch deletion", async () => {
    gitWorktreeList.mockResolvedValueOnce([
      { path: "/repo", branch: "main", head: "1111111", isMain: true },
      { path: "/work/detached", branch: null, head: null, isMain: false },
    ])
    const user = userEvent.setup()
    render(<WorktreePanel open rootDir="/repo" onOpenChange={() => {}} />)

    expect(await screen.findByText("Detached HEAD")).toBeInTheDocument()
    await user.click(screen.getByTestId("worktree-remove-/work/detached"))
    expect(screen.getByTestId("worktree-delete-branch")).toBeDisabled()
  })
})
