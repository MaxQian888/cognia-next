/** @jest-environment jsdom */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

let backendAvailable = true
let session:
  { id: string; projectId?: string; executionContext?: Record<string, unknown> } | undefined
let projects: Array<{
  id: string
  roots: Array<{ id: string; path: string; isPrimary?: boolean }>
}> = []
let gitState: Record<string, unknown> = {}

const openFile = jest.fn().mockResolvedValue(undefined)
const clearReveal = jest.fn()
const selectRoot = jest.fn()
const closeFile = jest.fn()
const setActivePath = jest.fn()
const setDraft = jest.fn()
const saveFile = jest.fn().mockResolvedValue(undefined)
const saveAll = jest.fn().mockResolvedValue(undefined)
const mockUseProjectEditor = jest.fn()
let activePath: string | null = null
let editorRootKey = "/repo"
let editorRootPath = "/repo"
let editorRoots = [{ key: "/repo", label: "main", path: "/repo", isMain: true }]
let editorPinned = false
const resumeFollow = jest.fn()
interface TestOpenFile {
  absolutePath: string
  relPath: string
  language: string
  savedContent: string
  draftContent: string
  draftVersion: number
}
let activeFile: TestOpenFile | null = null
let openFiles: TestOpenFile[] = []

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/lib/files/workspace-backend", () => ({
  hasWorkspaceFsBackend: () => backendAvailable,
}))

jest.mock("@/lib/tauri", () => ({ isTauri: () => true }))
// Task Workspace is GA (no developer flag), so the task-discovery effect runs
// on every mount. These tests cover the editor dock, not task scope: resolve to
// "this session has no task workspace" and the dock renders its normal surface.
jest.mock("@/lib/task-workspace/client", () => ({
  listTaskWorkspaces: jest.fn(async () => []),
  listTaskRuns: jest.fn(async () => []),
}))

const supportedMock = jest.fn<Promise<boolean>, []>()
const driveOpenMock = jest.fn().mockResolvedValue(undefined)
const cliOpenFileMock = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/codeserver/client", () => ({
  codeServerClient: {
    supported: () => supportedMock(),
    driveOpen: (...args: unknown[]) => driveOpenMock(...args),
    openFile: (...args: unknown[]) => cliOpenFileMock(...args),
  },
}))
jest.mock("@/components/editor/project/editor-engine-toggle", () => ({
  EditorEngineToggle: ({
    onChange,
    proIdeSupport,
  }: {
    onChange: (value: "codeserver") => void
    proIdeSupport: string
  }) => (
    <button
      data-testid="mock-engine-toggle"
      data-support={proIdeSupport}
      onClick={() => onChange("codeserver")}
    />
  ),
}))
jest.mock("@/components/editor/project/code-server-pane", () => ({
  CodeServerPane: ({
    root,
    ownerId,
    beforeOpen,
  }: {
    root: string
    ownerId: string
    beforeOpen?: () => void
  }) => (
    <button
      data-testid="mock-code-server"
      data-root={root}
      data-owner={ownerId}
      onClick={beforeOpen}
    />
  ),
  joinProjectPath: (root: string, relative: string) => {
    const base = root.replace(/[/\\]+$/, "")
    const clean = relative.replace(/^[/\\]+/, "")
    return clean ? `${base}/${clean}` : base
  },
}))

jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: () => session,
}))

jest.mock("@/lib/db/sessions", () => ({ getSession: jest.fn() }))

jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: (selector: (state: { projects: typeof projects }) => unknown) =>
    selector({ projects }),
}))

jest.mock("@/stores/canvas/keybinding-store", () => ({
  useKeybindingStore: (selector: (state: { bindings: Record<string, string> }) => unknown) =>
    selector({ bindings: {} }),
}))

