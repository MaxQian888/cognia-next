/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({ useTranslations: () => (k: string) => k }))
jest.mock("sonner", () => ({ toast: { error: jest.fn() } }))

const isTauriMock = jest.fn(() => true)
jest.mock("@/lib/tauri", () => ({ isTauri: () => isTauriMock() }))
const loadCompanionConfigMock = jest.fn(() => null)
jest.mock("@/lib/tauri/transport-companion", () => ({
  loadCompanionConfig: () => loadCompanionConfigMock(),
}))
jest.mock("@/stores/canvas/keybinding-store", () => ({
  useKeybindingStore: (sel: (s: unknown) => unknown) => sel({ bindings: {} }),
}))

const editorState = {
  deps: {},
  roots: [{ key: "/repo", label: "main", path: "/repo", isMain: true }],
  rootKey: "/repo",
  rootPath: "/repo",
  openFiles: [] as unknown[],
  activePath: null as string | null,
  activeFile: null as unknown,
  dirtyCount: 0,
  treeRefreshToken: 0,
  selectRoot: jest.fn(),
  openFile: jest.fn(async () => {}),
  closeFile: jest.fn(),
  setActivePath: jest.fn(),
  setDraft: jest.fn(),
  saveFile: jest.fn(async () => {}),
  saveAll: jest.fn(async () => {}),
  reloadFile: jest.fn(async () => {}),
}
const mockUseProjectEditor = jest.fn((_args: unknown) => editorState)
jest.mock("@/components/editor/project/use-project-editor", () => ({
  useProjectEditor: (args: unknown) => mockUseProjectEditor(args),
}))
// Capture the props passed to each child so tests can drive its callbacks.
const captured: Record<string, unknown> = {}
jest.mock("@/components/editor/project/project-file-tree", () => ({
  ProjectFileTree: (p: Record<string, unknown>) => {
    captured.tree = p
    return <div data-testid="mock-tree" />
  },
}))
jest.mock("@/components/editor/project/project-search-panel", () => ({
  ProjectSearchPanel: (p: Record<string, unknown>) => {
    captured.search = p
    return <div data-testid="mock-search" />
  },
}))
jest.mock("@/components/editor/project/project-monaco", () => ({
  ProjectMonaco: (p: Record<string, unknown>) => {
    captured.monaco = p
    return <div data-testid="mock-monaco" />
  },
}))
jest.mock("@/components/editor/project/project-editor-tabs", () => ({
  ProjectEditorTabs: (p: Record<string, unknown>) => {
    captured.tabs = p
    return <div data-testid="mock-tabs" />
  },
}))
jest.mock("@/components/editor/project/project-root-switcher", () => ({
  ProjectRootSwitcher: () => <div data-testid="mock-switcher" />,
}))
const supportedMock = jest.fn(async () => true)
jest.mock("@/lib/codeserver/client", () => ({
  codeServerClient: { supported: () => supportedMock() },
}))
jest.mock("./code-server-pane", () => ({
  CodeServerPane: (p: { root: string }) => (
    <div data-testid="mock-code-server" data-root={p.root} />
  ),
}))

import { AgentTeamEditor } from "./agent-team-editor"
import type { AgentTeam } from "@/types/agent/agent-team"

function team(workingDir?: string): AgentTeam {
  return {
    id: "t1",
    name: "Team",
    config: { workingDir } as AgentTeam["config"],
  } as AgentTeam
}

beforeEach(() => {
  isTauriMock.mockReturnValue(true)
  loadCompanionConfigMock.mockReturnValue(null)
  // Default to a pending probe so generic render tests don't fire an async
  // setState (act warning); Pro-IDE tests override + await explicitly.
  supportedMock.mockReset().mockImplementation(() => new Promise(() => {}))
  editorState.activeFile = null
  editorState.dirtyCount = 0
  mockUseProjectEditor.mockClear()
})

