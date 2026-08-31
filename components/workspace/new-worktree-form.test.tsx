/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { gitTargetFromRemote } from "@/lib/git/target"

import { NewWorktreeForm } from "./new-worktree-form"

const gitWorktreeAdd = jest.fn()
const pickDirectory = jest.fn()
const toastError = jest.fn()
const toastSuccess = jest.fn()

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("@/lib/git/commands", () => ({
  gitWorktreeAdd: (...args: unknown[]) => gitWorktreeAdd(...args),
  runGitUserAction: (_command: string, operation: () => Promise<unknown>) => operation(),
}))
jest.mock("@/lib/files/file-bridge", () => ({ pickDirectory: () => pickDirectory() }))
jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => true) }))
jest.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: (...args: unknown[]) => toastSuccess(...args),
  },
}))

const isTauriMock = jest.requireMock("@/lib/tauri").isTauri as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  isTauriMock.mockReturnValue(true)
  gitWorktreeAdd.mockResolvedValue(undefined)
  pickDirectory.mockResolvedValue("/work/feature-b")
})

describe("NewWorktreeForm", () => {
  it("creates a worktree from the picked directory and reports back", async () => {
    const onCreated = jest.fn()
    render(<NewWorktreeForm rootDir="/repo" onCreated={onCreated} />)

    await userEvent.type(screen.getByTestId("worktree-branch"), "feature-b")
    fireEvent.click(screen.getByTestId("worktree-pick-directory"))
    await waitFor(() => expect(screen.getByTestId("worktree-path")).toHaveValue("/work/feature-b"))

    fireEvent.click(screen.getByTestId("worktree-create"))

    await waitFor(() => expect(onCreated).toHaveBeenCalled())
    expect(gitWorktreeAdd).toHaveBeenCalledWith(
      "/repo",
      "/work/feature-b",
      "feature-b",
      undefined,
      expect.objectContaining({ ownerType: "user" })
    )
  })

  it("makes the path field the control where no picker exists", async () => {
    // Off Tauri `pickDirectory` resolves to null, so a Browse button here would
    // open nothing and say nothing.
    isTauriMock.mockReturnValue(false)
    render(<NewWorktreeForm rootDir="/repo" />)

    expect(screen.queryByTestId("worktree-pick-directory")).not.toBeInTheDocument()
    expect(screen.getByTestId("worktree-path")).not.toHaveAttribute("readonly")
  })

  it("keeps the host path controls off a remote target", () => {
    render(<NewWorktreeForm rootDir={gitTargetFromRemote("workspace-a", "repo")} />)

    expect(screen.queryByTestId("worktree-pick-directory")).not.toBeInTheDocument()
    expect(screen.getByTestId("worktree-path")).not.toHaveAttribute("readonly")
  })

  it("honours a denied create capability without issuing the command", async () => {
    render(
      <NewWorktreeForm rootDir="/repo" canMutate={(command) => command !== "git_worktree_add"} />
    )

    await userEvent.type(screen.getByTestId("worktree-branch"), "feature-b")
    fireEvent.click(screen.getByTestId("worktree-pick-directory"))
    await waitFor(() => expect(screen.getByTestId("worktree-path")).toHaveValue("/work/feature-b"))

    expect(screen.getByTestId("worktree-create")).toBeDisabled()
    fireEvent.click(screen.getByTestId("worktree-create"))
    expect(gitWorktreeAdd).not.toHaveBeenCalled()
  })

  it("surfaces a typed failure and keeps what was typed", async () => {
    gitWorktreeAdd.mockRejectedValue({ kind: "worktreeExists", detail: "already checked out" })
    render(<NewWorktreeForm rootDir="/repo" />)

    await userEvent.type(screen.getByTestId("worktree-branch"), "feature-b")
    fireEvent.click(screen.getByTestId("worktree-pick-directory"))
    await waitFor(() => expect(screen.getByTestId("worktree-path")).toHaveValue("/work/feature-b"))
    fireEvent.click(screen.getByTestId("worktree-create"))

    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(toastSuccess).not.toHaveBeenCalled()
    // A failed create must not clear the form: retyping is the punishment for
    // an error the user did not cause.
    expect(screen.getByTestId("worktree-branch")).toHaveValue("feature-b")
  })
})
