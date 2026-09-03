import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { BranchPicker } from "./branch-picker"
import { useGitStore } from "@/stores/git/git-store"
import enSourceControl from "@/i18n/messages/en/sourceControl.json"
import zhSourceControl from "@/i18n/messages/zh-CN/sourceControl.json"
import type { GitBranch } from "@/types/git"

function makeBranch(overrides: Partial<GitBranch> & { name: string }): GitBranch {
  return {
    isCurrent: false,
    isRemote: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    checkedOutIn: null,
    checkoutLocked: false,
    ...overrides,
  }
}

const branches: GitBranch[] = [
  makeBranch({ name: "main", isCurrent: true, upstream: "origin/main", checkedOutIn: "/repo" }),
  makeBranch({ name: "feature" }),
  makeBranch({ name: "origin/main", isRemote: true }),
]

/** A branch a second worktree holds, which git will not let us check out. */
const heldBranches: GitBranch[] = [
  ...branches,
  makeBranch({ name: "held", checkedOutIn: "/repo/wt/held" }),
  makeBranch({
    name: "agent/run_a/alice/t1",
    checkedOutIn: "/repo/wt/run-a",
    checkoutLocked: true,
  }),
]

beforeEach(() => {
  act(() => {
    useGitStore.getState().reset()
    useGitStore.setState({ rootDir: "/repo", stackParents: [] })
  })
})

function makeActions() {
  return {
    checkout: jest.fn().mockResolvedValue(undefined),
    createBranch: jest.fn().mockResolvedValue(undefined),
    deleteBranch: jest.fn().mockResolvedValue(undefined),
    renameBranch: jest.fn().mockResolvedValue(undefined),
    rebase: jest.fn().mockResolvedValue(undefined),
    merge: jest.fn().mockResolvedValue(undefined),
  }
}

