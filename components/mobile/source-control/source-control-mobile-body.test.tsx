/**
 * @jest-environment jsdom
 *
 * Pins what the compact branch changes and, more importantly, what it does
 * not: the same store, the same actions, and the same components as the
 * desktop panel, so a file cannot be staged here and unstaged there.
 */
import { act, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useSettingsStore } from "@/stores/settings/settings-store"

import { SourceControlMobileBody } from "./source-control-mobile-body"

const repo = {
  available: true,
  rootDir: "/repo",
  refresh: jest.fn(async () => undefined),
  openFolder: jest.fn(async () => undefined),
  remote: false as boolean | { id: string },
}
jest.mock("@/hooks/git/use-git-repo", () => ({ useGitRepo: () => repo }))

const actions = {
  pull: jest.fn(async () => undefined),
  push: jest.fn(async () => undefined),
  sync: jest.fn(async () => undefined),
  init: jest.fn(async () => null),
  sequencerContinue: jest.fn(async () => null),
  sequencerAbort: jest.fn(async () => null),
  resolveConflict: jest.fn(async (): Promise<unknown> => null),
  can: (_command: string) => true,
}
jest.mock("@/hooks/git/use-git-actions", () => ({ useGitActions: () => actions }))

const selectFile = jest.fn()
const selectCommit = jest.fn()
let storeState: Record<string, unknown> = {}
jest.mock("@/stores/git/git-store", () => ({
  useGitStore: (selector: (s: Record<string, unknown>) => unknown) => selector(storeState),
}))

/**
 * The four reused components are stubbed to their identity: this file is about
 * which of them is on screen and what they were handed, not about re-testing
 * a diff renderer that has its own suite.
 */
