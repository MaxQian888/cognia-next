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
jest.mock("@/lib/git/commands", () => ({
  gitInit: jest.fn().mockResolvedValue(undefined),
}))
jest.mock("@/hooks/ui/use-resizable-layout", () => ({
  useResizableLayout: () => ({ defaultLayout: undefined, onLayoutChanged: jest.fn() }),
}))
// Stub the resizable wrapper — the real Group measures the DOM, which jsdom
// can't satisfy. Expose size props as data attributes for unit assertions.
jest.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({
    children,
    className,
  }: {
    children: React.ReactNode
    className?: string
  }) => (
    <div data-testid="resizable-group" className={className}>
      {children}
    </div>
  ),
  ResizablePanel: ({
    children,
    id,
    defaultSize,
    minSize,
    maxSize,
  }: {
    children: React.ReactNode
    id?: string
    defaultSize?: number | string
    minSize?: number | string
    maxSize?: number | string
  }) => (
    <div
      data-testid={id ? `resizable-panel-${id}` : "resizable-panel"}
      data-default-size={defaultSize === undefined ? undefined : String(defaultSize)}
      data-min-size={minSize === undefined ? undefined : String(minSize)}
      data-max-size={maxSize === undefined ? undefined : String(maxSize)}
    >
      {children}
    </div>
  ),
  ResizableHandle: () => <div data-slot="resizable-handle" />,
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
import userEvent from "@testing-library/user-event"
import { gitInit } from "@/lib/git/commands"
import { SourceControlPanel } from "./source-control-panel"
import { useGitStore } from "@/stores/git/git-store"
import type { GitStatus } from "@/types/git"

const gitInitMock = gitInit as jest.Mock

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

  it("initializes a repository from the not-a-repo state", async () => {
    gitInitMock.mockClear()
    act(() =>
      useGitStore.getState().setRepoState({
        isRepo: false,
        rootDir: "/repo",
        detachedHead: false,
        operationInProgress: null,
      })
    )
    render(<SourceControlPanel />)
    await act(async () => {
      fireEvent.click(screen.getByTestId("init-repo-button"))
    })
    expect(gitInitMock).toHaveBeenCalledWith("/repo")
  })

  // The wallpaper/surface system in globals.css only frosts a subtree that
  // opts in via [data-bg-target]; without it the panel stays opaque over a
  // background image (matches PerformanceDashboard's root).
  it("opts the panel into the chat wallpaper surface scope", () => {
    render(<SourceControlPanel />)
    expect(screen.getByTestId("source-control-panel")).toHaveAttribute("data-bg-target", "chat")
  })

  it("renders the changes view + empty diff pane by default", () => {
    render(<SourceControlPanel />)
    expect(screen.getByTestId("changes-view-stub")).toBeInTheDocument()
    expect(screen.getByTestId("diff-pane-empty")).toBeInTheDocument()
  })

  // react-resizable-panels v4 interprets bare numbers as PIXELS; sizes must
  // be percent strings or the changes/diff split collapses to px-wide slivers.
  it("passes percent-string sizes to the changes and diff panels", () => {
    render(<SourceControlPanel />)
    const percent = /^\d+(\.\d+)?%$/
    const changes = screen.getByTestId("resizable-panel-sc-changes")
    const diff = screen.getByTestId("resizable-panel-sc-diff")
    for (const panel of [changes, diff]) {
      expect(panel.dataset.defaultSize).toMatch(percent)
      expect(panel.dataset.minSize).toMatch(percent)
    }
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

  it("opens the view-settings gear popover from the header", async () => {
    const user = userEvent.setup()
    render(<SourceControlPanel />)
    const trigger = screen.getByTestId("sc-view-settings-trigger")
    expect(trigger).toBeInTheDocument()
    await user.click(trigger)
    expect(await screen.findByTestId("sc-view-settings")).toBeInTheDocument()
  })
})
