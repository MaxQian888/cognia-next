/** @jest-environment jsdom */

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"

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
  monacoLanguage?: string
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

// The factory owns the flag rather than closing over a module-level `let`:
// `jest.mock` is hoisted above every declaration in this file, and `isTauri()`
// is called during module load (the keyring store reads it), so a `let` is
// still in its temporal dead zone by then and the whole suite fails to load.
jest.mock("@/lib/tauri", () => {
  const state = { inTauri: true }
  return { isTauri: () => state.inTauri, __setInTauri: (next: boolean) => (state.inTauri = next) }
})
const setInTauri = (next: boolean) =>
  (jest.requireMock("@/lib/tauri") as { __setInTauri: (v: boolean) => void }).__setInTauri(next)
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
    labelClassName,
  }: {
    onChange: (value: "codeserver") => void
    proIdeSupport: string
    labelClassName?: string
  }) => (
    <button
      data-testid="mock-engine-toggle"
      data-support={proIdeSupport}
      data-label-class={labelClassName}
      onClick={() => onChange("codeserver")}
    />
  ),
}))
// Task scope swaps the editor for the task's resources; only the switch
// between the two is under test here.
jest.mock("./task-resources-panel", () => ({
  TaskResourcesPanel: () => <div data-testid="task-resources-panel" />,
}))
// The phone preview's own reads and states are covered beside it; here only
// the hand-off (what it is asked to show, Back, Edit) is under test.
jest.mock("./workspace-file-preview", () => ({
  WorkspaceFilePreview: ({
    root,
    relPath,
    line,
    onBack,
    onOpenInEditor,
  }: {
    root: string
    relPath: string
    line?: number
    onBack: () => void
    onOpenInEditor: () => void
  }) => (
    <div data-testid="mock-file-preview" data-root={root} data-rel={relPath} data-line={line}>
      <button data-testid="mock-preview-back" onClick={onBack} />
      <button data-testid="mock-preview-edit" onClick={onOpenInEditor} />
    </div>
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

jest.mock("@/components/editor/project/code-server-web-pane", () => ({
  CodeServerWebPane: ({ root }: { root: string }) => (
    <div data-testid="mock-code-server-web" data-root={root} />
  ),
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
      previewPath: null,
      dirtyCount: 0,
      treeRefreshToken: 0,
      selectRoot,
      openFile,
      isPathOpen: (relPath: string) =>
        openFiles.some((f) => f.relPath === relPath) || relPath === activePath,
      pinFile: jest.fn(),
      closeFile,
      closeFiles: jest.fn(),
      moveOpenFile: jest.fn(),
      closeAllFiles: jest.fn(),
      reopenClosedFile: jest.fn(),
      setActivePath,
      setDraft,
      saveFile,
      saveAll,
      reloadFile: jest.fn().mockResolvedValue(undefined),
      renameOpenFile: jest.fn().mockResolvedValue(undefined),
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
// The tab strips belong to the editor groups inside the workbench now; the
// dock keeps only its toolbar (root, surface switch, engine, scope).
jest.mock("@/components/editor/project/project-editor-tabs", () => ({
  EDITOR_TAB_DRAG_MIME: "application/x-cognia-editor-tab",
  ProjectEditorTabs: ({
    onSelect,
    onClose,
    onSaveAll,
  }: {
    onSelect: (path: string) => void
    onClose: (path: string) => void
    onSaveAll: () => void
  }) => (
    <div data-testid="editor-tabs">
      <button data-testid="select-file" onClick={() => onSelect("src/a.ts")}>
        file
      </button>
      <button data-testid="close-file" onClick={() => onClose("src/a.ts")}>
        close
      </button>
      <button data-testid="save-all" onClick={onSaveAll}>
        save all
      </button>
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

// The decoration hook otherwise calls the real git transport and resolves
// outside act(); an empty result keeps the suite quiet and badge-free.
jest.mock("@/components/editor/project/use-project-git-status", () => ({
  useProjectGitStatus: () => ({ branch: null, byPath: new Map() }),
}))
jest.mock("@/components/editor/project/project-quick-open", () => ({
  ProjectQuickOpen: () => null,
}))
jest.mock("@/components/editor/project/project-editor-breadcrumbs", () => ({
  ProjectEditorBreadcrumbs: () => null,
}))
jest.mock("@/components/editor/project/project-editor-status-bar", () => ({
  ProjectEditorStatusBar: () => null,
}))
jest.mock("@/components/editor/project/project-file-fallback", () => ({
  ProjectFileFallback: () => null,
}))

jest.mock("@/components/editor/project/project-context-workbench", () => ({
  ProjectContextWorkbench: () => <div data-testid="project-context-workbench" />,
  ProjectContextWorkbenchMobile: () => <div data-testid="project-context-workbench-mobile" />,
}))

// Production mounts TooltipProvider in app/layout; the bare DockWorkspace
// render needs the tooltip primitives to pass through instead of demanding it.
jest.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}))

jest.mock("@/stores/git/git-store", () => ({
  useGitStore: (selector: (state: Record<string, unknown>) => unknown) => selector(gitState),
}))
jest.mock("@/hooks/git/use-git-actions", () => ({ useGitActions: () => ({}) }))
jest.mock("@/components/source-control/commit-box", () => ({
  CommitBox: () => <div data-testid="review-commit-box" />,
}))
jest.mock("@/hooks/git/use-conversation-changed-paths", () => ({
  useConversationChangedPaths: () => ({ paths: new Set<string>(), ready: true }),
}))
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
  DiffPane: ({
    density,
    path,
    staged,
    leading,
    onOpenInEditor,
    reviewDefaultCollapsed,
  }: {
    density?: string
    path: string
    staged: boolean
    leading?: React.ReactNode
    onOpenInEditor?: (path: string, line?: number) => void
    reviewDefaultCollapsed?: boolean
  }) => (
    <div
      data-testid="review-diff"
      data-density={density}
      data-path={path}
      data-staged={String(staged)}
      data-review-collapsed={String(Boolean(reviewDefaultCollapsed))}
    >
      {leading}
      <button data-testid="review-diff-open" onClick={() => onOpenInEditor?.(path, 12)} />
    </div>
  ),
}))

import { DockWorkspace } from "./dock-workspace"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import { useProjectEditorSessionStore } from "@/stores/editor/project-editor-session-store"
import { useTaskWorkspaceStore } from "@/stores/task-workspace-store"
import { PROJECT_EDITOR_GOTO_EVENT } from "@/components/editor/project/editor-events"

beforeEach(() => {
  setInTauri(true)
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
  act(() => useTaskWorkspaceStore.setState({ activeBySession: {} }))
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
    expect(screen.getByTestId("workspace-surface-review")).toHaveAttribute("data-state", "on")
    expect(screen.getByTestId("workspace-surface-file")).toHaveAttribute("data-state", "off")
    expect(screen.getByTestId("review-changes")).toBeInTheDocument()
    // The dock's conversation scopes the review and commits from under the list.
    expect(screen.getByTestId("workspace-review-scope")).toBeInTheDocument()
    expect(screen.getByTestId("review-commit-box")).toBeInTheDocument()
    expect(screen.getByTestId("review-diff")).toBeInTheDocument()
    expect(screen.getByTestId("file-tree")).not.toBeVisible()
  })

  it("keeps the surface switch and engine toggle on the one toolbar row", () => {
    render(<DockWorkspace activeSessionId="session-1" />)

    const toolbar = screen.getByTestId("dock-workspace-toolbar")
    expect(toolbar).toContainElement(screen.getByTestId("workspace-surface-switch"))
    expect(toolbar).toContainElement(screen.getByTestId("mock-engine-toggle"))
    // The editor's own tab strips live inside the workbench, not in the dock.
    expect(toolbar).not.toContainElement(screen.getByTestId("editor-tabs"))
  })

  describe("one toolbar row across the dock's width range", () => {
    const activateTask = () =>
      act(() =>
        useTaskWorkspaceStore.setState({
          activeBySession: {
            "session-1": {
              taskId: "task-1",
              runId: "run-1",
              sessionId: "session-1",
              workspaceRoot: "/repo",
              executionRoot: "/repo",
              state: "running",
            },
          },
        })
      )

    it("folds the switch labels to icons by the dock's width instead of wrapping", () => {
      activateTask()
      render(<DockWorkspace activeSessionId="session-1" />)

      // Container queries read the dock, not the window it sits in.
      expect(screen.getByTestId("dock-workspace")).toHaveClass("@container/dock-ws")
      const toolbar = screen.getByTestId("dock-workspace-toolbar")
      expect(toolbar).toHaveClass("flex-nowrap")
      expect(toolbar).not.toHaveClass("flex-wrap")

      // The scope switch loses its words first (below 48rem)…
      for (const [testId, label] of [
        ["workspace-scope-task", "currentTask"],
        ["workspace-scope-all", "allWorkspace"],
      ]) {
        const item = screen.getByTestId(testId)
        expect(item).toHaveAttribute("aria-label", label)
        expect(item).toHaveAttribute("title", label)
        expect(item.querySelector("svg")).not.toBeNull()
        expect(within(item).getByText(label)).toHaveClass("hidden", "@3xl/dock-ws:inline")
      }

      // …the Editor/Review switch last (below 42rem), keeping its count badge.
      fireEvent.click(screen.getByTestId("workspace-scope-all"))
      const fileItem = screen.getByTestId("workspace-surface-file")
      expect(fileItem).toHaveAttribute("title", "editorTab")
      expect(within(fileItem).getByText("editorTab")).toHaveClass("hidden", "@2xl/dock-ws:inline")
      const reviewItem = screen.getByTestId("workspace-surface-review")
      expect(reviewItem).toHaveAttribute("title", "review")
      expect(within(reviewItem).getByText("review")).toHaveClass("hidden", "@2xl/dock-ws:inline")
      // The engine switch folds with the scope switch.
      expect(screen.getByTestId("mock-engine-toggle")).toHaveAttribute(
        "data-label-class",
        "hidden @3xl/dock-ws:inline"
      )
    })

    it("keeps the words and wraps instead on a phone", () => {
      activateTask()
      render(<DockWorkspace activeSessionId="session-1" layout="mobile" />)

      expect(screen.getByTestId("dock-workspace-toolbar")).toHaveClass("flex-wrap")
      const task = screen.getByTestId("workspace-scope-task")
      expect(task).not.toHaveAttribute("title")
      expect(within(task).getByText("currentTask")).not.toHaveClass("hidden")
    })
  })

  describe("reveals while a task is in scope", () => {
    const activateTask = () =>
      act(() =>
        useTaskWorkspaceStore.setState({
          activeBySession: {
            "session-1": {
              taskId: "task-1",
              runId: "run-1",
              sessionId: "session-1",
              workspaceRoot: "/repo",
              executionRoot: "/repo",
              state: "running",
            },
          },
        })
      )

    it("leaves the task ledger so a revealed file is actually visible", async () => {
      activateTask()
      act(() => {
        useArtifactDockLayoutStore.getState().revealWorkspaceFile({
          sessionId: "session-1",
          rootPath: "/repo",
          relPath: "src/a.ts",
        })
      })

      render(<DockWorkspace activeSessionId="session-1" />)

      await waitFor(() => expect(openFile).toHaveBeenCalledWith("src/a.ts"))
      // Before: the file loaded into an editor hidden behind the task ledger.
      await waitFor(() =>
        expect(screen.queryByTestId("task-resources-panel")).not.toBeInTheDocument()
      )
      expect(screen.getByTestId("workspace-scope-all")).toHaveAttribute("data-state", "on")
      expect(screen.getByTestId("workspace-file-layout")).toBeVisible()
    })

    it("leaves the task ledger for a review reveal too", async () => {
      activateTask()
      act(() => {
        useArtifactDockLayoutStore.getState().revealWorkspaceReview({
          sessionId: "session-1",
          rootPath: "/repo",
        })
      })

      render(<DockWorkspace activeSessionId="session-1" />)

      expect(await screen.findByTestId("workspace-review-layout")).toBeInTheDocument()
      expect(screen.queryByTestId("task-resources-panel")).not.toBeInTheDocument()
    })
  })

  describe("on a phone", () => {
    it("opens a revealed file in the read-only preview, not the editor", async () => {
      useTaskWorkspaceStore.setState({
        activeBySession: {
          "session-1": {
            taskId: "task-1",
            runId: "run-1",
            sessionId: "session-1",
            workspaceRoot: "/repo",
            executionRoot: "/repo",
            state: "running",
          },
        },
      })
      act(() => {
        useArtifactDockLayoutStore.getState().revealWorkspaceFile({
          sessionId: "session-1",
          rootPath: "/repo",
          relPath: "components/mobile/form.tsx",
          line: 12,
        })
      })

      render(<DockWorkspace activeSessionId="session-1" layout="mobile" />)

      const preview = await screen.findByTestId("mock-file-preview")
      expect(preview).toHaveAttribute("data-root", "/repo")
      expect(preview).toHaveAttribute("data-rel", "components/mobile/form.tsx")
      expect(preview).toHaveAttribute("data-line", "12")
      expect(screen.getByTestId("workspace-preview-layer")).toHaveClass("absolute", "inset-0")
      // One Host read — the preview's — and the reveal is consumed.
      expect(openFile).not.toHaveBeenCalled()
      expect(clearReveal).toHaveBeenCalledWith(expect.stringMatching(/^workspace-reveal-/))
      expect(screen.queryByTestId("task-resources-panel")).not.toBeInTheDocument()

      // Edit hands the same location to the editor and drops the preview.
      fireEvent.click(screen.getByTestId("mock-preview-edit"))
      await waitFor(() => expect(openFile).toHaveBeenCalledWith("components/mobile/form.tsx"))
      expect(screen.queryByTestId("mock-file-preview")).not.toBeInTheDocument()
    })

    it("returns to the workspace on Back", async () => {
      act(() => {
        useArtifactDockLayoutStore.getState().revealWorkspaceFile({
          sessionId: "session-1",
          rootPath: "/repo",
          relPath: "src/a.ts",
        })
      })
      render(<DockWorkspace activeSessionId="session-1" layout="mobile" />)

      fireEvent.click(await screen.findByTestId("mock-preview-back"))
      expect(screen.queryByTestId("mock-file-preview")).not.toBeInTheDocument()
      expect(screen.getByTestId("workspace-file-layout")).toBeInTheDocument()
      expect(openFile).not.toHaveBeenCalled()
    })

    it("keeps the desktop dock on the editor path", async () => {
      act(() => {
        useArtifactDockLayoutStore.getState().revealWorkspaceFile({
          sessionId: "session-1",
          rootPath: "/repo",
          relPath: "src/a.ts",
        })
      })
      render(<DockWorkspace activeSessionId="session-1" />)
      await waitFor(() => expect(openFile).toHaveBeenCalledWith("src/a.ts"))
      expect(screen.queryByTestId("mock-file-preview")).not.toBeInTheDocument()
    })

    it("gives the switches a stretched row of their own", () => {
      useTaskWorkspaceStore.setState({
        activeBySession: {
          "session-1": {
            taskId: "task-1",
            runId: "run-1",
            sessionId: "session-1",
            workspaceRoot: "/repo",
            executionRoot: "/repo",
            state: "running",
          },
        },
      })
      render(<DockWorkspace activeSessionId="session-1" layout="mobile" />)

      expect(screen.getByTestId("dock-workspace-switches")).toHaveClass("w-full")
      expect(screen.getByTestId("dock-workspace-switches")).not.toHaveClass("ml-auto")
      expect(screen.getByTestId("dock-workspace-switches")).toHaveClass("flex-wrap")
      expect(screen.getByTestId("workspace-scope-switch")).toHaveClass("min-w-[10rem]", "flex-1")
      expect(screen.getByTestId("workspace-scope-task")).toHaveClass("min-w-0", "flex-1")
      expect(
        within(screen.getByTestId("workspace-scope-task")).getByText("currentTask")
      ).toHaveClass("truncate")
    })
  })

  it("counts distinct changed files on the Review switch", () => {
    gitState = {
      ...gitState,
      status: {
        staged: [{ path: "src/a.ts" }],
        changes: [{ path: "src/a.ts" }, { path: "src/b.ts" }],
        merge: [],
      },
    }
    render(<DockWorkspace activeSessionId="session-1" />)

    expect(screen.getByTestId("workspace-review-count")).toHaveTextContent("2")
    expect(screen.getByTestId("workspace-review-count")).toHaveClass("rounded-pill")
    expect(screen.getByTestId("workspace-surface-review")).toHaveAttribute(
      "aria-label",
      "reviewWithCount"
    )
  })

  it("hides the dock toolbar while the editor is in zen mode", () => {
    render(<DockWorkspace activeSessionId="session-1" />)

    const layout = screen.getByTestId("workspace-file-layout")
    fireEvent.keyDown(layout, { key: "k", metaKey: true })
    fireEvent.keyDown(layout, { key: "z" })
    expect(screen.getByTestId("dock-workspace-toolbar")).not.toBeVisible()
    // Esc Esc brings the chrome back.
    fireEvent.keyDown(layout, { key: "Escape" })
    fireEvent.keyDown(layout, { key: "Escape" })
    expect(screen.getByTestId("dock-workspace-toolbar")).toBeVisible()
  })

  it("keeps editor chords off the Review surface", async () => {
    act(() => {
      useArtifactDockLayoutStore.getState().revealWorkspaceReview({
        sessionId: "session-1",
        rootPath: "/repo",
      })
    })
    render(<DockWorkspace activeSessionId="session-1" />)
    await screen.findByTestId("workspace-review-layout")

    fireEvent.keyDown(screen.getByTestId("workspace-review-layout"), {
      key: "s",
      metaKey: true,
    })
    expect(saveFile).not.toHaveBeenCalled()
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

  it("opens a turn reveal on that turn's read-only snapshot, not on a working-tree side", async () => {
    act(() => {
      useArtifactDockLayoutStore.getState().revealWorkspaceReview({
        sessionId: "session-1",
        rootPath: "/repo",
        relPath: "src/a.ts",
        scope: { scope: "lastTurn", runId: "run:session-1:3" },
      })
    })

    render(<DockWorkspace activeSessionId="session-1" />)

    const snapshot = await screen.findByTestId("snapshot-review")
    expect(snapshot).toHaveAttribute("data-scope", "lastTurn")
    expect(screen.queryByTestId("review-changes")).not.toBeInTheDocument()
    // A turn's file is not a working-tree side, so nothing selects one.
    expect(gitState.selectFile).not.toHaveBeenCalled()
  })

  it("does not expose the review tab for a non-Git root", () => {
    gitState = { ...gitState, repoState: { isRepo: false } }
    render(<DockWorkspace activeSessionId="session-1" />)

    expect(screen.queryByTestId("workspace-surface-switch")).not.toBeInTheDocument()
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
    expect(screen.getByTestId("workspace-file-layout")).not.toBeVisible()
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
    expect(screen.getByTestId("workspace-file-layout")).not.toBeVisible()
  })

  it("reviews one pane at a time on mobile: the list, then a file's diff with a way back", async () => {
    act(() => {
      useArtifactDockLayoutStore.getState().revealWorkspaceReview({
        sessionId: "session-1",
        rootPath: "/repo",
      })
    })

    render(<DockWorkspace activeSessionId="session-1" layout="mobile" />)

    const review = await screen.findByTestId("workspace-review")
    expect(review).toHaveAttribute("data-layout", "stacked")
    // A leftover selection is not a request to read it: the list comes first.
    expect(review).toHaveAttribute("data-pane", "list")
    expect(screen.getByTestId("review-changes")).toHaveAttribute("data-density", "touch")
    expect(screen.queryByTestId("review-diff")).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId("review-changes"))
    expect(gitState.selectFile).toHaveBeenCalledWith("src/a.ts", false)
    const diff = screen.getByTestId("review-diff")
    expect(diff).toHaveAttribute("data-density", "touch")
    // Little height on a phone: the hunk review list starts folded.
    expect(diff).toHaveAttribute("data-review-collapsed", "true")
    expect(screen.queryByTestId("review-changes")).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId("workspace-review-back"))
    expect(screen.getByTestId("review-changes")).toBeInTheDocument()
    expect(screen.queryByTestId("review-diff")).not.toBeInTheDocument()
  })

  it("opens a revealed file straight into its diff on mobile", async () => {
    gitState = {
      ...gitState,
      selectedPath: "src/edited.ts",
      status: { staged: [], changes: [{ path: "src/edited.ts" }], merge: [] },
    }
    act(() => {
      useArtifactDockLayoutStore.getState().revealWorkspaceReview({
        sessionId: "session-1",
        rootPath: "/repo",
        relPath: "src/edited.ts",
      })
    })

    render(<DockWorkspace activeSessionId="session-1" layout="mobile" />)

    expect(await screen.findByTestId("review-diff")).toHaveAttribute("data-path", "src/edited.ts")
    expect(screen.getByTestId("workspace-review")).toHaveAttribute("data-pane", "detail")
    expect(screen.getByTestId("workspace-review-back")).toBeInTheDocument()
  })

  it("reveals a file that is only staged on its staged side", async () => {
    gitState = {
      ...gitState,
      status: { staged: [{ path: "src/staged.ts" }], changes: [], merge: [] },
    }
    act(() => {
      useArtifactDockLayoutStore.getState().revealWorkspaceReview({
        sessionId: "session-1",
        rootPath: "/repo",
        relPath: "src/staged.ts",
      })
    })

    render(<DockWorkspace activeSessionId="session-1" />)

    await screen.findByTestId("workspace-review-layout")
    expect(gitState.selectFile).toHaveBeenCalledWith("src/staged.ts", true)
  })

  it("opens a reviewed file in the editor at the change", async () => {
    act(() => {
      useArtifactDockLayoutStore.getState().revealWorkspaceReview({
        sessionId: "session-1",
        rootPath: "/repo",
      })
    })
    render(<DockWorkspace activeSessionId="session-1" />)
    await screen.findByTestId("workspace-review-layout")

    const goto = jest.fn()
    window.addEventListener(PROJECT_EDITOR_GOTO_EVENT, goto)
    fireEvent.click(screen.getByTestId("review-diff-open"))
    await waitFor(() => expect(openFile).toHaveBeenCalledWith("src/a.ts"))
    await waitFor(() =>
      expect(goto).toHaveBeenCalledWith(
        expect.objectContaining({ detail: { relPath: "src/a.ts", line: 12, column: 1 } })
      )
    )
    window.removeEventListener(PROJECT_EDITOR_GOTO_EVENT, goto)
    expect(screen.getByTestId("workspace-surface-file")).toHaveAttribute("data-state", "on")
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
      monacoLanguage: "typescript",
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

    // The file context workbench is the editor's secondary sidebar in the dock.
    expect(screen.getByTestId("project-context-workbench")).toBeInTheDocument()

    const fileLayout = screen.getByTestId("workspace-file-layout")
    const treeNode = screen.getByTestId("file-tree")
    fireEvent.click(screen.getByTestId("root-switcher"))
    fireEvent.click(screen.getByTestId("workspace-surface-review"))
    expect(fileLayout).toBeInTheDocument()
    expect(fileLayout).not.toBeVisible()
    // The file tabs live inside the (hidden) editor surface now; the
    // toolbar's Editor switch is the way back from Review.
    fireEvent.click(screen.getByTestId("workspace-surface-file"))
    expect(fileLayout).toBeVisible()
    fireEvent.click(screen.getByTestId("select-file"))
    expect(screen.getByTestId("file-tree")).toBe(treeNode)
    fireEvent.click(screen.getByTestId("close-file"))
    fireEvent.click(screen.getByTestId("save-all"))
    expect(selectRoot).toHaveBeenCalledWith("/other")
    expect(setActivePath).toHaveBeenCalledWith("src/a.ts")
    expect(closeFile).toHaveBeenCalledWith("src/a.ts")

    fireEvent.click(screen.getByTestId("file-tree"))
    expect(openFile).toHaveBeenCalledWith("src/tree.ts")
    fireEvent.click(screen.getByTestId("left-tab-search"))
    fireEvent.click(screen.getByTestId("search-panel"))
    expect(openFile).toHaveBeenCalledWith("src/search.ts")

    fireEvent.click(screen.getByTestId("action-file.save"))
    fireEvent.click(screen.getByTestId("action-file.copyPath"))
    fireEvent.click(screen.getByTestId("action-file.copyRelativePath"))
    fireEvent.click(screen.getByTestId("action-file.searchProject"))
    fireEvent.click(screen.getByTestId("left-tab-files"))
    fireEvent.click(screen.getByTestId("left-tab-search"))

    fireEvent.click(screen.getByText("change"))
    expect(setDraft).toHaveBeenCalledWith("src/a.ts", "updated")
    fireEvent.keyDown(screen.getByTestId("workspace-file-layout"), { key: "s", metaKey: true })
    fireEvent.keyDown(screen.getByTestId("workspace-file-layout"), {
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

  it("offers Pro IDE to a browser paired with a host, and mounts the frame pane", async () => {
    // The gate is "is there a host that can run a workbench", not "is this the
    // desktop shell". A browser on the host's own machine reaches the workbench
    // over loopback, and `CodeServerWebPane` states the reason when it cannot.
    setInTauri(false)
    supportedMock.mockResolvedValue(true)
    render(<DockWorkspace activeSessionId="session-1" />)

    await waitFor(() => expect(screen.getByTestId("mock-engine-toggle")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("mock-engine-toggle"))

    expect(screen.getByTestId("mock-code-server-web")).toHaveAttribute("data-root", "/repo")
    expect(screen.queryByTestId("mock-code-server")).not.toBeInTheDocument()
  })

  it("keeps Pro IDE off a shell with no host at all", async () => {
    setInTauri(false)
    backendAvailable = false
    supportedMock.mockResolvedValue(true)
    render(<DockWorkspace activeSessionId="session-1" />)

    await waitFor(() => expect(screen.getByTestId("workspace-unavailable")).toBeInTheDocument())
    expect(screen.queryByTestId("mock-engine-toggle")).not.toBeInTheDocument()
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

    fireEvent.click(screen.getByTestId("workspace-surface-file"))

    expect(screen.queryByTestId("workspace-review-layout")).not.toBeInTheDocument()
    expect(screen.getByTestId("workspace-code-server-host")).toHaveAttribute("data-active", "true")
  })
})