describe("AgentTeamEditor", () => {
  it("shows the placeholder with no fs backend", () => {
    isTauriMock.mockReturnValue(false)
    loadCompanionConfigMock.mockReturnValue(null)
    render(<AgentTeamEditor team={team("/repo")} />)
    expect(screen.getByTestId("editor-unavailable")).toBeInTheDocument()
  })

  it("shows the placeholder when the team has no working dir", () => {
    render(<AgentTeamEditor team={team(undefined)} />)
    expect(screen.getByTestId("editor-unavailable")).toBeInTheDocument()
  })

  it("renders the editor body when a backend + working dir exist", () => {
    render(<AgentTeamEditor team={team("/repo")} />)
    expect(screen.getByTestId("agent-team-editor")).toBeInTheDocument()
    expect(screen.getByTestId("mock-tree")).toBeInTheDocument()
    expect(screen.getByTestId("editor-empty")).toBeInTheDocument()
    expect(mockUseProjectEditor).toHaveBeenCalledWith({
      scopeKey: "team:t1",
      workingDir: "/repo",
    })
  })

  it("shows the editor-engine toggle on desktop", () => {
    render(<AgentTeamEditor team={team("/repo")} />)
    expect(screen.getByTestId("editor-mode-monaco")).toBeInTheDocument()
    expect(screen.getByTestId("editor-mode-codeserver")).toBeInTheDocument()
  })

  it("switches to the code-server pane when Pro IDE is enabled", async () => {
    supportedMock.mockResolvedValue(true)
    render(<AgentTeamEditor team={team("/repo")} />)
    // supported() resolves → the VS Code button enables.
    await act(async () => {
      await Promise.resolve()
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId("editor-mode-codeserver"))
    })
    expect(screen.getByTestId("mock-code-server")).toHaveAttribute("data-root", "/repo")
    expect(screen.queryByTestId("mock-tree")).not.toBeInTheDocument()
  })

  it("disables Pro IDE when the platform has no code-server binary", async () => {
    supportedMock.mockResolvedValue(false)
    render(<AgentTeamEditor team={team("/repo")} />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByTestId("editor-mode-codeserver")).toBeDisabled()
  })

  it("hides the toggle off desktop", () => {
    isTauriMock.mockReturnValue(false)
    loadCompanionConfigMock.mockReturnValue({ ip: "x" } as never)
    render(<AgentTeamEditor team={team("/repo")} />)
    expect(screen.queryByTestId("editor-mode-codeserver")).not.toBeInTheDocument()
  })

  it("toggles the left pane to search", () => {
    render(<AgentTeamEditor team={team("/repo")} />)
    fireEvent.click(screen.getByTestId("left-tab-search"))
    expect(screen.getByTestId("mock-search")).toBeInTheDocument()
  })

  it("renders the Monaco surface when a file is active", () => {
    editorState.activeFile = {
      relPath: "a.ts",
      absolutePath: "/repo/a.ts",
      language: "typescript",
      savedContent: "",
      draftContent: "",
    }
    render(<AgentTeamEditor team={team("/repo")} />)
    expect(screen.getByTestId("mock-monaco")).toBeInTheDocument()
  })

  it("Cmd-S saves the active file", () => {
    editorState.activePath = "a.ts"
    render(<AgentTeamEditor team={team("/repo")} />)
    fireEvent.keyDown(screen.getByTestId("agent-team-editor"), { key: "s", metaKey: true })
    expect(editorState.saveFile).toHaveBeenCalledWith("a.ts")
  })

  it("toasts when a save fails", async () => {
    const { toast } = jest.requireMock("sonner") as { toast: { error: jest.Mock } }
    toast.error.mockClear()
    editorState.activePath = "a.ts"
    editorState.saveFile = jest.fn(async () => {
      throw new Error("disk full")
    })
    render(<AgentTeamEditor team={team("/repo")} />)
    fireEvent.keyDown(screen.getByTestId("agent-team-editor"), { key: "s", metaKey: true })
    await new Promise((r) => setTimeout(r, 0))
    expect(toast.error).toHaveBeenCalled()
    editorState.saveFile = jest.fn(async () => {})
  })

  it("Cmd-S with no active file does nothing", () => {
    editorState.activePath = null
    editorState.saveFile = jest.fn(async () => {})
    render(<AgentTeamEditor team={team("/repo")} />)
    fireEvent.keyDown(screen.getByTestId("agent-team-editor"), { key: "s", metaKey: true })
    expect(editorState.saveFile).not.toHaveBeenCalled()
  })

  it("Cmd-Shift-S saves all", () => {
    render(<AgentTeamEditor team={team("/repo")} />)
    fireEvent.keyDown(screen.getByTestId("agent-team-editor"), {
      key: "s",
      metaKey: true,
      shiftKey: true,
    })
    expect(editorState.saveAll).toHaveBeenCalled()
  })

  it("toasts when Save All fails", async () => {
    const { toast } = jest.requireMock("sonner") as { toast: { error: jest.Mock } }
    toast.error.mockClear()
    editorState.saveAll = jest.fn(async () => {
      throw new Error("nope")
    })
    render(<AgentTeamEditor team={team("/repo")} />)
    fireEvent.keyDown(screen.getByTestId("agent-team-editor"), {
      key: "s",
      metaKey: true,
      shiftKey: true,
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(toast.error).toHaveBeenCalled()
    editorState.saveAll = jest.fn(async () => {})
  })

  it("wires the tree/tabs callbacks and the search jump", async () => {
    editorState.activeFile = {
      relPath: "a.ts",
      absolutePath: "/repo/a.ts",
      language: "typescript",
      savedContent: "",
      draftContent: "",
    }
    render(<AgentTeamEditor team={team("/repo")} />)
    // Tree open → openFile.
    ;(captured.tree as { onOpenFile: (r: string) => void }).onOpenFile("a.ts")
    expect(editorState.openFile).toHaveBeenCalledWith("a.ts")
    // Tabs select/close/saveAll wired to the hook.
    const tabs = captured.tabs as {
      onSelect: (r: string) => void
      onClose: (r: string) => void
      onSaveAll: () => void
    }
    tabs.onSelect("a.ts")
    expect(editorState.setActivePath).toHaveBeenCalledWith("a.ts")
    tabs.onClose("a.ts")
    expect(editorState.closeFile).toHaveBeenCalledWith("a.ts")
    // Monaco onChange → setDraft.
    ;(captured.monaco as { onChange: (v: string) => void }).onChange("z")
    expect(editorState.setDraft).toHaveBeenCalledWith("a.ts", "z")
  })

  it("exercises the injected editor actions (save / copy path / search)", () => {
    const writeText = jest.fn()
    Object.assign(navigator, { clipboard: { writeText } })
    editorState.activePath = "a.ts"
    editorState.activeFile = {
      relPath: "a.ts",
      absolutePath: "/repo/a.ts",
      language: "typescript",
      savedContent: "",
      draftContent: "",
    }
    render(<AgentTeamEditor team={team("/repo")} />)
    const actions = (captured.monaco as { actions: Array<{ id: string; run?: () => void }> })
      .actions
    const byId = (id: string) => actions.find((a) => a.id === id)
    byId("file.save")?.run?.()
    expect(editorState.saveFile).toHaveBeenCalledWith("a.ts")
    byId("file.copyPath")?.run?.()
    expect(writeText).toHaveBeenCalledWith("/repo/a.ts")
    byId("file.copyRelativePath")?.run?.()
    expect(writeText).toHaveBeenCalledWith("a.ts")
    // searchProject toggles the left pane (state update → wrap in act).
    act(() => byId("file.searchProject")?.run?.())
    expect(screen.getByTestId("mock-search")).toBeInTheDocument()
  })

  it("search jump opens the file and dispatches a goto event", () => {
    jest.useFakeTimers()
    const dispatch = jest.spyOn(window, "dispatchEvent")
    render(<AgentTeamEditor team={team("/repo")} />)
    fireEvent.click(screen.getByTestId("left-tab-search"))
    ;(captured.search as { onOpenMatch: (r: string, l: number, c: number) => void }).onOpenMatch(
      "a.ts",
      7,
      3
    )
    expect(editorState.openFile).toHaveBeenCalledWith("a.ts")
    jest.runAllTimers()
    // A goto CustomEvent was dispatched (after the open resolves).
    return Promise.resolve().then(() => {
      jest.runAllTimers()
      expect(
        dispatch.mock.calls.some(
          ([e]) => e instanceof CustomEvent && e.type === "project-editor-goto"
        )
      ).toBe(true)
      dispatch.mockRestore()
      jest.useRealTimers()
    })
  })
})