jest.mock("@/components/source-control/branch-header", () => ({
  BranchHeader: ({ branch, ahead, behind }: { branch: string; ahead: number; behind: number }) => (
    <div data-testid="branch-header">{`${branch} +${ahead} -${behind}`}</div>
  ),
}))
jest.mock("@/components/source-control/changes-view", () => ({
  ChangesView: ({
    density,
    variant,
    onSelectFile,
    onViewHistory,
  }: {
    density: string
    variant: string
    onSelectFile: (path: string, staged: boolean) => void
    onViewHistory?: (path: string) => void
  }) => (
    <>
      <button
        data-testid={`changes-view-${density}`}
        data-variant={variant}
        onClick={() => onSelectFile("a.ts", false)}
      >
        changes
      </button>
      {onViewHistory ? (
        <button data-testid="changes-history" onClick={() => onViewHistory("src/a.ts")}>
          history
        </button>
      ) : null}
    </>
  ),
}))
jest.mock("@/components/source-control/repository-navigator", () => ({
  RepositoryNavigator: () => <div data-testid="repository-navigator" />,
}))
jest.mock("@/components/source-control/commit-box", () => ({
  CommitBox: ({ stagedCount }: { stagedCount: number }) => (
    <div data-testid="commit-box">{stagedCount}</div>
  ),
}))
jest.mock("@/components/source-control/diff-pane", () => ({
  DiffPane: ({ path, density }: { path: string; density: string }) => (
    <div data-testid="diff-pane">{`${path}:${density}`}</div>
  ),
}))
jest.mock("@/components/interactions/pull-to-refresh", () => ({
  PullToRefresh: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))
jest.mock("@/components/shared/responsive-detail-sheet", () => ({
  ResponsiveDetailSheet: ({
    open,
    title,
    onOpenChange,
    children,
  }: {
    open: boolean
    title: string
    onOpenChange: (open: boolean) => void
    children: React.ReactNode
  }) =>
    open ? (
      <div data-testid="detail-sheet" data-title={title}>
        <button type="button" data-testid="detail-sheet-close" onClick={() => onOpenChange(false)}>
          close
        </button>
        {children}
      </div>
    ) : null,
}))
jest.mock("@/components/source-control/conflict-resolver", () => ({
  ConflictResolver: ({
    conflict,
    density,
    onResolve,
  }: {
    conflict: { path: string }
    density: string
    onResolve?: (r: { side: string }) => void
  }) => (
    <button
      type="button"
      data-testid="conflict-resolver"
      data-density={density}
      onClick={() => onResolve?.({ side: "ours" })}
    >
      {conflict.path}
    </button>
  ),
}))
jest.mock("@/components/source-control/timeline-view", () => ({
  TimelineView: ({
    open,
    filePath,
    allowGraph,
    onPickCommit,
  }: {
    open: boolean
    filePath: string | null
    allowGraph?: boolean
    onPickCommit?: (sha: string) => void
  }) =>
    open ? (
      <button
        type="button"
        data-testid="timeline-view"
        data-file={filePath ?? ""}
        data-allow-graph={String(allowGraph)}
        onClick={() => {
          // What the real sheet does on a row: select in the store, then hand over.
          storeState.selectedCommit = "abc1234def"
          onPickCommit?.("abc1234def")
        }}
      >
        timeline
      </button>
    ) : null,
}))
jest.mock("@/components/source-control/commit-detail", () => ({
  CommitDetail: ({ commit }: { commit: { hash: string } }) => (
    <div data-testid="commit-detail">{commit.hash}</div>
  ),
}))
jest.mock("@/components/source-control/stash-panel", () => ({
  StashPanel: ({ open }: { open: boolean }) => (open ? <div data-testid="stash-panel" /> : null),
}))

function status(overrides: Record<string, unknown> = {}) {
  return { branch: "dev", ahead: 2, behind: 3, staged: ["a.ts"], changes: [], ...overrides }
}

beforeEach(() => {
  jest.clearAllMocks()
  repo.available = true
  repo.rootDir = "/repo"
  repo.remote = false
  storeState = {
    repoState: { isRepo: true },
    status: status(),
    branches: [],
    selectedPath: null,
    selectedStaged: false,
    selectedCommit: null,
    selectFile,
    selectCommit,
    stashes: [],
    conflicts: [],
    timelineRepo: [],
    timelineFile: [],
    loadError: null,
    loadingStatus: false,
    ops: { commit: false, pull: false, push: false, sync: false, init: false, sequence: false },
  }
  act(() => useSettingsStore.setState({ settings: null as never }))
})

it("renders the list as the page and the commit box pinned below it", () => {
  render(<SourceControlMobileBody />)
  expect(screen.getByTestId("source-control-mobile-body")).toBeInTheDocument()
  expect(screen.getByTestId("branch-header").textContent).toBe("dev +2 -3")
  // Touch density, which the same components already support for the chat
  // dock's narrow pane. Compact targets at 375px are the reason.
  expect(screen.getByTestId("changes-view-touch")).toBeInTheDocument()
  expect(screen.getByTestId("commit-box").textContent).toBe("1")
})

/**
 * `ChangesView`'s `panel` variant renders a `CommitBox` of its own above the
 * list. This screen pins one below it, so asking for `panel` put two live
 * commit boxes on the page, sharing a draft but not their sign-off, identity
 * and history state. The mock hides that, which is exactly why the variant is
 * asserted here rather than the rendered count.
 */
it("asks the list NOT to bring a second commit box", () => {
  render(<SourceControlMobileBody />)
  expect(screen.getByTestId("changes-view-touch")).toHaveAttribute("data-variant", "review")
  expect(screen.getAllByTestId("commit-box")).toHaveLength(1)
})

/**
 * Selection survives navigation and the desktop reopens on it, so deriving
 * "open" from the store would pop the drawer every time the user came back.
 */
it("opens the diff on a tap rather than on the stored selection", () => {
  storeState.selectedPath = "a.ts"
  render(<SourceControlMobileBody />)
  expect(screen.queryByTestId("detail-sheet")).toBeNull()

  fireEvent.click(screen.getByTestId("changes-view-touch"))
  expect(selectFile).toHaveBeenCalledWith("a.ts", false)
  expect(screen.getByTestId("diff-pane").textContent).toBe("a.ts:touch")
})

it("carries the ahead and behind counts on the two buttons that use them", () => {
  render(<SourceControlMobileBody />)
  expect(screen.getByTestId("sc-mobile-push").textContent).toContain("2")
  expect(screen.getByTestId("sc-mobile-pull").textContent).toContain("3")
  fireEvent.click(screen.getByTestId("sc-mobile-pull"))
  expect(actions.pull).toHaveBeenCalled()
})

it("shows a skeleton rather than an empty list before the first load", () => {
  storeState.status = null
  render(<SourceControlMobileBody />)
  expect(screen.getByTestId("sc-mobile-loading")).toBeInTheDocument()
  // An empty list here would read as "no changes", which is the one thing it
  // must not say while it does not know.
  expect(screen.queryByTestId("changes-view-touch")).toBeNull()
  expect(screen.queryByTestId("commit-box")).toBeNull()
})

/**
 * A phone paired to a host has no folder picker: the workspace is chosen on
 * the machine holding the repository. Offering a button that opens nothing is
 * worse than the sentence.
 */
it("offers a folder picker locally and an explanation when remote", () => {
  repo.rootDir = ""
  render(<SourceControlMobileBody />)
  expect(screen.getByTestId("sc-mobile-open-folder")).toBeInTheDocument()

  repo.remote = { id: "host-a" }
  render(<SourceControlMobileBody />)
  expect(screen.getAllByTestId("sc-mobile-no-folder").length).toBe(2)
  expect(screen.getAllByTestId("sc-mobile-open-folder").length).toBe(1)
})

it("says so when git is unavailable and when the folder is not a repository", () => {
  repo.available = false
  const unavailable = render(<SourceControlMobileBody />)
  expect(screen.getByTestId("sc-mobile-unavailable")).toBeInTheDocument()
  unavailable.unmount()

  repo.available = true
  storeState.repoState = { isRepo: false }
  render(<SourceControlMobileBody />)
  expect(screen.getByTestId("sc-mobile-not-a-repo")).toBeInTheDocument()
})

describe("browse", () => {
  /**
   * Worktrees used to be a link out to `/workspace?tab=environments`, because
   * the desktop worktree sheet had a table with nowhere to go at 375px. The
   * navigator does not: its inventory degrades to cards below 640px on its own
   * measured width, and a stack is a vertical chain, which a phone has room
   * for. So the phone gets the same two views the desktop panel offers.
   */
  it("shows the repository navigator instead of linking out", async () => {
    render(<SourceControlMobileBody />)
    expect(screen.queryByTestId("sc-mobile-worktrees-link")).not.toBeInTheDocument()

    fireEvent.click(await screen.findByTestId("sc-mobile-view-browse"))
    expect(screen.getByTestId("repository-navigator")).toBeInTheDocument()
  })

  it("keeps the change list as the screen it opens on", async () => {
    render(<SourceControlMobileBody />)
    expect(await screen.findByTestId("sc-mobile-view-changes")).toHaveAttribute(
      "aria-selected",
      "true"
    )
    expect(screen.queryByTestId("repository-navigator")).not.toBeInTheDocument()
  })

  /**
   * The commit box is the action this screen exists for, so it must not be on
   * screen while the navigator is: a pinned field under a branch list commits
   * changes the user cannot see.
   */
  it("hides the commit box while browsing", async () => {
    render(<SourceControlMobileBody />)
    fireEvent.click(await screen.findByTestId("sc-mobile-view-browse"))
    expect(screen.queryByTestId("commit-box")).not.toBeInTheDocument()
  })
})

describe("load states", () => {
  it("says the read failed, with a retry, instead of a skeleton that never ends", () => {
    storeState.status = null
    storeState.loadError = "fatal: not a git repository"
    render(<SourceControlMobileBody />)
    expect(screen.queryByTestId("sc-mobile-loading")).toBeNull()
    expect(screen.getByTestId("sc-mobile-load-error")).toHaveTextContent("fatal: not a git repository")
    fireEvent.click(screen.getByTestId("sc-mobile-load-retry"))
    expect(repo.refresh).toHaveBeenCalled()
  })

  it("keeps the last list and says it is stale when a refresh fails", () => {
    storeState.loadError = "index.lock exists"
    render(<SourceControlMobileBody />)
    expect(screen.getByTestId("changes-view-touch")).toBeInTheDocument()
    expect(screen.getByTestId("sc-load-error-banner")).toHaveTextContent("index.lock exists")
  })
})

describe("a stopped merge or rebase", () => {
  it("offers continue and abort at touch size", () => {
    storeState.repoState = { isRepo: true, operationInProgress: "rebase" }
    render(<SourceControlMobileBody />)
    expect(screen.getByTestId("sequencer-banner")).toBeInTheDocument()
    expect(screen.getByTestId("sequencer-continue").className).toMatch(/\bh-9\b/)
    fireEvent.click(screen.getByTestId("sequencer-continue"))
    fireEvent.click(screen.getByTestId("sequencer-abort"))
    expect(actions.sequencerContinue).toHaveBeenCalled()
    expect(actions.sequencerAbort).toHaveBeenCalled()
  })

  it("opens a conflicted file in the resolver, and closes the drawer once resolved", async () => {
    storeState.conflicts = [{ path: "a.ts", ours: "o", theirs: "t" }]
    storeState.selectedPath = "a.ts"
    render(<SourceControlMobileBody />)
    fireEvent.click(screen.getByTestId("changes-view-touch"))
    const resolver = screen.getByTestId("conflict-resolver")
    expect(resolver).toHaveAttribute("data-density", "touch")
    expect(screen.queryByTestId("diff-pane")).toBeNull()

    await act(async () => {
      fireEvent.click(resolver)
    })
    expect(actions.resolveConflict).toHaveBeenCalledWith("a.ts", { side: "ours" })
    expect(selectFile).toHaveBeenLastCalledWith(null, false)
    expect(screen.queryByTestId("detail-sheet")).toBeNull()
  })

  it("keeps the drawer open when resolving fails", async () => {
    actions.resolveConflict.mockResolvedValueOnce({ kind: "commandFailed", detail: "x" })
    storeState.conflicts = [{ path: "a.ts", ours: "o", theirs: "t" }]
    storeState.selectedPath = "a.ts"
    render(<SourceControlMobileBody />)
    fireEvent.click(screen.getByTestId("changes-view-touch"))
    await act(async () => {
      fireEvent.click(screen.getByTestId("conflict-resolver"))
    })
    expect(screen.getByTestId("detail-sheet")).toBeInTheDocument()
  })
})

describe("network actions", () => {
  it("publishes a branch that has no upstream instead of pushing nowhere", () => {
    storeState.status = status({ upstream: null })
    render(<SourceControlMobileBody />)
    expect(screen.queryByTestId("sc-mobile-push")).toBeNull()
    fireEvent.click(screen.getByTestId("sc-mobile-publish"))
    expect(actions.push).toHaveBeenCalledWith({ setUpstream: true })
  })

  it("pulls with the rebase preference the desktop honours", () => {
    act(() =>
      useSettingsStore.setState({
        settings: { gitSettings: { panel: { pullRebase: true } } } as never,
      })
    )
    render(<SourceControlMobileBody />)
    fireEvent.click(screen.getByTestId("sc-mobile-pull"))
    expect(actions.pull).toHaveBeenCalledWith({ rebase: true })
  })

  it("disables a button while its operation runs", () => {
    storeState.ops = { ...(storeState.ops as object), pull: true, push: true }
    render(<SourceControlMobileBody />)
    expect(screen.getByTestId("sc-mobile-pull")).toBeDisabled()
    expect(screen.getByTestId("sc-mobile-push")).toBeDisabled()
  })

  it("syncs from the more menu", async () => {
    const user = userEvent.setup()
    render(<SourceControlMobileBody />)
    await user.click(screen.getByTestId("sc-mobile-more"))
    await user.click(await screen.findByTestId("sc-mobile-sync"))
    expect(actions.sync).toHaveBeenCalled()
  })
})

describe("timeline and stashes", () => {
  it("opens the timeline full-screen without its graph, and a pick in a drawer", async () => {
    const user = userEvent.setup()
    render(<SourceControlMobileBody />)
    await user.click(screen.getByTestId("sc-mobile-more"))
    await user.click(await screen.findByTestId("sc-mobile-timeline"))
    const timeline = await screen.findByTestId("timeline-view")
    expect(timeline).toHaveAttribute("data-allow-graph", "false")
    expect(timeline).toHaveAttribute("data-file", "")

    fireEvent.click(timeline)
    // The sheet is gone and the commit is in a drawer, never behind it.
    expect(screen.queryByTestId("timeline-view")).toBeNull()
    expect(screen.getByTestId("commit-detail")).toHaveTextContent("abc1234def")
    expect(screen.getByTestId("detail-sheet")).toHaveAttribute("data-title", "abc1234")

    fireEvent.click(screen.getByTestId("detail-sheet-close"))
    expect(selectCommit).toHaveBeenCalledWith(null)
  })

  it("opens the stash sheet", async () => {
    const user = userEvent.setup()
    render(<SourceControlMobileBody />)
    await user.click(screen.getByTestId("sc-mobile-more"))
    await user.click(await screen.findByTestId("sc-mobile-stash"))
    expect(await screen.findByTestId("stash-panel")).toBeInTheDocument()
  })
})

it("initializes a folder that is not a repository yet", () => {
  storeState.repoState = { isRepo: false }
  render(<SourceControlMobileBody />)
  fireEvent.click(screen.getByTestId("sc-mobile-init"))
  expect(actions.init).toHaveBeenCalled()
})

it("opens the stored selection's drawer when the route asked for it", () => {
  storeState.selectedPath = "a.ts"
  render(<SourceControlMobileBody initialDiffOpen />)
  expect(screen.getByTestId("diff-pane").textContent).toBe("a.ts:touch")
})

it("slides one underline under the active tab", () => {
  render(<SourceControlMobileBody />)
  expect(screen.getAllByTestId("sc-mobile-view-underline")).toHaveLength(1)
  fireEvent.click(screen.getByTestId("sc-mobile-view-browse"))
  expect(screen.getByTestId("sc-mobile-view-browse")).toContainElement(
    screen.getByTestId("sc-mobile-view-underline")
  )
})

it("opens a file's own history from its row", () => {
  render(<SourceControlMobileBody />)
  fireEvent.click(screen.getByTestId("changes-history"))
  expect(screen.getByTestId("timeline-view")).toHaveAttribute("data-file", "src/a.ts")
})

describe("permissions and busy states", () => {
  const allow = actions.can
  afterEach(() => {
    actions.can = allow
  })

  it("disables Timeline and Stashes, and drops per-file history, without their commands", async () => {
    actions.can = (command: string) => command !== "git_log" && command !== "git_stash_list"
    const user = userEvent.setup()
    render(<SourceControlMobileBody />)
    expect(screen.queryByTestId("changes-history")).toBeNull()
    await user.click(screen.getByTestId("sc-mobile-more"))
    expect(await screen.findByTestId("sc-mobile-timeline")).toHaveAttribute("data-disabled")
    expect(screen.getByTestId("sc-mobile-stash")).toHaveAttribute("data-disabled")
  })

  it("disables init while it runs, and publish while a push runs", () => {
    storeState.repoState = { isRepo: false }
    storeState.ops = { ...(storeState.ops as object), init: true }
    const { unmount } = render(<SourceControlMobileBody />)
    expect(screen.getByTestId("sc-mobile-init")).toBeDisabled()
    unmount()

    storeState.repoState = { isRepo: true }
    storeState.status = status({ upstream: null })
    storeState.ops = { ...(storeState.ops as object), init: false, push: true }
    render(<SourceControlMobileBody />)
    expect(screen.getByTestId("sc-mobile-publish")).toBeDisabled()
  })

  it("swallows a failed refresh, which is already on screen as the stale strip", async () => {
    repo.refresh.mockRejectedValueOnce(new Error("offline"))
    render(<SourceControlMobileBody />)
    await act(async () => {
      fireEvent.click(screen.getByTestId("sc-mobile-refresh"))
    })
    expect(repo.refresh).toHaveBeenCalled()
  })
})
