const gitIdentity = jest.fn()
const gitSetIdentity = jest.fn()

jest.mock("@/lib/git/commands", () => ({
  gitIdentity: (repoPath: string) => gitIdentity(repoPath),
  gitSetIdentity: (repoPath: string, name: string, email: string, global: boolean) =>
    gitSetIdentity(repoPath, name, email, global),
  runGitUserAction: (_command: string, operation: () => Promise<unknown>) => operation(),
}))

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { GitIdentityDialog } from "./git-identity-dialog"
import { gitTargetFromRemote } from "@/lib/git/target"

beforeEach(() => {
  gitIdentity.mockReset()
  gitSetIdentity.mockReset()
})

describe("GitIdentityDialog", () => {
  it("prefills the effective identity, saves the selected scope, and resumes the commit", async () => {
    const user = userEvent.setup()
    const onSaved = jest.fn()
    gitIdentity.mockResolvedValue({
      name: "Existing User",
      email: "existing@example.com",
    })
    gitSetIdentity.mockResolvedValue(undefined)

    render(<GitIdentityDialog open repoPath="/repo" onOpenChange={jest.fn()} onSaved={onSaved} />)
    await waitFor(() => expect(screen.getByTestId("identity-name")).toHaveValue("Existing User"))
    await user.clear(screen.getByTestId("identity-name"))
    await user.type(screen.getByTestId("identity-name"), "Cognia Developer")
    await user.clear(screen.getByTestId("identity-email"))
    await user.type(screen.getByTestId("identity-email"), "developer@example.com")
    await user.click(screen.getByTestId("identity-global"))
    await user.click(screen.getByTestId("identity-save"))

    await waitFor(() =>
      expect(gitSetIdentity).toHaveBeenCalledWith(
        "/repo",
        "Cognia Developer",
        "developer@example.com",
        true
      )
    )
    expect(onSaved).toHaveBeenCalled()
  })

  it("keeps remote identity repository-local and hides the global scope", async () => {
    const user = userEvent.setup()
    const repoPath = gitTargetFromRemote("workspace-a", "repo")
    gitIdentity.mockResolvedValue({ name: "", email: "" })
    gitSetIdentity.mockResolvedValue(undefined)
    render(
      <GitIdentityDialog open repoPath={repoPath} onOpenChange={jest.fn()} onSaved={jest.fn()} />
    )

    await user.type(screen.getByTestId("identity-name"), "Remote Developer")
    await user.type(screen.getByTestId("identity-email"), "remote@example.com")
    expect(screen.queryByTestId("identity-global")).not.toBeInTheDocument()
    await user.click(screen.getByTestId("identity-save"))

    await waitFor(() =>
      expect(gitSetIdentity).toHaveBeenCalledWith(
        repoPath,
        "Remote Developer",
        "remote@example.com",
        false
      )
    )
  })

  it("keeps the dialog open and shows a typed backend error", async () => {
    const user = userEvent.setup()
    gitIdentity.mockResolvedValue({ name: null, email: null })
    gitSetIdentity.mockRejectedValue({ kind: "commandFailed", detail: "config is locked" })

    render(<GitIdentityDialog open repoPath="/repo" onOpenChange={jest.fn()} onSaved={jest.fn()} />)
    await waitFor(() => expect(screen.getByTestId("identity-name")).not.toBeDisabled())
    await user.type(screen.getByTestId("identity-name"), "User")
    await user.type(screen.getByTestId("identity-email"), "user@example.com")
    await user.click(screen.getByTestId("identity-save"))

    expect(await screen.findByText("config is locked")).toBeInTheDocument()
    expect(screen.getByTestId("identity-save")).toBeInTheDocument()
  })

  it("allows cancellation through the button and dialog dismissal", async () => {
    const user = userEvent.setup()
    const onOpenChange = jest.fn()
    gitIdentity.mockResolvedValue({ name: null, email: null })

    render(
      <GitIdentityDialog open repoPath="/repo" onOpenChange={onOpenChange} onSaved={jest.fn()} />
    )
    await waitFor(() => expect(screen.getByTestId("identity-name")).not.toBeDisabled())
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    await user.keyboard("{Escape}")
    expect(onOpenChange).toHaveBeenLastCalledWith(false)
  })

  it("does not load while closed and tolerates an empty identity response", async () => {
    const { rerender } = render(
      <GitIdentityDialog
        open={false}
        repoPath="/repo"
        onOpenChange={jest.fn()}
        onSaved={jest.fn()}
      />
    )
    expect(gitIdentity).not.toHaveBeenCalled()

    gitIdentity.mockResolvedValue(null)
    rerender(
      <GitIdentityDialog open repoPath="/repo" onOpenChange={jest.fn()} onSaved={jest.fn()} />
    )
    await waitFor(() => expect(gitIdentity).toHaveBeenCalledWith("/repo"))
    expect(screen.getByTestId("identity-name")).toHaveValue("")
  })

  it.each([
    [{ kind: "commandFailed" }, "commandFailed"],
    [new Error("unexpected"), "Failed to load Git identity"],
  ])("shows a fallback for identity load error %p", async (error, expected) => {
    gitIdentity.mockRejectedValue(error)
    render(<GitIdentityDialog open repoPath="/repo" onOpenChange={jest.fn()} onSaved={jest.fn()} />)

    expect(await screen.findByText(expected)).toBeInTheDocument()
  })

  it("drops an in-flight identity load after unmount", async () => {
    gitIdentity.mockResolvedValue({ name: "Late User", email: "late@example.com" })
    const { unmount } = render(
      <GitIdentityDialog open repoPath="/repo" onOpenChange={jest.fn()} onSaved={jest.fn()} />
    )
    unmount()
    await Promise.resolve()

    expect(gitIdentity).not.toHaveBeenCalled()
  })

  it("ignores a load that resolves after the dialog unmounts", async () => {
    let resolveIdentity!: (identity: { name: string; email: string }) => void
    gitIdentity.mockReturnValue(
      new Promise((resolve) => {
        resolveIdentity = resolve
      })
    )
    const { unmount } = render(
      <GitIdentityDialog open repoPath="/repo" onOpenChange={jest.fn()} onSaved={jest.fn()} />
    )
    await waitFor(() => expect(gitIdentity).toHaveBeenCalledWith("/repo"))
    unmount()
    resolveIdentity({ name: "Late User", email: "late@example.com" })
    await Promise.resolve()

    expect(gitSetIdentity).not.toHaveBeenCalled()
  })
})
