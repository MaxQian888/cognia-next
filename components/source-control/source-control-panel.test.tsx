const repoCfg: { available: boolean; rootDir: string | null; openFolder: jest.Mock } = {
  available: true,
  rootDir: "/repo",
  openFolder: jest.fn(),
}

jest.mock("@/hooks/git/use-git-repo", () => ({
  useGitRepo: () => ({
    available: repoCfg.available,
    rootDir: repoCfg.rootDir,
    refresh: jest.fn().mockResolvedValue(undefined),
    openFolder: repoCfg.openFolder,
  }),
}))
jest.mock("@/hooks/git/use-git-actions", () => ({
  useGitActions: () => ({ resolveConflict: jest.fn() }),
}))
jest.mock("@/hooks/ui/use-resizable-layout", () => ({
  useResizableLayout: () => ({ defaultLayout: undefined, onLayoutChanged: jest.fn() }),
}))
jest.mock("./changes-view", () => ({ ChangesView: () => <div data-testid="changes-view-stub" /> }))
jest.mock("./diff-pane", () => ({ DiffPane: () => <div data-testid="diff-pane-stub" /> }))
jest.mock("./conflict-resolver", () => ({
  ConflictResolver: () => <div data-testid="conflict-stub" />,
}))
jest.mock("./commit-detail", () => ({
  CommitDetail: () => <div data-testid="commit-detail-stub" />,
}))
jest.mock("./stash-panel", () => ({ StashPanel: () => null }))
jest.mock("./timeline-view", () => ({ TimelineView: () => null }))
jest.mock("./branch-header", () => ({
  BranchHeader: () => <div data-testid="branch-header-stub" />,
}))
jest.mock("./sync-toolbar", () => ({ SyncToolbar: () => <div data-testid="sync-toolbar-stub" /> }))

import { act, fireEvent, render, screen } from "@testing-library/react"
import { SourceControlPanel } from "./source-control-panel"
import { useGitStore } from "@/stores/git/git-store"
import type { GitStatus } from "@/types/git"

const status: GitStatus = {
  branch: "main",
  upstream: null,
  ahead: 0,
  behind: 0,
  staged: [],
  changes: [{ path: "a.ts", origPath: null, status: "modified", staged: false, group: "changes" }],
  merge: [{ path: "conf.ts", origPath: null, status: "conflicted", staged: false, group: "merge" }],
  isRebasing: false,
  isMerging: true,
}

beforeEach(() => {
  repoCfg.available = true
  repoCfg.rootDir = "/repo"
  repoCfg.openFolder.mockReset()
  act(() => {
    useGitStore.getState().reset()
    useGitStore.setState({ rootDir: "/repo" })
    useGitStore.getState().setRepoState({
      isRepo: true,
      rootDir: "/repo",
      detachedHead: false,
      operationInProgress: null,
    })
    useGitStore.getState().setStatus(status)
    useGitStore.getState().setConflicts([{ path: "conf.ts", ours: "a", theirs: "b", base: null }])
  })
})

describe("SourceControlPanel", () => {
  it("shows the desktop-only state on web", () => {
    repoCfg.available = false
    render(<SourceControlPanel />)
    expect(screen.getByTestId("sc-desktop-only")).toBeInTheDocument()
  })

  it("shows the open-folder state with no repo bound", () => {
    repoCfg.rootDir = null
    render(<SourceControlPanel />)
    fireEvent.click(screen.getByTestId("open-folder-button"))
    expect(repoCfg.openFolder).toHaveBeenCalled()
  })

  it("shows the not-a-repo state", () => {
    act(() =>
      useGitStore.getState().setRepoState({
        isRepo: false,
        rootDir: "/repo",
        detachedHead: false,
        operationInProgress: null,
      })
    )
    render(<SourceControlPanel />)
    expect(screen.getByTestId("sc-not-a-repo")).toBeInTheDocument()
  })

  it("renders the changes view + empty diff pane by default", () => {
    render(<SourceControlPanel />)
    expect(screen.getByTestId("changes-view-stub")).toBeInTheDocument()
    expect(screen.getByTestId("diff-pane-empty")).toBeInTheDocument()
  })

  it("shows the sequencer banner when an operation is in progress", () => {
    act(() =>
      useGitStore.getState().setRepoState({
        isRepo: true,
        rootDir: "/repo",
        detachedHead: false,
        operationInProgress: "rebase",
      })
    )
    render(<SourceControlPanel />)
    expect(screen.getByTestId("sequencer-banner")).toBeInTheDocument()
    expect(screen.getByTestId("sequencer-continue")).toBeInTheDocument()
    expect(screen.getByTestId("sequencer-abort")).toBeInTheDocument()
  })

  it("hides the sequencer banner when idle", () => {
    render(<SourceControlPanel />)
    expect(screen.queryByTestId("sequencer-banner")).not.toBeInTheDocument()
  })

  it("routes a selected file to the diff pane", () => {
    act(() => useGitStore.getState().selectFile("a.ts", false))
    render(<SourceControlPanel />)
    expect(screen.getByTestId("diff-pane-stub")).toBeInTheDocument()
  })

  it("routes a selected conflicted file to the conflict resolver", () => {
    act(() => useGitStore.getState().selectFile("conf.ts", false))
    render(<SourceControlPanel />)
    expect(screen.getByTestId("conflict-stub")).toBeInTheDocument()
  })

  it("routes a selected commit to the commit detail", () => {
    act(() => useGitStore.getState().selectCommit("abc123"))
    render(<SourceControlPanel />)
    expect(screen.getByTestId("commit-detail-stub")).toBeInTheDocument()
  })
})
