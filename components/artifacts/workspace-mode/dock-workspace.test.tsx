/** @jest-environment jsdom */

import { act, render, screen, waitFor } from "@testing-library/react"

let backendAvailable = true
let session: { id: string; projectId?: string } | undefined
let projects: Array<{
  id: string
  roots: Array<{ id: string; path: string; isPrimary?: boolean }>
}> = []
let gitState: Record<string, unknown> = {}

const openFile = jest.fn().mockResolvedValue(undefined)
const clearReveal = jest.fn()

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
  useProjectEditor: () => ({
    deps: {},
    roots: [{ key: "/repo", label: "main", path: "/repo", isMain: true }],
    rootKey: "/repo",
    rootPath: "/repo",
    openFiles: [],
    activePath: null,
    activeFile: null,
    dirtyCount: 0,
    treeRefreshToken: 0,
    selectRoot: jest.fn(),
    openFile,
    closeFile: jest.fn(),
    setActivePath: jest.fn(),
    setDraft: jest.fn(),
    saveFile: jest.fn(),
    saveAll: jest.fn(),
  }),
}))

jest.mock("@/components/editor/project/project-root-switcher", () => ({
  ProjectRootSwitcher: () => <div data-testid="root-switcher" />,
}))
jest.mock("@/components/editor/project/project-editor-tabs", () => ({
  ProjectEditorTabs: ({ fixedTabs = [] }: { fixedTabs?: Array<{ id: string }> }) => (
    <div data-testid="editor-tabs" data-fixed={fixedTabs.map((tab) => tab.id).join(",")} />
  ),
}))
jest.mock("@/components/editor/project/project-file-tree", () => ({
  ProjectFileTree: () => <div data-testid="file-tree" />,
}))
jest.mock("@/components/editor/project/project-search-panel", () => ({
  ProjectSearchPanel: () => <div data-testid="search-panel" />,
}))
jest.mock("@/components/editor/project/project-monaco", () => ({
  ProjectMonaco: () => <div data-testid="monaco" />,
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

  it("does not expose the review tab for a non-Git root", () => {
    gitState = { ...gitState, repoState: { isRepo: false } }
    render(<DockWorkspace activeSessionId="session-1" />)

    expect(screen.getByTestId("editor-tabs")).toHaveAttribute("data-fixed", "")
    expect(screen.getByTestId("workspace-file-layout")).toBeInTheDocument()
    expect(screen.queryByTestId("workspace-review-layout")).not.toBeInTheDocument()
  })
})
