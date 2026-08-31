import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { gitTargetFromRemote } from "@/lib/git/target"

import { WorktreePanel } from "./worktree-panel"

const gitWorktreeAdd = jest.fn()
const pickDirectory = jest.fn()
const toastError = jest.fn()
const toastSuccess = jest.fn()
const inventoryRender = jest.fn()

jest.mock("@/lib/git/commands", () => ({
  gitWorktreeAdd: (...args: unknown[]) => gitWorktreeAdd(...args),
  runGitUserAction: (_command: string, operation: () => Promise<unknown>) => operation(),
}))
jest.mock("@/lib/files/file-bridge", () => ({
  pickDirectory: () => pickDirectory(),
}))
// Which shell this is decides whether a directory picker exists at all.
jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => true) }))
const isTauriMock = jest.requireMock("@/lib/tauri").isTauri as jest.Mock
jest.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: (...args: unknown[]) => toastSuccess(...args),
  },
}))
jest.mock("@/components/workspace/workspace-environment-list", () => ({
  WorkspaceEnvironmentList: (props: {
    presentation: string
    rootDir: string
    refreshKey: number
    showPrune: boolean
  }) => {
    inventoryRender(props)
    return (
      <div
        data-testid="canonical-workspace-inventory"
        data-presentation={props.presentation}
        data-root-dir={props.rootDir}
        data-refresh-key={props.refreshKey}
        data-show-prune={String(props.showPrune)}
      />
    )
  },
}))

beforeEach(() => {
  jest.clearAllMocks()
  isTauriMock.mockReturnValue(true)
  gitWorktreeAdd.mockResolvedValue(undefined)
  pickDirectory.mockResolvedValue("/work/feature-b")
})

describe("WorktreePanel", () => {
  it("is a sheet shell around the canonical workspace inventory", () => {
    render(<WorktreePanel open rootDir="/repo" onOpenChange={() => {}} />)

    expect(screen.getByTestId("canonical-workspace-inventory")).toHaveAttribute(
      "data-presentation",
      "sheet"
    )
    expect(screen.getByTestId("canonical-workspace-inventory")).toHaveAttribute(
      "data-root-dir",
      "/repo"
    )
    expect(screen.getByTestId("canonical-workspace-inventory")).toHaveAttribute(
      "data-show-prune",
      "true"
    )
  })

  it("creates a manual worktree and refreshes the shared inventory", async () => {
    const user = userEvent.setup()
    render(<WorktreePanel open rootDir="/repo" onOpenChange={() => {}} />)

    fireEvent.change(screen.getByTestId("worktree-branch"), {
      target: { value: "feature/b" },
    })
    fireEvent.change(screen.getByTestId("worktree-base-ref"), {
      target: { value: "origin/main" },
    })
    await user.click(screen.getByTestId("worktree-pick-directory"))
    await user.click(screen.getByTestId("worktree-create"))

    await waitFor(() =>
      expect(gitWorktreeAdd).toHaveBeenCalledWith(
        "/repo",
        "/work/feature-b",
        "feature/b",
        "origin/main",
        { source: "worktree-panel", ownerType: "user" }
      )
    )
    expect(screen.getByTestId("canonical-workspace-inventory")).toHaveAttribute(
      "data-refresh-key",
      "1"
    )
    expect(screen.getByTestId("worktree-branch")).toHaveValue("")
  })

  it("uses relative destinations and hides host path controls remotely", async () => {
    const user = userEvent.setup()
    const rootDir = gitTargetFromRemote("workspace-a", "repo")
    render(<WorktreePanel open rootDir={rootDir} onOpenChange={() => {}} />)

    await user.type(screen.getByTestId("worktree-branch"), "feature/remote")
    await user.type(screen.getByTestId("worktree-path"), "worktrees/remote")
    await user.click(screen.getByTestId("worktree-create"))

    await waitFor(() =>
      expect(gitWorktreeAdd).toHaveBeenCalledWith(
        rootDir,
        "worktrees/remote",
        "feature/remote",
        undefined,
        { source: "worktree-panel", ownerType: "user" }
      )
    )
    expect(screen.queryByTestId("worktree-pick-directory")).not.toBeInTheDocument()
  })

  it("keeps create inputs and reports typed failures", async () => {
    gitWorktreeAdd.mockRejectedValueOnce({ kind: "commandFailed", detail: "branch exists" })
    const user = userEvent.setup()
    render(<WorktreePanel open rootDir="/repo" onOpenChange={() => {}} />)

    fireEvent.change(screen.getByTestId("worktree-branch"), {
      target: { value: "feature/existing" },
    })
    await user.click(screen.getByTestId("worktree-pick-directory"))
    await user.click(screen.getByTestId("worktree-create"))

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Worktree operation failed: branch exists")
    )
    expect(screen.getByTestId("worktree-branch")).toHaveValue("feature/existing")
    expect(screen.getByTestId("canonical-workspace-inventory")).toHaveAttribute(
      "data-refresh-key",
      "0"
    )
  })

  it("handles cancelled and failed directory picks without changing the target", async () => {
    const user = userEvent.setup()
    pickDirectory.mockResolvedValueOnce(null).mockRejectedValueOnce("dialog unavailable")
    render(<WorktreePanel open rootDir="/repo" onOpenChange={() => {}} />)

    await user.click(screen.getByTestId("worktree-pick-directory"))
    expect(screen.getByTestId("worktree-path")).toHaveValue("")
    await user.click(screen.getByTestId("worktree-pick-directory"))
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Worktree operation failed: dialog unavailable")
    )
  })

  it("uses a typed error kind and honors a denied create capability", async () => {
    gitWorktreeAdd.mockRejectedValueOnce({ kind: "networkFailed" })
    const user = userEvent.setup()
    const { rerender } = render(<WorktreePanel open rootDir="/repo" onOpenChange={() => {}} />)
    await user.type(screen.getByTestId("worktree-branch"), "feature/offline")
    await user.click(screen.getByTestId("worktree-pick-directory"))
    await user.click(screen.getByTestId("worktree-create"))
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Worktree operation failed: networkFailed")
    )

    rerender(<WorktreePanel open rootDir="/repo" onOpenChange={() => {}} canMutate={() => false} />)
    expect(screen.getByTestId("worktree-create")).toBeDisabled()
  })

  it("does not render the inventory while closed", () => {
    render(<WorktreePanel open={false} rootDir="/repo" onOpenChange={() => {}} />)
    expect(screen.queryByTestId("canonical-workspace-inventory")).not.toBeInTheDocument()
  })

  it("makes the path field the control when no directory picker exists", async () => {
    // `pickDirectory` resolves to null off Tauri, so the button used to open
    // nothing and report nothing, and the field beside it was read-only. The
    // form was impossible to complete on web and mobile.
    isTauriMock.mockReturnValue(false)
    render(<WorktreePanel open rootDir="/repo" onOpenChange={() => {}} />)

    expect(screen.queryByTestId("worktree-pick-directory")).not.toBeInTheDocument()

    const pathField = screen.getByTestId("worktree-path")
    expect(pathField).not.toHaveAttribute("readonly")

    await userEvent.type(screen.getByTestId("worktree-branch"), "feature-c")
    await userEvent.type(pathField, "/work/feature-c")
    fireEvent.click(screen.getByTestId("worktree-create"))

    await waitFor(() => expect(gitWorktreeAdd).toHaveBeenCalled())
    expect(gitWorktreeAdd).toHaveBeenCalledWith(
      "/repo",
      "/work/feature-c",
      "feature-c",
      undefined,
      expect.objectContaining({ ownerType: "user" })
    )
  })
})