jest.mock("@/components/editor/project/use-project-editor", () => ({
  useProjectEditor: (args: unknown) => {
    mockUseProjectEditor(args)
    return {
      deps: {},
      roots: editorRoots,
      rootKey: editorRootKey,
      rootPath: editorRootPath,
      openFiles,
      activePath,
      activeFile,
      dirtyCount: 0,
      treeRefreshToken: 0,
      selectRoot,
      openFile,
      closeFile,
      setActivePath,
      setDraft,
      saveFile,
      saveAll,
      pinned: editorPinned,
      resumeFollow,
    }
  },
}))

jest.mock("@/components/editor/project/project-root-switcher", () => ({
  ProjectRootSwitcher: ({
    onSelect,
    followedRoot,
  }: {
    onSelect: (key: string) => void
    followedRoot?: string | null
  }) => (
    <button
      data-testid="root-switcher"
      data-followed={followedRoot ?? ""}
      onClick={() => onSelect("/other")}
    >
      root
    </button>
  ),
}))
jest.mock("@/components/editor/project/project-editor-tabs", () => ({
  ProjectEditorTabs: ({
    fixedTabs = [],
    trailingContent,
    onSelect,
    onClose,
    onSaveAll,
  }: {
    fixedTabs?: Array<{ id: string; onSelect: () => void }>
    trailingContent?: React.ReactNode
    onSelect: (path: string) => void
    onClose: (path: string) => void
    onSaveAll: () => void
  }) => (
    <div data-testid="editor-tabs" data-fixed={fixedTabs.map((tab) => tab.id).join(",")}>
      {fixedTabs.map((tab) => (
        <button key={tab.id} data-testid={`fixed-${tab.id}`} onClick={tab.onSelect}>
          {tab.id}
        </button>
      ))}
      <button data-testid="select-file" onClick={() => onSelect("src/a.ts")}>
        file
      </button>
      <button data-testid="close-file" onClick={() => onClose("src/a.ts")}>
        close
      </button>
      <button data-testid="save-all" onClick={onSaveAll}>
        save all
      </button>
      {trailingContent}
    </div>
  ),
}))
jest.mock("@/components/editor/project/project-file-tree", () => ({
  ProjectFileTree: ({ onOpenFile }: { onOpenFile: (path: string) => void }) => (
    <button data-testid="file-tree" onClick={() => onOpenFile("src/tree.ts")}>
      tree
    </button>
  ),
}))
jest.mock("@/components/editor/project/project-search-panel", () => ({
  ProjectSearchPanel: ({
    onOpenMatch,
  }: {
    onOpenMatch: (path: string, line: number, column: number) => void
  }) => (
    <button data-testid="search-panel" onClick={() => onOpenMatch("src/search.ts", 3, 4)}>
      search
    </button>
  ),
}))
jest.mock("@/components/editor/project/project-monaco", () => ({
  ProjectMonaco: ({
    onChange,
    actions,
  }: {
    onChange: (value: string) => void
    actions: Array<{ id: string; run?: () => void }>
  }) => (
    <div data-testid="monaco">
      <button onClick={() => onChange("updated")}>change</button>
      {actions.map((action) => (
        <button key={action.id} data-testid={`action-${action.id}`} onClick={action.run}>
          {action.id}
        </button>
      ))}
    </div>
  ),
}))

jest.mock("@/components/editor/project/project-context-workbench", () => ({
  ProjectContextWorkbench: () => <div data-testid="project-context-workbench" />,
  ProjectContextWorkbenchMobile: () => <div data-testid="project-context-workbench-mobile" />,
}))

