/**
 * @jest-environment jsdom
 *
 * Pins what the compact branch changes and, more importantly, what it does
 * not: the same store, the same actions, and the same components as the
 * desktop panel, so a file cannot be staged here and unstaged there.
 */
import { fireEvent, render, screen } from "@testing-library/react"

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
  can: () => true,
}
jest.mock("@/hooks/git/use-git-actions", () => ({ useGitActions: () => actions }))

const selectFile = jest.fn()
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
  }: {
    density: string
    variant: string
    onSelectFile: (path: string, staged: boolean) => void
  }) => (
    <button
      data-testid={`changes-view-${density}`}
      data-variant={variant}
      onClick={() => onSelectFile("a.ts", false)}
    >
      changes
    </button>
  ),
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
  ResponsiveDetailSheet: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div data-testid="detail-sheet">{children}</div> : null,
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
    selectFile,
    ops: { commit: false },
  }
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

describe("worktrees", () => {
  it("says where worktrees live instead of silently omitting them", async () => {
    render(<SourceControlMobileBody />)
    const link = await screen.findByTestId("sc-mobile-worktrees-link")
    // Addressable because /workspace puts its tab in the URL. A link to the
    // page with no tab would land the user on Overview and leave them hunting.
    expect(link).toHaveAttribute("href", "/workspace?tab=environments")
  })
})