describe("BranchPicker", () => {
  it("lists branches and checks out on select", async () => {
    const actions = makeActions()
    const onPicked = jest.fn()
    render(<BranchPicker branches={branches} actions={actions} onPicked={onPicked} />)
    fireEvent.click(screen.getByTestId("branch-item-feature"))
    expect(actions.checkout).toHaveBeenCalledWith("feature")
    await waitFor(() => expect(onPicked).toHaveBeenCalled())
  })

  it("deletes a non-current local branch", () => {
    const actions = makeActions()
    render(<BranchPicker branches={branches} actions={actions} />)
    fireEvent.click(screen.getByTestId("branch-delete-feature"))
    expect(actions.deleteBranch).toHaveBeenCalledWith("feature", false)
  })

  it("does not offer delete for the current branch", () => {
    render(<BranchPicker branches={branches} actions={makeActions()} />)
    expect(screen.queryByTestId("branch-delete-main")).not.toBeInTheDocument()
  })

  it("rebases the current branch onto a chosen branch", () => {
    const actions = makeActions()
    render(<BranchPicker branches={branches} actions={actions} />)
    fireEvent.click(screen.getByTestId("branch-rebase-feature"))
    expect(actions.rebase).toHaveBeenCalledWith("feature")
  })

  it("merges a chosen branch into the current branch", async () => {
    const actions = makeActions()
    const onPicked = jest.fn()
    render(<BranchPicker branches={branches} actions={actions} onPicked={onPicked} />)
    fireEvent.click(screen.getByTestId("branch-merge-feature"))
    expect(actions.merge).toHaveBeenCalledWith("feature")
    expect(actions.checkout).not.toHaveBeenCalled()
    await waitFor(() => expect(onPicked).toHaveBeenCalled())
  })

  it("does not offer merge for the current branch", () => {
    render(<BranchPicker branches={branches} actions={makeActions()} />)
    expect(screen.queryByTestId("branch-merge-main")).not.toBeInTheDocument()
  })

  it("creates a branch from the footer input", async () => {
    const actions = makeActions()
    render(<BranchPicker branches={branches} actions={actions} />)
    fireEvent.change(screen.getByTestId("branch-name-input"), { target: { value: "hotfix" } })
    await act(async () => {
      fireEvent.click(screen.getByTestId("branch-submit"))
    })
    expect(actions.createBranch).toHaveBeenCalledWith("hotfix", true)
  })

  it("renames the current branch in rename mode", async () => {
    const actions = makeActions()
    render(<BranchPicker branches={branches} actions={actions} />)
    fireEvent.click(screen.getByTestId("branch-mode-rename"))
    fireEvent.change(screen.getByTestId("branch-name-input"), { target: { value: "renamed" } })
    await act(async () => {
      fireEvent.click(screen.getByTestId("branch-submit"))
    })
    expect(actions.renameBranch).toHaveBeenCalledWith("renamed")
  })

  it("keeps the picker open and preserves input after a failed branch create", async () => {
    const actions = makeActions()
    actions.createBranch.mockResolvedValue({ kind: "commandFailed", detail: "branch exists" })
    const onPicked = jest.fn()
    render(<BranchPicker branches={branches} actions={actions} onPicked={onPicked} />)
    fireEvent.change(screen.getByTestId("branch-name-input"), { target: { value: "existing" } })
    fireEvent.click(screen.getByTestId("branch-submit"))

    await waitFor(() => expect(actions.createBranch).toHaveBeenCalled())
    expect(onPicked).not.toHaveBeenCalled()
    expect(screen.getByTestId("branch-name-input")).toHaveValue("existing")
  })

  it("does not close the picker after a failed checkout", async () => {
    const actions = makeActions()
    actions.checkout.mockResolvedValue({ kind: "dirtyWorkingTree", detail: "local changes" })
    const onPicked = jest.fn()
    render(<BranchPicker branches={branches} actions={actions} onPicked={onPicked} />)
    fireEvent.click(screen.getByTestId("branch-item-feature"))

    await waitFor(() => expect(actions.checkout).toHaveBeenCalled())
    expect(onPicked).not.toHaveBeenCalled()
  })

  it("disables every branch mutation independently when unavailable", () => {
    const actions = { ...makeActions(), can: jest.fn().mockReturnValue(false) }
    render(<BranchPicker branches={branches} actions={actions} />)

    expect(screen.getByTestId("branch-item-feature")).toHaveAttribute("data-disabled", "true")
    expect(screen.getByTestId("branch-merge-feature")).toBeDisabled()
    expect(screen.getByTestId("branch-rebase-feature")).toBeDisabled()
    expect(screen.getByTestId("branch-delete-feature")).toBeDisabled()
    fireEvent.change(screen.getByTestId("branch-name-input"), { target: { value: "blocked" } })
    expect(screen.getByTestId("branch-submit")).toBeDisabled()
  })

  // ---------------------------------------------------------- placement

  /**
   * The defect this whole change exists for. Git refuses to move a branch a
   * second worktree already holds, and the app cuts those worktrees itself for
   * isolated runs, so a checkout button here was a button that could only fail.
   */
  it("opens the holding worktree instead of attempting a checkout git would refuse", async () => {
    const actions = makeActions()
    const onPicked = jest.fn()
    render(<BranchPicker branches={heldBranches} actions={actions} onPicked={onPicked} />)

    fireEvent.click(screen.getByTestId("branch-item-held"))

    expect(actions.checkout).not.toHaveBeenCalled()
    expect(useGitStore.getState().rootDir).toBe("/repo/wt/held")
    await waitFor(() => expect(onPicked).toHaveBeenCalled())
  })

  // The intl mock returns keys rather than interpolated messages, so these
  // assert the placement the row committed to, not the rendered sentence.
  // `branch-placement.test.ts` covers the label input (`worktreeLabel`).
  it("says which worktree holds a branch, and separates it from a free one", () => {
    render(<BranchPicker branches={heldBranches} actions={makeActions()} />)

    expect(screen.getByTestId("branch-where-held")).toBeInTheDocument()
    expect(screen.getByTestId("branch-item-held")).toHaveAttribute(
      "data-placement",
      "otherWorktree"
    )
    expect(screen.getByTestId("branch-item-feature")).toHaveAttribute("data-placement", "free")
    expect(screen.getByTestId("branch-item-main")).toHaveAttribute("data-placement", "here")
    expect(screen.getByTestId("branch-item-origin/main")).toHaveAttribute(
      "data-placement",
      "remoteOnly"
    )
  })

  it("never offers to delete a branch a worktree holds", () => {
    render(<BranchPicker branches={heldBranches} actions={makeActions()} />)
    expect(screen.queryByTestId("branch-delete-held")).not.toBeInTheDocument()
  })

  /**
   * `checkout origin/x` detaches HEAD. What the row means is `checkout -b x
   * origin/x`, which also sets the upstream.
   */
  it("creates a tracking branch for a remote ref rather than detaching HEAD", async () => {
    const actions = makeActions()
    const onPicked = jest.fn()
    render(<BranchPicker branches={branches} actions={actions} onPicked={onPicked} />)

    fireEvent.click(screen.getByTestId("branch-item-origin/main"))

    expect(actions.checkout).not.toHaveBeenCalled()
    expect(actions.createBranch).toHaveBeenCalledWith("main", true, "origin/main")
    await waitFor(() => expect(onPicked).toHaveBeenCalled())
  })

  it("never offers to delete a remote ref", () => {
    render(<BranchPicker branches={branches} actions={makeActions()} />)
    expect(screen.queryByTestId("branch-delete-origin/main")).not.toBeInTheDocument()
  })

  it("still checks out a branch no worktree holds", async () => {
    const actions = makeActions()
    render(<BranchPicker branches={heldBranches} actions={actions} />)
    fireEvent.click(screen.getByTestId("branch-item-feature"))
    await waitFor(() => expect(actions.checkout).toHaveBeenCalledWith("feature"))
  })

  // ------------------------------------------------------------ row detail

  it("marks a branch an isolated run cut", () => {
    render(<BranchPicker branches={heldBranches} actions={makeActions()} />)
    expect(screen.getByTestId("branch-agent-agent/run_a/alice/t1")).toBeInTheDocument()
    expect(screen.queryByTestId("branch-agent-feature")).not.toBeInTheDocument()
  })

  it("shows the stack parent a branch is layered on", () => {
    act(() => {
      useGitStore.setState({ stackParents: [["feature", "main"]] })
    })
    render(<BranchPicker branches={branches} actions={makeActions()} />)
    expect(screen.getByTestId("branch-stack-feature")).toBeInTheDocument()
    expect(screen.queryByTestId("branch-stack-main")).not.toBeInTheDocument()
  })

  it("renders the ahead and behind counts the backend already reported", () => {
    const withCounts = [makeBranch({ name: "feature", ahead: 3, behind: 2 })]
    render(<BranchPicker branches={withCounts} actions={makeActions()} />)
    const row = screen.getByTestId("branch-item-feature")
    expect(row).toHaveTextContent("3")
    expect(row).toHaveTextContent("2")
  })

  // -------------------------------------------------------- force delete

  /**
   * Git refuses `branch -d` on unmerged commits. That is a question, not a
   * dead end, so the row escalates to an explicit `-D` confirmation rather
   * than leaving a toast and no way forward.
   */
  it("asks before force-deleting a branch git refused as unmerged", async () => {
    const actions = makeActions()
    actions.deleteBranch.mockResolvedValue({
      kind: "branchNotFullyMerged",
      detail: "not fully merged",
    })
    render(<BranchPicker branches={branches} actions={actions} />)

    fireEvent.click(screen.getByTestId("branch-delete-feature"))
    await waitFor(() => expect(actions.deleteBranch).toHaveBeenCalledWith("feature", false))

    const confirm = await screen.findByTestId("branch-force-delete-confirm")
    expect(confirm).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("branch-force-delete-action"))
    await waitFor(() => expect(actions.deleteBranch).toHaveBeenCalledWith("feature", true))
  })

  it("does not ask to force-delete when git refused for another reason", async () => {
    const actions = makeActions()
    actions.deleteBranch.mockResolvedValue({ kind: "commandFailed", detail: "nope" })
    render(<BranchPicker branches={branches} actions={actions} />)

    fireEvent.click(screen.getByTestId("branch-delete-feature"))
    await waitFor(() => expect(actions.deleteBranch).toHaveBeenCalled())
    expect(screen.queryByTestId("branch-force-delete-confirm")).not.toBeInTheDocument()
  })

  // ---------------------------------------------------------------- gating

  /**
   * Binding the panel to another worktree is not a git mutation, so it must
   * stay available on a client that cannot run one.
   */
  it("still opens a worktree when git mutations are unavailable", () => {
    const actions = { ...makeActions(), can: jest.fn().mockReturnValue(false) }
    render(<BranchPicker branches={heldBranches} actions={actions} />)

    expect(screen.getByTestId("branch-item-held")).not.toHaveAttribute("data-disabled", "true")
    fireEvent.click(screen.getByTestId("branch-item-held"))
    expect(useGitStore.getState().rootDir).toBe("/repo/wt/held")
  })

  /**
   * The intl mock answers with the key, so a key that exists in neither
   * catalogue renders identically to one that exists in both. `lint:i18n`
   * hunts hard-coded strings and does not check that a referenced key
   * resolves, so nothing else covers this.
   */
  it("has every branch-row key in both catalogues", () => {
    const en = enSourceControl as { branches: Record<string, string> }
    const zh = zhSourceControl as { branches: Record<string, string> }
    const used = [
      "agentBranch",
      "createTracking",
      "forceDeleteAction",
      "forceDeleteDescription",
      "forceDeleteTitle",
      "inWorktree",
      "noUpstream",
      "openWorktree",
      "remote",
      "stackParent",
      "switch",
    ]
    for (const key of used) {
      expect(en.branches[key]).toBeTruthy()
      expect(zh.branches[key]).toBeTruthy()
    }
  })
})
