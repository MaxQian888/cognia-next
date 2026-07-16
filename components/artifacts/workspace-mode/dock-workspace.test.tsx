/** @jest-environment jsdom */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

let backendAvailable = true
let session: { id: string; projectId?: string } | undefined
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
let editorRootPath = "/repo"
let activeFile: { absolutePath: string; relPath: string; content: string } | null = null
let openFiles: Array<{ absolutePath: string; relPath: string; content: string }> = []

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/lib/files/workspace-backend", () => ({
  hasWorkspaceFsBackend: () => backendAvailable,
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
      roots: [{ key: "/repo", label: "main", path: "/repo", isMain: true }],
      rootKey: "/repo",
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
    }
  },
}))

jest.mock("@/components/editor/project/project-root-switcher", () => ({
  ProjectRootSwitcher: ({ onSelect }: { onSelect: (key: string) => void }) => (
    <button data-testid="root-switcher" onClick={() => onSelect("/other")}>
      root
    </button>
  ),
}))
jest.mock("@/components/editor/project/project-editor-tabs", () => ({
  ProjectEditorTabs: ({
    fixedTabs = [],
    onSelect,
    onClose,
    onSaveAll,
  }: {
    fixedTabs?: Array<{ id: string; onSelect: () => void }>
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

jest.mock("@/stores/git/git-store", () => ({
  useGitStore: (selector: (state: Record<string, unknown>) => unknown) => selector(gitState),
}))
jest.mock("@/hooks/git/use-git-actions", () => ({ useGitActions: () => ({}) }))
jest.mock("@/lib/git/load", () => ({ refreshGitStatus: jest.fn() }))
jest.mock("@/components/source-control/changes-view", () => ({
  ChangesView: () => <div data-testid="review-changes" />,
}))
jest.mock("@/components/source-control/diff-pane", () => ({
  DiffPane: () => <div data-testid="review-diff" />,
}))

import { DockWorkspace } from "./dock-workspace"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"

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
  activePath = null
  editorRootPath = "/repo"
  activeFile = null
  openFiles = []
  act(() => useArtifactDockLayoutStore.getState().resetLayout())
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

  it("consumes a queued file reveal after mounting the editor", async () => {
    act(() => {
      useArtifactDockLayoutStore.getState().revealWorkspaceFile({
        sessionId: "split-session",
        rootPath: "/repo",
        relPath: "src/a.ts",
      })
    })

    render(<DockWorkspace activeSessionId="session-1" />)

    await waitFor(() => expect(openFile).toHaveBeenCalledWith("src/a.ts"))
    expect(clearReveal).toHaveBeenCalledWith(expect.stringMatching(/^workspace-reveal-/))
    expect(screen.getByTestId("workspace-file-layout")).toBeInTheDocument()
    expect(screen.getByTestId("file-tree")).toBeInTheDocument()
    expect(mockUseProjectEditor).toHaveBeenCalledWith({
      scopeKey: "session:split-session",
      workingDir: "/repo",
    })
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

  it("wires editor tabs, sidebar, file actions, and keyboard saves", async () => {
    activePath = "src/a.ts"
    activeFile = { absolutePath: "/repo/src/a.ts", relPath: "src/a.ts", content: "old" }
    openFiles = [activeFile]
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: jest.fn() },
    })

    render(<DockWorkspace activeSessionId="session-1" />)

    fireEvent.click(screen.getByTestId("root-switcher"))
    fireEvent.click(screen.getByTestId("fixed-review"))
    fireEvent.click(screen.getByTestId("select-file"))
    fireEvent.click(screen.getByTestId("close-file"))
    fireEvent.click(screen.getByTestId("save-all"))
    expect(selectRoot).toHaveBeenCalledWith("/other")
    expect(setActivePath).toHaveBeenCalledWith("src/a.ts")
    expect(closeFile).toHaveBeenCalledWith("src/a.ts")

    fireEvent.click(screen.getByTestId("file-tree"))
    expect(openFile).toHaveBeenCalledWith("src/tree.ts")
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
})
