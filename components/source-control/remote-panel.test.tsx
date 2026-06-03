import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { RemotePanel } from "./remote-panel"
import type { GitRemote } from "@/types/git"

const gitRemotes = jest.fn<Promise<GitRemote[]>, [string]>()
jest.mock("@/lib/git/commands", () => ({
  gitRemotes: (rp: string) => gitRemotes(rp),
}))

const remotes: GitRemote[] = [
  { name: "origin", fetchUrl: "https://github.com/o/r.git", pushUrl: "https://github.com/o/r.git" },
]

function makeActions() {
  return {
    remoteAdd: jest.fn().mockResolvedValue(undefined),
    remoteRemove: jest.fn().mockResolvedValue(undefined),
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  gitRemotes.mockResolvedValue(remotes)
  Object.assign(navigator, {
    clipboard: { writeText: jest.fn().mockResolvedValue(undefined) },
  })
})

describe("RemotePanel", () => {
  it("loads and lists remotes when opened", async () => {
    render(<RemotePanel open rootDir="/repo" onOpenChange={() => {}} actions={makeActions()} />)
    await waitFor(() => expect(gitRemotes).toHaveBeenCalledWith("/repo"))
    expect(await screen.findByTestId("remote-entry-origin")).toBeInTheDocument()
  })

  it("adds a remote and reloads", async () => {
    const actions = makeActions()
    render(<RemotePanel open rootDir="/repo" onOpenChange={() => {}} actions={actions} />)
    await waitFor(() => expect(gitRemotes).toHaveBeenCalled())
    fireEvent.change(screen.getByTestId("remote-name"), { target: { value: "upstream" } })
    fireEvent.change(screen.getByTestId("remote-url"), {
      target: { value: "https://github.com/u/r.git" },
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId("remote-add"))
    })
    expect(actions.remoteAdd).toHaveBeenCalledWith("upstream", "https://github.com/u/r.git")
    expect(gitRemotes).toHaveBeenCalledTimes(2)
  })

  it("disables add until name + url are filled", async () => {
    render(<RemotePanel open rootDir="/repo" onOpenChange={() => {}} actions={makeActions()} />)
    await waitFor(() => expect(gitRemotes).toHaveBeenCalled())
    expect(screen.getByTestId("remote-add")).toBeDisabled()
  })

  it("removes a remote and reloads", async () => {
    const actions = makeActions()
    render(<RemotePanel open rootDir="/repo" onOpenChange={() => {}} actions={actions} />)
    expect(await screen.findByTestId("remote-entry-origin")).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByTestId("remote-remove-origin"))
    })
    expect(actions.remoteRemove).toHaveBeenCalledWith("origin")
    expect(gitRemotes).toHaveBeenCalledTimes(2)
  })

  it("copies a remote URL to the clipboard", async () => {
    render(<RemotePanel open rootDir="/repo" onOpenChange={() => {}} actions={makeActions()} />)
    expect(await screen.findByTestId("remote-entry-origin")).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByTestId("remote-copy-origin"))
    })
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("https://github.com/o/r.git")
  })

  it("shows empty state with no remotes", async () => {
    gitRemotes.mockResolvedValue([])
    render(<RemotePanel open rootDir="/repo" onOpenChange={() => {}} actions={makeActions()} />)
    await waitFor(() => expect(gitRemotes).toHaveBeenCalled())
    expect(screen.getByTestId("remote-panel")).toBeInTheDocument()
  })
})
