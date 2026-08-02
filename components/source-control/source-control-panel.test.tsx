const repoCfg: {
  available: boolean
  rootDir: string | null
  openFolder: jest.Mock
  refresh: jest.Mock
} = {
  available: true,
  rootDir: "/repo",
  openFolder: jest.fn(),
  refresh: jest.fn().mockResolvedValue(undefined),
}
const actionCfg = {
  resolveConflict: jest.fn(),
  sequencerContinue: jest.fn(),
  sequencerAbort: jest.fn(),
}

jest.mock("@/hooks/git/use-git-repo", () => ({
  useGitRepo: () => ({
    available: repoCfg.available,
    rootDir: repoCfg.rootDir,
    refresh: repoCfg.refresh,
    openFolder: repoCfg.openFolder,
  }),
}))
jest.mock("@/hooks/git/use-git-actions", () => ({
  useGitActions: () => actionCfg,
}))
jest.mock("@/lib/git/commands", () => ({
  gitInit: jest.fn().mockResolvedValue(undefined),
}))
const openPathAsWorkspace = jest.fn()
jest.mock("@/lib/workspace/open-folder", () => ({
  openPathAsWorkspace: (path: string) => openPathAsWorkspace(path),
}))
jest.mock("@/hooks/ui/use-resizable-layout", () => ({
  useResizableLayout: () => ({ defaultLayout: undefined, onLayoutChanged: jest.fn() }),
}))
const useMediaQueryMock = jest.fn().mockReturnValue(false)
jest.mock("@/hooks/ui/use-media-query", () => ({
  useMediaQuery: (...args: unknown[]) => useMediaQueryMock(...args),
}))
// Stub the resizable wrapper — the real Group measures the DOM, which jsdom
// can't satisfy. Expose size props as data attributes for unit assertions.
jest.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({
    children,
    className,
    orientation,
  }: {
    children: React.ReactNode
    className?: string
    orientation?: string
  }) => (
    <div data-testid="resizable-group" className={className} data-orientation={orientation}>
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
jest.mock("./changes-view", () => ({
  ChangesView: ({
    onSelectFile,
    onViewHistory,
    onViewBlame,
    onRestore,
  }: {
    onSelectFile: (path: string, staged: boolean) => void
    onViewHistory: (path: string) => void
    onViewBlame: (path: string) => void
    onRestore: (path: string) => void
  }) => (
    <div data-testid="changes-view-stub">
      <button
        type="button"
        data-testid="changes-select"
        onClick={() => onSelectFile("a.ts", false)}
      >
        select
      </button>
      <button type="button" data-testid="changes-history" onClick={() => onViewHistory("a.ts")}>
        history
      </button>
      <button type="button" data-testid="changes-blame" onClick={() => onViewBlame("a.ts")}>
        blame
      </button>
      <button type="button" data-testid="changes-restore" onClick={() => onRestore("a.ts")}>
        restore
      </button>
    </div>
  ),
}))
jest.mock("./diff-pane", () => ({ DiffPane: () => <div data-testid="diff-pane-stub" /> }))
jest.mock("./conflict-resolver", () => ({
  ConflictResolver: ({ onResolve }: { onResolve: (resolution: string) => void }) => (
    <button type="button" data-testid="conflict-stub" onClick={() => onResolve("ours")}>
      resolve
    </button>
  ),
}))
jest.mock("./commit-detail", () => ({
  CommitDetail: ({
    onViewBlame,
    onInteractiveRebase,
  }: {
    onViewBlame: (path: string, rev: string) => void
    onInteractiveRebase: (base: string) => void
  }) => (
    <div data-testid="commit-detail-stub">
      <button
        type="button"
        data-testid="commit-detail-blame"
        onClick={() => onViewBlame("a.ts", "abc123")}
      >
        blame
      </button>
      <button
        type="button"
        data-testid="commit-detail-rebase"
        onClick={() => onInteractiveRebase("main")}
      >
        rebase
      </button>
    </div>
  ),
}))
jest.mock("./stash-panel", () => ({
  StashPanel: ({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) =>
    open ? (
      <button type="button" data-testid="stash-panel-stub" onClick={() => onOpenChange(false)}>
        close stash
      </button>
    ) : null,
}))
jest.mock("./timeline-view", () => ({
  TimelineView: ({
    open,
    onOpenChange,
  }: {
    open: boolean
    onOpenChange: (open: boolean) => void
  }) =>
    open ? (
      <button type="button" data-testid="timeline-view-stub" onClick={() => onOpenChange(false)}>
        close timeline
      </button>
    ) : null,
}))
jest.mock("./remote-panel", () => ({
  RemotePanel: ({
    open,
    onOpenChange,
  }: {
    open: boolean
    onOpenChange: (open: boolean) => void
  }) =>
    open ? (
      <button type="button" data-testid="remote-panel-stub" onClick={() => onOpenChange(false)}>
        close remotes
      </button>
    ) : null,
}))
jest.mock("./tag-panel", () => ({
  TagPanel: ({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) =>
    open ? (
      <button type="button" data-testid="tag-panel-stub" onClick={() => onOpenChange(false)}>
        close tags
      </button>
    ) : null,
}))
jest.mock("./compare-refs-sheet", () => ({
  CompareRefsSheet: ({
    open,
    onOpenChange,
  }: {
    open: boolean
    onOpenChange: (open: boolean) => void
  }) =>
    open ? (
      <button type="button" data-testid="compare-panel-stub" onClick={() => onOpenChange(false)}>
        close compare
      </button>
    ) : null,
}))
jest.mock("./restore-dialog", () => ({
  RestoreDialog: ({
    path,
    onOpenChange,
  }: {
    path: string | null
    onOpenChange: (open: boolean) => void
  }) =>
    path ? (
      <button type="button" data-testid="restore-dialog-stub" onClick={() => onOpenChange(false)}>
        close restore
      </button>
    ) : null,
}))
jest.mock("./interactive-rebase-dialog", () => ({
  InteractiveRebaseDialog: ({
    base,
    onOpenChange,
  }: {
    base: string | null
    onOpenChange: (open: boolean) => void
  }) =>
    base ? (
      <button type="button" data-testid="rebase-dialog-stub" onClick={() => onOpenChange(false)}>
        close rebase
      </button>
    ) : null,
}))
jest.mock("./blame-view", () => ({ BlameView: () => <div data-testid="blame-view-stub" /> }))
jest.mock("./branch-header", () => ({
  BranchHeader: () => <div data-testid="branch-header-stub" />,
}))
jest.mock("./sync-toolbar", () => ({
  SyncToolbar: ({
    onOpenStash,
    onOpenTimeline,
    onOpenRemotes,
    onOpenTags,
    onOpenCompare,
    onOpenWorktrees,
    onRefresh,
  }: Record<string, () => void>) => (
    <div data-testid="sync-toolbar-stub">
      <button type="button" onClick={onOpenStash} data-testid="open-stash-stub">
        stash
      </button>
      <button type="button" onClick={onOpenTimeline} data-testid="open-timeline-stub">
        timeline
      </button>
      <button type="button" onClick={onOpenRemotes} data-testid="open-remotes-stub">
        remotes
      </button>
      <button type="button" onClick={onOpenTags} data-testid="open-tags-stub">
        tags
      </button>
      <button type="button" onClick={onOpenCompare} data-testid="open-compare-stub">
        compare
      </button>
      <button type="button" onClick={onOpenWorktrees} data-testid="open-worktrees-stub">
        worktrees
      </button>
      <button type="button" onClick={onRefresh} data-testid="refresh-stub">
        refresh
      </button>
    </div>
  ),
}))
jest.mock("./worktree-panel", () => ({
  WorktreePanel: ({
    open,
    onOpenChange,
  }: {
    open: boolean
    onOpenChange: (open: boolean) => void
  }) =>
    open ? (
      <button type="button" data-testid="worktree-panel-stub" onClick={() => onOpenChange(false)}>
        close worktrees
      </button>
    ) : null,
}))
jest.mock("./clone-repository-dialog", () => ({
  CloneRepositoryDialog: ({
    open,
    onCloned,
  }: {
    open: boolean
    onCloned: (path: string) => void
  }) =>
    open ? (
      <button
        type="button"
        data-testid="clone-dialog-stub"
        onClick={() => onCloned("/work/cloned")}
      >
        clone
      </button>
    ) : null,
}))

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
  repoCfg.refresh.mockClear()
  useMediaQueryMock.mockReset().mockReturnValue(false)
  openPathAsWorkspace.mockReset()
  Object.values(actionCfg).forEach((mock) => mock.mockReset().mockResolvedValue(null))
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

  it("opens clone from the no-folder state and activates the cloned workspace", () => {
    repoCfg.rootDir = null
    render(<SourceControlPanel />)
    fireEvent.click(screen.getByTestId("clone-repo-button"))
    fireEvent.click(screen.getByTestId("clone-dialog-stub"))
    expect(openPathAsWorkspace).toHaveBeenCalledWith("/work/cloned")
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

  it("offers clone alongside init when the bound folder is not a repository", () => {
    act(() =>
      useGitStore.getState().setRepoState({
        isRepo: false,
        rootDir: "/repo",
        detachedHead: false,
        operationInProgress: null,
      })
    )
    render(<SourceControlPanel />)
    fireEvent.click(screen.getByTestId("clone-repo-button"))
    expect(screen.getByTestId("clone-dialog-stub")).toBeInTheDocument()
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

  it("shows a repository loading state before the first status arrives", () => {
    act(() => {
      useGitStore.getState().setStatus(null)
      useGitStore.getState().setLoadingStatus(true)
    })
    render(<SourceControlPanel />)
    expect(screen.getByTestId("sc-loading")).toBeInTheDocument()
  })

  it("surfaces repository load errors and retries in place", () => {
    act(() => {
      useGitStore.getState().setStatus(null)
      useGitStore.getState().setLoadError("credential helper unavailable")
    })
    render(<SourceControlPanel />)
    expect(screen.getByText("credential helper unavailable")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("sc-load-retry"))
    expect(repoCfg.refresh).toHaveBeenCalledTimes(1)
  })

  it("keeps stale repository data visible with a non-blocking refresh error", () => {
    act(() => useGitStore.getState().setLoadError("network changed"))
    render(<SourceControlPanel />)
    expect(screen.getByTestId("sc-load-error-banner")).toBeInTheDocument()
    expect(screen.getByTestId("changes-view-stub")).toBeInTheDocument()
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

  it("stacks the changes and diff panes in narrow desktop windows", () => {
    useMediaQueryMock.mockReturnValue(true)
    render(<SourceControlPanel />)
    expect(screen.getByTestId("resizable-group")).toHaveAttribute("data-orientation", "vertical")
    expect(screen.getByTestId("resizable-panel-sc-changes")).toHaveAttribute(
      "data-default-size",
      "42%"
    )
    expect(screen.getByTestId("resizable-panel-sc-diff")).toHaveAttribute(
      "data-default-size",
      "58%"
    )
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

  it("wires the toolbar worktree action to the worktree panel", () => {
    render(<SourceControlPanel />)
    fireEvent.click(screen.getByTestId("open-worktrees-stub"))
    expect(screen.getByTestId("worktree-panel-stub")).toBeInTheDocument()
  })

  it("wires toolbar actions and closes every auxiliary panel", () => {
    render(<SourceControlPanel />)
    for (const trigger of [
      "open-stash-stub",
      "open-timeline-stub",
      "open-remotes-stub",
      "open-tags-stub",
      "open-compare-stub",
      "open-worktrees-stub",
    ]) {
      fireEvent.click(screen.getByTestId(trigger))
    }
    fireEvent.click(screen.getByTestId("refresh-stub"))
    expect(repoCfg.refresh).toHaveBeenCalled()

    for (const panel of [
      "stash-panel-stub",
      "timeline-view-stub",
      "remote-panel-stub",
      "tag-panel-stub",
      "compare-panel-stub",
      "worktree-panel-stub",
    ]) {
      fireEvent.click(screen.getByTestId(panel))
      expect(screen.queryByTestId(panel)).not.toBeInTheDocument()
    }
  })

  it("wires changes, history, blame, restore, and conflict resolution callbacks", async () => {
    render(<SourceControlPanel />)
    fireEvent.click(screen.getByTestId("changes-select"))
    expect(screen.getByTestId("diff-pane-stub")).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("changes-history"))
    expect(screen.getByTestId("timeline-view-stub")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("timeline-view-stub"))

    fireEvent.click(screen.getByTestId("changes-blame"))
    expect(screen.getByTestId("blame-view-stub")).toBeInTheDocument()
    fireEvent.keyDown(document, { key: "Escape" })

    fireEvent.click(screen.getByTestId("changes-restore"))
    expect(screen.getByTestId("restore-dialog-stub")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("restore-dialog-stub"))

    act(() => useGitStore.getState().selectFile("conf.ts", false))
    await act(async () => {
      fireEvent.click(screen.getByTestId("conflict-stub"))
    })
    expect(actionCfg.resolveConflict).toHaveBeenCalledWith("conf.ts", "ours")
  })

  it("keeps a conflict selected when resolution fails", async () => {
    actionCfg.resolveConflict.mockResolvedValue({
      kind: "commandFailed",
      detail: "file changed while resolving",
    })
    act(() => useGitStore.getState().selectFile("conf.ts", false))
    render(<SourceControlPanel />)

    await act(async () => {
      fireEvent.click(screen.getByTestId("conflict-stub"))
    })

    expect(useGitStore.getState().selectedPath).toBe("conf.ts")
  })

  it("wires commit detail blame and interactive rebase callbacks", () => {
    act(() => useGitStore.getState().selectCommit("abc123"))
    render(<SourceControlPanel />)

    fireEvent.click(screen.getByTestId("commit-detail-blame"))
    expect(screen.getByTestId("blame-view-stub")).toBeInTheDocument()
    fireEvent.keyDown(document, { key: "Escape" })

    fireEvent.click(screen.getByTestId("commit-detail-rebase"))
    expect(screen.getByTestId("rebase-dialog-stub")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("rebase-dialog-stub"))
  })

  it("wires sequencer controls to their actions", () => {
    act(() =>
      useGitStore.getState().setRepoState({
        isRepo: true,
        rootDir: "/repo",
        detachedHead: false,
        operationInProgress: "rebase",
      })
    )
    render(<SourceControlPanel />)
    fireEvent.click(screen.getByTestId("sequencer-continue"))
    fireEvent.click(screen.getByTestId("sequencer-abort"))
    expect(actionCfg.sequencerContinue).toHaveBeenCalled()
    expect(actionCfg.sequencerAbort).toHaveBeenCalled()
  })
})
