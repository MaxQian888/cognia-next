const gitClone = jest.fn<Promise<string>, [string, string]>()
const pickDirectory = jest.fn<Promise<string | null>, []>()

jest.mock("@/lib/git/commands", () => ({
  gitClone: (remoteUrl: string, destination: string) => gitClone(remoteUrl, destination),
  runGitUserAction: (_command: string, operation: () => Promise<unknown>) => operation(),
}))

jest.mock("@/lib/files/file-bridge", () => ({
  pickDirectory: () => pickDirectory(),
}))

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { CloneRepositoryDialog } from "./clone-repository-dialog"
import { parseGitTarget } from "@/lib/git/target"

beforeEach(() => {
  gitClone.mockReset()
  pickDirectory.mockReset()
})

describe("CloneRepositoryDialog", () => {
  it("clones the repository and reports the canonical cloned path", async () => {
    const user = userEvent.setup()
    const onOpenChange = jest.fn()
    const onCloned = jest.fn()
    gitClone.mockResolvedValue("/work/cloned")

    render(<CloneRepositoryDialog open onOpenChange={onOpenChange} onCloned={onCloned} />)
    await user.type(screen.getByTestId("clone-url"), "https://example.com/team/repo.git")
    await user.type(screen.getByTestId("clone-destination"), "/work/cloned ")
    await user.click(screen.getByTestId("clone-submit"))

    await waitFor(() =>
      expect(gitClone).toHaveBeenCalledWith("https://example.com/team/repo.git", "/work/cloned ")
    )
    expect(onCloned).toHaveBeenCalledWith("/work/cloned")
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("uses a relative destination and hides the native picker for remote workspaces", async () => {
    const user = userEvent.setup()
    gitClone.mockResolvedValue("git-workspace:cloned")
    render(
      <CloneRepositoryDialog
        open
        remoteWorkspaceId="workspace-a"
        onOpenChange={jest.fn()}
        onCloned={jest.fn()}
      />
    )

    await user.type(screen.getByTestId("clone-url"), "https://example.com/team/repo.git")
    await user.type(screen.getByTestId("clone-destination"), "repositories/project")
    await user.click(screen.getByTestId("clone-submit"))

    await waitFor(() => expect(gitClone).toHaveBeenCalled())
    const destination = gitClone.mock.calls[0]?.[1] ?? ""
    expect(parseGitTarget(destination)).toEqual({
      kind: "remote",
      workspaceId: "workspace-a",
      relativePath: "repositories/project",
    })
    expect(screen.queryByTestId("clone-browse")).not.toBeInTheDocument()
  })

  it("uses the directory picker and keeps the dialog open when cloning fails", async () => {
    const user = userEvent.setup()
    const onCloned = jest.fn()
    pickDirectory.mockResolvedValue("/picked/repo")
    gitClone
      .mockRejectedValueOnce({ kind: "authRequired", detail: "Authentication failed" })
      .mockResolvedValueOnce("/picked/repo")

    render(<CloneRepositoryDialog open onOpenChange={jest.fn()} onCloned={onCloned} />)
    await user.click(screen.getByTestId("clone-browse"))
    expect(screen.getByTestId("clone-destination")).toHaveValue("/picked/repo")
    await user.type(screen.getByTestId("clone-url"), "https://example.com/private.git")
    fireEvent.click(screen.getByTestId("clone-submit"))

    expect(await screen.findByText("Authentication failed")).toBeInTheDocument()
    expect(screen.getByText(/credential manager or SSH agent/)).toBeInTheDocument()
    expect(screen.getByTestId("clone-url")).toBeInTheDocument()
    await user.click(screen.getByTestId("clone-auth-retry"))
    await waitFor(() => expect(onCloned).toHaveBeenCalledWith("/picked/repo"))
  })

  it("does not call the backend until URL and destination are both present", () => {
    render(<CloneRepositoryDialog open onOpenChange={jest.fn()} onCloned={jest.fn()} />)
    expect(screen.getByTestId("clone-submit")).toBeDisabled()
    fireEvent.change(screen.getByTestId("clone-url"), {
      target: { value: "https://example.com/r" },
    })
    expect(screen.getByTestId("clone-submit")).toBeDisabled()
    expect(gitClone).not.toHaveBeenCalled()
  })

  it("clears the form when cancelled or dismissed", async () => {
    const user = userEvent.setup()
    const onOpenChange = jest.fn()
    const { rerender } = render(
      <CloneRepositoryDialog open onOpenChange={onOpenChange} onCloned={jest.fn()} />
    )
    await user.type(screen.getByTestId("clone-url"), "https://example.com/repo.git")
    await user.type(screen.getByTestId("clone-destination"), "/work/repo")
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    expect(onOpenChange).toHaveBeenCalledWith(false)

    rerender(<CloneRepositoryDialog open onOpenChange={onOpenChange} onCloned={jest.fn()} />)
    expect(screen.getByTestId("clone-url")).toHaveValue("")
    await user.keyboard("{Escape}")
    expect(onOpenChange).toHaveBeenLastCalledWith(false)
  })

  it("handles cancelled and failed directory picks", async () => {
    const user = userEvent.setup()
    pickDirectory.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("picker failed"))
    render(<CloneRepositoryDialog open onOpenChange={jest.fn()} onCloned={jest.fn()} />)

    await user.click(screen.getByTestId("clone-browse"))
    expect(screen.getByTestId("clone-destination")).toHaveValue("")
    await user.click(screen.getByTestId("clone-browse"))
    expect(await screen.findByText("Could not open the folder picker")).toBeInTheDocument()
  })

  it.each([
    [{ kind: "networkFailed" }, "networkFailed"],
    [new Error("unexpected"), "Failed to clone repository"],
  ])("shows a fallback for clone error %p", async (error, expected) => {
    const user = userEvent.setup()
    gitClone.mockRejectedValue(error)
    render(<CloneRepositoryDialog open onOpenChange={jest.fn()} onCloned={jest.fn()} />)
    await user.type(screen.getByTestId("clone-url"), "https://example.com/repo.git")
    await user.type(screen.getByTestId("clone-destination"), "/work/repo")
    await user.click(screen.getByTestId("clone-submit"))

    expect(await screen.findByText(expected)).toBeInTheDocument()
  })

  it("ignores dismissal while cloning is in progress", async () => {
    const user = userEvent.setup()
    const onOpenChange = jest.fn()
    const onCloned = jest.fn()
    let finishClone!: (path: string) => void
    gitClone.mockReturnValue(
      new Promise((resolve) => {
        finishClone = resolve
      })
    )
    render(<CloneRepositoryDialog open onOpenChange={onOpenChange} onCloned={onCloned} />)
    await user.type(screen.getByTestId("clone-url"), "https://example.com/repo.git")
    await user.type(screen.getByTestId("clone-destination"), "/work/repo")
    await user.click(screen.getByTestId("clone-submit"))
    expect(await screen.findByText("Cloning…")).toBeInTheDocument()

    await user.keyboard("{Escape}")
    expect(onOpenChange).not.toHaveBeenCalled()
    finishClone("/work/repo")
    await waitFor(() => expect(onCloned).toHaveBeenCalledWith("/work/repo"))
  })
})
