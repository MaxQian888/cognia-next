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
jest.mock("./use-project-editor", () => ({
  useProjectEditor: () => editorState,
}))
// Capture the props passed to each child so tests can drive its callbacks.
const captured: Record<string, unknown> = {}
jest.mock("./project-file-tree", () => ({
  ProjectFileTree: (p: Record<string, unknown>) => {
    captured.tree = p
    return <div data-testid="mock-tree" />
  },
}))
jest.mock("./project-search-panel", () => ({
  ProjectSearchPanel: (p: Record<string, unknown>) => {
    captured.search = p
    return <div data-testid="mock-search" />
  },
}))
jest.mock("./project-monaco", () => ({
  ProjectMonaco: (p: Record<string, unknown>) => {
    captured.monaco = p
    return <div data-testid="mock-monaco" />
  },
}))
jest.mock("./project-editor-tabs", () => ({
  ProjectEditorTabs: (p: Record<string, unknown>) => {
    captured.tabs = p
    return <div data-testid="mock-tabs" />
  },
}))
jest.mock("./project-root-switcher", () => ({
  ProjectRootSwitcher: () => <div data-testid="mock-switcher" />,
}))

import { AgentTeamEditor, hasFsBackend } from "./agent-team-editor"
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
  editorState.activeFile = null
  editorState.dirtyCount = 0
})

describe("hasFsBackend", () => {
  it("is true on desktop and false on unpaired web", () => {
    isTauriMock.mockReturnValue(true)
    expect(hasFsBackend()).toBe(true)
    isTauriMock.mockReturnValue(false)
    loadCompanionConfigMock.mockReturnValue(null)
    expect(hasFsBackend()).toBe(false)
    loadCompanionConfigMock.mockReturnValue({ ip: "x" } as never)
    expect(hasFsBackend()).toBe(true)
  })
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