jest.mock("@/stores/git/git-store", () => ({
  useGitStore: (selector: (state: Record<string, unknown>) => unknown) => selector(gitState),
}))
jest.mock("@/hooks/git/use-git-actions", () => ({ useGitActions: () => ({}) }))
jest.mock("@/lib/git/load", () => ({ refreshGitStatus: jest.fn() }))
jest.mock("@/components/source-control/changes-view", () => ({
  ChangesView: ({
    onSelectFile,
    density,
  }: {
    onSelectFile: (path: string, staged: boolean) => void
    density?: string
  }) => (
    <button
      data-testid="review-changes"
      data-density={density}
      onClick={() => onSelectFile("src/a.ts", false)}
    />
  ),
}))
jest.mock("@/components/source-control/diff-pane", () => ({
  DiffPane: ({ density }: { density?: string }) => (
    <div data-testid="review-diff" data-density={density} />
  ),
}))

import { DockWorkspace } from "./dock-workspace"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import { useProjectEditorSessionStore } from "@/stores/editor/project-editor-session-store"
import { PROJECT_EDITOR_GOTO_EVENT } from "@/components/editor/project/editor-events"

beforeEach(() => {
  backendAvailable = true
  session = { id: "session-1", projectId: "project-1" }
  projects = [{ id: "project-1", roots: [{ id: "root-1", path: "/repo", isPrimary: true }] }]
  gitState = {
    rootDir: "/repo",
    repoState: { isRepo: true },
    status: {
      staged: [],
      changes: [],
      merge: [],
    },
    selectedPath: "src/a.ts",
    selectedStaged: false,
    ops: { commit: false },
    selectFile: jest.fn(),
  }
  openFile.mockClear()
  clearReveal.mockClear()
  selectRoot.mockClear()
  closeFile.mockClear()
  setActivePath.mockClear()
  setDraft.mockClear()
  saveFile.mockClear().mockResolvedValue(undefined)
  saveAll.mockClear().mockResolvedValue(undefined)
  mockUseProjectEditor.mockClear()
  supportedMock.mockReset().mockImplementation(() => new Promise(() => {}))
  driveOpenMock.mockClear().mockResolvedValue(undefined)
  cliOpenFileMock.mockClear().mockResolvedValue(undefined)
  activePath = null
  editorRootKey = "/repo"
  editorRootPath = "/repo"
  editorRoots = [{ key: "/repo", label: "main", path: "/repo", isMain: true }]
  editorPinned = false
  resumeFollow.mockClear()
  activeFile = null
  openFiles = []
  act(() => useArtifactDockLayoutStore.getState().resetLayout())
  act(() => useProjectEditorSessionStore.setState({ sessions: {} }))
  useArtifactDockLayoutStore.setState({ clearWorkspaceRevealRequest: clearReveal })
})

