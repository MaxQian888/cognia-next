import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { InteractiveRebaseDialog } from "./interactive-rebase-dialog"
import type { GitCommit } from "@/types/git"

const gitRebaseCommits = jest.fn<Promise<GitCommit[]>, [string, string]>()
jest.mock("@/lib/git/commands", () => ({
  gitRebaseCommits: (rp: string, base: string) => gitRebaseCommits(rp, base),
}))

function c(hash: string, summary: string): GitCommit {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    summary,
    body: "",
    authorName: "T",
    authorEmail: "t@e.com",
    authoredAtMs: 0,
    parents: [],
  }
}

function makeActions() {
  return { interactiveRebase: jest.fn().mockResolvedValue(undefined) }
}

beforeEach(() => {
  jest.clearAllMocks()
  gitRebaseCommits.mockResolvedValue([c("aaaaaaa1", "first"), c("bbbbbbb2", "second")])
})

describe("InteractiveRebaseDialog", () => {
  it("stays closed when base is null", () => {
    render(
      <InteractiveRebaseDialog
        rootDir="/r"
        base={null}
        onOpenChange={() => {}}
        actions={makeActions()}
      />
    )
    expect(screen.queryByTestId("interactive-rebase-dialog")).not.toBeInTheDocument()
  })

  it("lists the commits in base..HEAD", async () => {
    render(
      <InteractiveRebaseDialog
        rootDir="/r"
        base="HEAD~2"
        onOpenChange={() => {}}
        actions={makeActions()}
      />
    )
    await waitFor(() => expect(gitRebaseCommits).toHaveBeenCalledWith("/r", "HEAD~2"))
    expect(await screen.findByTestId("irebase-row-aaaaaaa1")).toBeInTheDocument()
    expect(screen.getByTestId("irebase-row-bbbbbbb2")).toBeInTheDocument()
  })

  it("applies a plain pick plan in order", async () => {
    const actions = makeActions()
    render(
      <InteractiveRebaseDialog
        rootDir="/r"
        base="HEAD~2"
        onOpenChange={() => {}}
        actions={actions}
      />
    )
    await screen.findByTestId("irebase-row-aaaaaaa1")
    await act(async () => {
      fireEvent.click(screen.getByTestId("irebase-apply"))
    })
    expect(actions.interactiveRebase).toHaveBeenCalledWith("HEAD~2", [
      { sha: "aaaaaaa1", action: "pick", message: undefined },
      { sha: "bbbbbbb2", action: "pick", message: undefined },
    ])
  })

  it("reorders rows before applying", async () => {
    const actions = makeActions()
    render(
      <InteractiveRebaseDialog
        rootDir="/r"
        base="HEAD~2"
        onOpenChange={() => {}}
        actions={actions}
      />
    )
    await screen.findByTestId("irebase-row-aaaaaaa1")
    fireEvent.click(screen.getByTestId("irebase-down-aaaaaaa1")) // move first down
    await act(async () => {
      fireEvent.click(screen.getByTestId("irebase-apply"))
    })
    const plan = actions.interactiveRebase.mock.calls[0][1]
    expect(plan.map((e: { sha: string }) => e.sha)).toEqual(["bbbbbbb2", "aaaaaaa1"])
  })

  it("includes the reword message when reword is selected", async () => {
    const user = userEvent.setup()
    const actions = makeActions()
    render(
      <InteractiveRebaseDialog
        rootDir="/r"
        base="HEAD~2"
        onOpenChange={() => {}}
        actions={actions}
      />
    )
    await screen.findByTestId("irebase-row-aaaaaaa1")
    // Switch the first row to reword via the native select (Radix Select needs
    // userEvent; here the trigger opens a listbox).
    await user.click(screen.getByTestId("irebase-action-aaaaaaa1"))
    await user.click(await screen.findByRole("option", { name: "reword" }))
    const input = await screen.findByTestId("irebase-message-aaaaaaa1")
    fireEvent.change(input, { target: { value: "reworded subject" } })
    await act(async () => {
      fireEvent.click(screen.getByTestId("irebase-apply"))
    })
    const plan = actions.interactiveRebase.mock.calls[0][1]
    expect(plan[0]).toEqual({ sha: "aaaaaaa1", action: "reword", message: "reworded subject" })
  })

  it("disables apply when every commit is dropped", async () => {
    const user = userEvent.setup()
    render(
      <InteractiveRebaseDialog
        rootDir="/r"
        base="HEAD~2"
        onOpenChange={() => {}}
        actions={makeActions()}
      />
    )
    await screen.findByTestId("irebase-row-aaaaaaa1")
    for (const sha of ["aaaaaaa1", "bbbbbbb2"]) {
      await user.click(screen.getByTestId(`irebase-action-${sha}`))
      await user.click(await screen.findByRole("option", { name: "drop" }))
    }
    expect(screen.getByTestId("irebase-apply")).toBeDisabled()
  })
})