describe("DockWorkspace", () => {
  it("shows an explicit unavailable empty state without a filesystem backend", () => {
    backendAvailable = false
    render(<DockWorkspace activeSessionId="session-1" />)
    expect(screen.getByTestId("workspace-unavailable")).toBeInTheDocument()
  })

  it("distinguishes missing session, project, and root states", () => {
    session = undefined
    const { rerender } = render(<DockWorkspace activeSessionId="missing" />)
    expect(screen.getByTestId("workspace-session-missing")).toBeInTheDocument()

    session = { id: "session-1", projectId: "missing-project" }
    rerender(<DockWorkspace activeSessionId="session-1" />)
    expect(screen.getByTestId("workspace-project-missing")).toBeInTheDocument()

    projects = [{ id: "missing-project", roots: [] }]
    rerender(<DockWorkspace activeSessionId="session-1" />)
    expect(screen.getByTestId("workspace-root-missing")).toBeInTheDocument()
  })

  it("always names the directory it is looking at, even with a single root", () => {
    // A panel that silently retargets is worse than one that needs a click. The
    // toolbar used to disappear entirely when there was nothing to switch
    // between, which is exactly the case where the user has no other way to
    // learn which tree the editor is on.
    render(<DockWorkspace activeSessionId="session-1" />)

    expect(screen.getByTestId("dock-workspace-toolbar")).toBeInTheDocument()
    expect(screen.getByTestId("panel-root-name")).toHaveTextContent("repo")
  })

  it("follows the conversation's worktree rather than the workspace root", () => {
    session = {
      id: "session-1",
      projectId: "project-1",
      executionContext: {
        location: "managedWorktree",
        projectRoot: "/repo",
        workspaceBinding: { kind: "managed", workspaceId: "ws-1" },
        managedWorkspace: { availability: "available", localRoot: "/repo/.wt/feature" },
      },
    }
    render(<DockWorkspace activeSessionId="session-1" />)

    // Discovery still enumerates worktrees from the REPOSITORY...
    expect(mockUseProjectEditor).toHaveBeenCalledWith(
      expect.objectContaining({ workingDir: "/repo", followedRoot: "/repo/.wt/feature" })
    )
    // ...and the switcher marks which entry means "follow".
    expect(screen.getByTestId("root-switcher")).toHaveAttribute(
      "data-followed",
      "/repo/.wt/feature"
    )
    // The chip says it is a worktree alias, not an ordinary checkout.
    expect(screen.getByTestId("panel-root-chip")).toHaveAttribute("data-managed", "true")
  })

  it("offers resume-follow only once the selection diverges", () => {
    render(<DockWorkspace activeSessionId="session-1" />)
    // Following: the root switcher is how you pin, so a pin control here would
    // be a dead affordance.
    expect(screen.queryByTestId("panel-root-pin")).not.toBeInTheDocument()

    editorPinned = true
    editorRootKey = "/repo/.wt/feature"
    editorRootPath = "/repo/.wt/feature"
    editorRoots = [
      { key: "/repo", label: "main", path: "/repo", isMain: true },
      { key: "/repo/.wt/feature", label: "feature", path: "/repo/.wt/feature", isMain: false },
    ]
    render(<DockWorkspace activeSessionId="session-1" />)

    const chips = screen.getAllByTestId("panel-root-chip")
    const pinnedChip = chips[chips.length - 1]!
    expect(pinnedChip).toHaveAttribute("data-source", "pinned")
    // A pin onto a worktree is still a worktree — the roots list is the only
    // thing that knows that, so the panel corrects the resolver's answer.
    expect(pinnedChip).toHaveAttribute("data-managed", "true")
  })

  it("keeps the workspace surfaces inside a resized workbench", () => {
    render(<DockWorkspace activeSessionId="session-1" />)

    expect(screen.getByTestId("dock-workspace")).toHaveClass(
      "w-full",
      "min-w-0",
      "max-w-full",
      "overflow-x-hidden"
    )
    expect(screen.getByTestId("workspace-file-layout")).toHaveClass(
      "min-w-0",
      "max-w-full",
      "overflow-hidden"
    )
  })

  it("consumes a queued file reveal after mounting the editor", async () => {
    const gotoListener = jest.fn()
    window.addEventListener(PROJECT_EDITOR_GOTO_EVENT, gotoListener)
    act(() => {
      useArtifactDockLayoutStore.getState().revealWorkspaceFile({
        sessionId: "split-session",
        rootPath: "/repo",
        relPath: "src/a.ts",
        line: 7,
        column: 2,
      })
    })

    render(<DockWorkspace activeSessionId="session-1" />)

    await waitFor(() => expect(openFile).toHaveBeenCalledWith("src/a.ts"))
    await waitFor(() =>
      expect(gotoListener).toHaveBeenCalledWith(
        expect.objectContaining({ detail: { relPath: "src/a.ts", line: 7, column: 2 } })
      )
    )
    expect(clearReveal).toHaveBeenCalledWith(expect.stringMatching(/^workspace-reveal-/))
    expect(screen.getByTestId("workspace-file-layout")).toBeInTheDocument()
    expect(screen.getByTestId("file-tree")).toBeInTheDocument()
    expect(mockUseProjectEditor).toHaveBeenCalledWith(
      expect.objectContaining({ scopeKey: "session:split-session", workingDir: "/repo" })
    )
    window.removeEventListener(PROJECT_EDITOR_GOTO_EVENT, gotoListener)
  })

  it("opens the fixed review surface only for the bound Git repository", async () => {
    act(() => {
      useArtifactDockLayoutStore.getState().revealWorkspaceReview({
        sessionId: "session-1",
        rootPath: "/repo",
      })
    })

    render(<DockWorkspace activeSessionId="session-1" />)

    expect(await screen.findByTestId("workspace-review-layout")).toBeInTheDocument()
    expect(screen.getByTestId("editor-tabs")).toHaveAttribute("data-fixed", "review")
    expect(screen.getByTestId("review-changes")).toBeInTheDocument()
    expect(screen.getByTestId("review-diff")).toBeInTheDocument()
    expect(screen.queryByTestId("file-tree")).not.toBeInTheDocument()
  })

  it("keeps the review tab and engine toggle on the same toolbar row", () => {
    render(<DockWorkspace activeSessionId="session-1" />)

    expect(screen.getByTestId("editor-tabs")).toContainElement(
      screen.getByTestId("mock-engine-toggle")
    )
  })

  it("preselects a requested working-tree file in the review surface", async () => {
    act(() => {
      useArtifactDockLayoutStore.getState().revealWorkspaceReview({
        sessionId: "session-1",
        rootPath: "/repo",
        relPath: "src/edited.ts",
      })
    })

    render(<DockWorkspace activeSessionId="session-1" />)

    expect(await screen.findByTestId("workspace-review-layout")).toBeInTheDocument()
    expect(gitState.selectFile).toHaveBeenCalledWith("src/edited.ts", false)
  })

  it("selects the requested root before consuming a reveal", async () => {
    editorRootPath = "/repo-wt"
    act(() => {
      useArtifactDockLayoutStore.getState().revealWorkspaceFile({
        sessionId: "session-1",
        rootPath: "/repo",
        relPath: "src/a.ts",
      })
    })

    const { rerender } = render(<DockWorkspace activeSessionId="session-1" />)
    expect(selectRoot).toHaveBeenCalledWith("/repo")
    expect(openFile).not.toHaveBeenCalled()

    editorRootPath = "/repo"
    rerender(<DockWorkspace activeSessionId="session-1" />)
    await waitFor(() => expect(openFile).toHaveBeenCalledWith("src/a.ts"))
  })

  it("waits for persisted worktree discovery before consuming a primary-root reveal", async () => {
    editorRootKey = "/repo-wt"
    editorRootPath = "/repo"
    act(() => {
      useArtifactDockLayoutStore.getState().revealWorkspaceFile({
        sessionId: "session-1",
        rootPath: "/repo",
        relPath: "src/a.ts",
      })
    })

    const { rerender } = render(<DockWorkspace activeSessionId="session-1" />)
    expect(selectRoot).toHaveBeenCalledWith("/repo")
    expect(openFile).not.toHaveBeenCalled()

    editorRootKey = "/repo"
    rerender(<DockWorkspace activeSessionId="session-1" />)
    await waitFor(() => expect(openFile).toHaveBeenCalledWith("src/a.ts"))
  })

  it("does not expose the review tab for a non-Git root", () => {
    gitState = { ...gitState, repoState: { isRepo: false } }
    render(<DockWorkspace activeSessionId="session-1" />)

    expect(screen.getByTestId("editor-tabs")).toHaveAttribute("data-fixed", "")
    expect(screen.getByTestId("workspace-file-layout")).toBeInTheDocument()
    expect(screen.queryByTestId("workspace-review-layout")).not.toBeInTheDocument()
  })

  it("keeps the review surface active while Git status is unavailable", async () => {
    gitState = { ...gitState, status: null }
    act(() => {
      useArtifactDockLayoutStore.getState().revealWorkspaceReview({
        sessionId: "session-1",
        rootPath: "/repo",
      })
    })

    render(<DockWorkspace activeSessionId="session-1" />)

    expect(await screen.findByTestId("workspace-review-layout")).toBeInTheDocument()
    expect(screen.queryByTestId("workspace-file-layout")).not.toBeInTheDocument()
    expect(screen.queryByTestId("monaco")).not.toBeInTheDocument()
  })

  it("flips to review once Git hydrates for a reveal fired before it loaded", async () => {
    // Git not yet resolved for this root — hasReview is false at reveal time,
    // which previously locked the surface onto the file view permanently.
    gitState = { ...gitState, repoState: undefined }
    const { rerender } = render(<DockWorkspace activeSessionId="session-1" />)
    act(() => {
      useArtifactDockLayoutStore.getState().revealWorkspaceReview({
        sessionId: "session-1",
        rootPath: "/repo",
        relPath: "src/a.ts",
      })
    })
    // While git is unresolved the file surface shows (review needs a repo).
    expect(await screen.findByTestId("workspace-file-layout")).toBeInTheDocument()

    // Once git hydrates the surface flips to review instead of staying stuck.
    gitState = { ...gitState, repoState: { isRepo: true }, rootDir: "/repo" }
    rerender(<DockWorkspace activeSessionId="session-1" />)
    expect(await screen.findByTestId("workspace-review-layout")).toBeInTheDocument()
    expect(screen.queryByTestId("workspace-file-layout")).not.toBeInTheDocument()
  })

  it("uses a single-column Changes/Diff review flow on mobile", async () => {
    act(() => {
      useArtifactDockLayoutStore.getState().revealWorkspaceReview({
        sessionId: "session-1",
        rootPath: "/repo",
      })
    })

    render(<DockWorkspace activeSessionId="session-1" layout="mobile" />)

    expect(await screen.findByTestId("workspace-mobile-review-tabs")).toBeInTheDocument()
    expect(screen.getByTestId("review-changes")).toHaveAttribute("data-density", "touch")
    expect(screen.queryByTestId("review-diff")).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId("review-changes"))
    expect(screen.getByTestId("review-diff")).toHaveAttribute("data-density", "touch")
    fireEvent.click(screen.getByTestId("workspace-mobile-review-diff"))
    expect(screen.getByTestId("review-diff")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("workspace-mobile-review-changes"))
    expect(screen.getByTestId("review-changes")).toBeInTheDocument()
  })

  it("wires editor tabs, sidebar, file actions, and keyboard saves", async () => {
    editorRoots = [
      { key: "/repo", label: "main", path: "/repo", isMain: true },
      { key: "/other", label: "other", path: "/other", isMain: false },
    ]
    activePath = "src/a.ts"
    activeFile = {
      absolutePath: "/repo/src/a.ts",
      relPath: "src/a.ts",
      language: "typescript",
      savedContent: "old",
      draftContent: "old",
      draftVersion: 1,
    }
    openFiles = [activeFile]
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: jest.fn() },
    })

    render(<DockWorkspace activeSessionId="session-1" />)

    expect(screen.queryByTestId("project-context-workbench")).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId("root-switcher"))
    fireEvent.click(screen.getByTestId("fixed-review"))
    fireEvent.click(screen.getByTestId("select-file"))
    fireEvent.click(screen.getByTestId("close-file"))
    fireEvent.click(screen.getByTestId("save-all"))
    expect(selectRoot).toHaveBeenCalledWith("/other")
    expect(setActivePath).toHaveBeenCalledWith("src/a.ts")
    expect(closeFile).toHaveBeenCalledWith("src/a.ts")

    fireEvent.click(screen.getByTestId("file-tree"))
    expect(openFile).toHaveBeenCalledWith("src/tree.ts", undefined)
    fireEvent.click(screen.getByText("searchTab"))
    fireEvent.click(screen.getByTestId("search-panel"))
    expect(openFile).toHaveBeenCalledWith("src/search.ts")

    fireEvent.click(screen.getByTestId("action-file.save"))
    fireEvent.click(screen.getByTestId("action-file.copyPath"))
    fireEvent.click(screen.getByTestId("action-file.copyRelativePath"))
    fireEvent.click(screen.getByTestId("action-file.searchProject"))
    fireEvent.click(screen.getByText("filesTab"))
    fireEvent.click(screen.getByText("searchTab"))

    fireEvent.click(screen.getByText("change"))
    expect(setDraft).toHaveBeenCalledWith("src/a.ts", "updated")
    fireEvent.keyDown(screen.getByTestId("dock-workspace"), { key: "s", metaKey: true })
    fireEvent.keyDown(screen.getByTestId("dock-workspace"), {
      key: "s",
      ctrlKey: true,
      shiftKey: true,
    })
    await waitFor(() => {
      expect(saveFile).toHaveBeenCalledWith("src/a.ts")
      expect(saveAll).toHaveBeenCalled()
    })
  })

  it("hands the desktop workspace editor to Pro IDE without keeping Monaco routing", async () => {
    supportedMock.mockResolvedValue(true)
    render(<DockWorkspace activeSessionId="session-1" />)

    await waitFor(() =>
      expect(screen.getByTestId("mock-engine-toggle")).toHaveAttribute("data-support", "supported")
    )
    fireEvent.click(screen.getByTestId("mock-engine-toggle"))

    expect(screen.getByTestId("mock-code-server")).toHaveAttribute("data-root", "/repo")
    expect(screen.getByTestId("mock-code-server")).toHaveAttribute(
      "data-owner",
      "session:session-1"
    )
    expect(screen.queryByTestId("monaco")).not.toBeInTheDocument()
  })

  it("routes a file reveal to code-server (not Monaco) when Pro IDE is the engine", async () => {
    const gotoListener = jest.fn()
    window.addEventListener(PROJECT_EDITOR_GOTO_EVENT, gotoListener)
    act(() =>
      useProjectEditorSessionStore.getState().setSession("session:session-1", {
        editorMode: "codeserver",
      })
    )
    act(() => {
      useArtifactDockLayoutStore.getState().revealWorkspaceFile({
        sessionId: "session-1",
        rootPath: "/repo",
        relPath: "src/a.ts",
        line: 7,
        column: 2,
      })
    })

    render(<DockWorkspace activeSessionId="session-1" />)

    // A3: the reveal drives the live code-server by ABSOLUTE path; Monaco's
    // `gotoLine` (which dispatches the goto event) must NOT fire.
    await waitFor(() => expect(driveOpenMock).toHaveBeenCalledWith("/repo", "/repo/src/a.ts", 7, 2))
    expect(gotoListener).not.toHaveBeenCalled()
    expect(clearReveal).toHaveBeenCalled()
    window.removeEventListener(PROJECT_EDITOR_GOTO_EVENT, gotoListener)
  })

  it("keeps the Pro IDE capability host mounted while review is active", async () => {
    act(() =>
      useProjectEditorSessionStore.getState().setSession("session:session-1", {
        editorMode: "codeserver",
      })
    )
    act(() => {
      useArtifactDockLayoutStore.getState().revealWorkspaceReview({
        sessionId: "session-1",
        rootPath: "/repo",
      })
    })

    render(<DockWorkspace activeSessionId="session-1" />)

    expect(await screen.findByTestId("workspace-review-layout")).toBeInTheDocument()
    expect(screen.getByTestId("mock-code-server")).toBeInTheDocument()
    expect(screen.getByTestId("workspace-code-server-host")).toHaveAttribute("data-active", "false")

    fireEvent.click(screen.getByTestId("mock-code-server"))

    expect(screen.queryByTestId("workspace-review-layout")).not.toBeInTheDocument()
    expect(screen.getByTestId("workspace-code-server-host")).toHaveAttribute("data-active", "true")
  })
})
