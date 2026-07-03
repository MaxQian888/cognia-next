/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, act, cleanup } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const mockPush = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}))

let transportKind: "tauri-channel" | "ws" | "unsupported" = "tauri-channel"
jest.mock("@/lib/terminal/pick-transport", () => ({
  selectTerminalTransport: () => transportKind,
  terminalAvailable: () => transportKind !== "unsupported",
}))

const mockSpawnFromDock = jest.fn(async (..._args: unknown[]) => ({
  kind: "spawned" as const,
  sessionId: "s-new",
  shell: "/bin/bash",
}))
const mockKillFromDock = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock("@/lib/terminal/spawn-orchestrator", () => ({
  spawnFromDock: (...args: unknown[]) => mockSpawnFromDock(...(args as [])),
  killFromDock: (...args: unknown[]) => mockKillFromDock(...(args as [])),
}))

// xterm and its addons get pulled in transitively through
// `<TerminalInstance>` — mock the heavy modules so we don't load them.
jest.mock("@xterm/xterm", () => ({
  Terminal: jest.fn(() => ({
    loadAddon: jest.fn(),
    open: jest.fn(),
    onData: jest.fn(() => ({ dispose: jest.fn() })),
    onSelectionChange: jest.fn(() => ({ dispose: jest.fn() })),
    attachCustomKeyEventHandler: jest.fn(),
    getSelection: jest.fn(() => ""),
    paste: jest.fn(),
    clear: jest.fn(),
    registerMarker: jest.fn(() => ({})),
    registerDecoration: jest.fn(),
    options: { fontFamily: "Menlo", fontSize: 13, scrollback: 10000 },
    unicode: { activeVersion: "6" },
    dispose: jest.fn(),
    rows: 24,
    cols: 80,
    write: jest.fn(),
  })),
}))
jest.mock("@xterm/addon-fit", () => ({ FitAddon: jest.fn(() => ({ fit: jest.fn() })) }))
jest.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: jest.fn(() => ({})) }))
jest.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: jest.fn(() => ({})) }))
jest.mock("@xterm/addon-search", () => ({
  SearchAddon: jest.fn(() => ({
    findNext: jest.fn(() => true),
    findPrevious: jest.fn(() => true),
    clearDecorations: jest.fn(),
    dispose: jest.fn(),
  })),
}))
jest.mock("@xterm/addon-webgl", () => ({ WebglAddon: jest.fn(() => ({ dispose: jest.fn() })) }))
jest.mock("@xterm/addon-canvas", () => ({ CanvasAddon: jest.fn(() => ({ dispose: jest.fn() })) }))
class MockResizeObserver {
  observe = jest.fn()
  disconnect = jest.fn()
  unobserve = jest.fn()
}
;(global as unknown as { ResizeObserver: typeof MockResizeObserver }).ResizeObserver =
  MockResizeObserver

jest.mock("@/lib/terminal/session-registry", () => ({
  getLiveSession: () => ({
    info: { id: "s-1" },
    onData: jest.fn(() => () => undefined),
    onIntegration: jest.fn(() => () => undefined),
    onExit: jest.fn(() => () => undefined),
    write: jest.fn(async () => undefined),
    resize: jest.fn(async () => undefined),
    kill: jest.fn(async () => undefined),
  }),
}))

import { TerminalDock } from "./terminal-dock"
import { useTerminalStore } from "@/stores/terminal/terminal-store"
import { useProjectStore } from "@/stores/project/project-store"
import { useChatStore } from "@/stores/chat/chat-store"

beforeEach(() => {
  cleanup()
  useTerminalStore.getState().reset()
  // Hard-reset the project store too.
  useProjectStore.setState({ projects: [], activeProjectId: null })
  useChatStore.getState().setActiveSession(null)
  mockSpawnFromDock.mockClear()
  mockKillFromDock.mockClear()
  mockPush.mockClear()
  transportKind = "tauri-channel"
})

function seedProjectAndSession(
  opts: {
    projectId?: string
    rootDir?: string
    shellOverride?: string
    sessionId?: string
  } = {}
) {
  const project = useProjectStore.getState().createProject({
    name: "p",
    rootDir: opts.rootDir,
  })
  if (opts.shellOverride) {
    useProjectStore.getState().updateProject(project.id, {
      terminalConfig: { shell: opts.shellOverride },
    })
  }
  useProjectStore.getState().setActiveProject(project.id)
  useTerminalStore.getState().setPanelOpen(true)
  if (opts.sessionId) {
    useTerminalStore.getState().registerSession({
      id: opts.sessionId,
      projectId: project.id,
      extensionId: null,
      origin: "local",
      shell: "/bin/bash",
    })
  }
  return project
}

describe("TerminalDock", () => {
  it("does not render anything when panelOpen is false", () => {
    seedProjectAndSession()
    useTerminalStore.getState().setPanelOpen(false)
    const { container } = render(<TerminalDock />)
    expect(container.firstChild).toBeNull()
  })

  it("renders the dock chrome when panelOpen is true", () => {
    seedProjectAndSession({ sessionId: "s-1" })
    render(<TerminalDock />)
    expect(screen.getByTestId("terminal-dock")).toBeInTheDocument()
    expect(screen.getByTestId("terminal-dock-tabs")).toBeInTheDocument()
  })

  it("shows the empty-state desktop variant when there are no sessions", () => {
    seedProjectAndSession()
    render(<TerminalDock />)
    const empty = screen.getByTestId("terminal-empty-state")
    expect(empty.getAttribute("data-variant")).toBe("desktop")
  })

  it("renders a tab per session belonging to the active project", () => {
    const project = seedProjectAndSession({ sessionId: "s-1" })
    useTerminalStore.getState().registerSession({
      id: "s-2",
      projectId: project.id,
      extensionId: null,
      origin: "local",
      shell: "/bin/bash",
    })
    render(<TerminalDock />)
    const tabs = screen.getAllByTestId("terminal-tab")
    expect(tabs.map((t) => t.getAttribute("data-id"))).toEqual(["s-1", "s-2"])
  })

  it("filters out tabs belonging to other projects", () => {
    const a = useProjectStore.getState().createProject({ name: "a" })
    const b = useProjectStore.getState().createProject({ name: "b" })
    useProjectStore.getState().setActiveProject(a.id)
    useTerminalStore.getState().setPanelOpen(true)
    useTerminalStore.getState().registerSession({
      id: "for-a",
      projectId: a.id,
      extensionId: null,
      origin: "local",
      shell: "/bin/bash",
    })
    useTerminalStore.getState().registerSession({
      id: "for-b",
      projectId: b.id,
      extensionId: null,
      origin: "local",
      shell: "/bin/bash",
    })
    render(<TerminalDock />)
    const tabs = screen.getAllByTestId("terminal-tab")
    expect(tabs.map((t) => t.getAttribute("data-id"))).toEqual(["for-a"])
  })

  it("calls spawnFromDock with the project's terminalConfig.shell when set", async () => {
    seedProjectAndSession({ shellOverride: "/usr/local/bin/fish" })
    render(<TerminalDock />)
    await act(async () => {
      fireEvent.click(screen.getByTestId("terminal-dock-new"))
    })
    expect(mockSpawnFromDock).toHaveBeenCalledTimes(1)
    const req = mockSpawnFromDock.mock.calls[0]?.[0] as unknown as {
      req: { shell: string }
    }
    expect(req.req.shell).toBe("/usr/local/bin/fish")
  })

  it("falls back to project.rootDir as cwd when terminalConfig.cwd is unset", async () => {
    seedProjectAndSession({ rootDir: "/tmp/proj-a" })
    render(<TerminalDock />)
    await act(async () => {
      fireEvent.click(screen.getByTestId("terminal-dock-new"))
    })
    const req = mockSpawnFromDock.mock.calls[0]?.[0] as unknown as {
      req: { cwd?: string }
    }
    expect(req.req.cwd).toBe("/tmp/proj-a")
  })

  it("closes the panel when the × button is clicked", () => {
    seedProjectAndSession()
    render(<TerminalDock />)
    fireEvent.click(screen.getByTestId("terminal-dock-close"))
    expect(useTerminalStore.getState().panelOpen).toBe(false)
  })

  it("calls killFromDock when a tab × is clicked", async () => {
    seedProjectAndSession({ sessionId: "s-1" })
    render(<TerminalDock />)
    const closeBtn = screen.getAllByLabelText("close")[0]!
    await act(async () => {
      fireEvent.click(closeBtn)
    })
    expect(mockKillFromDock).toHaveBeenCalledWith("s-1", expect.any(Object))
  })

  it("confirms before closing a tab that is running a command", async () => {
    seedProjectAndSession({ sessionId: "s-1" })
    useTerminalStore.getState().setSessionStatus("s-1", "running")
    render(<TerminalDock />)
    const closeBtn = screen.getAllByLabelText("close")[0]!
    await act(async () => {
      fireEvent.click(closeBtn)
    })
    // Dialog shown, kill deferred until the user confirms.
    expect(screen.getByTestId("terminal-dock-close-confirm")).toBeInTheDocument()
    expect(mockKillFromDock).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.click(screen.getByTestId("terminal-dock-close-confirm-accept"))
    })
    expect(mockKillFromDock).toHaveBeenCalledWith("s-1", expect.any(Object))
  })

  it("closes an idle tab immediately without a confirm dialog", async () => {
    seedProjectAndSession({ sessionId: "s-1" })
    render(<TerminalDock />)
    const closeBtn = screen.getAllByLabelText("close")[0]!
    await act(async () => {
      fireEvent.click(closeBtn)
    })
    expect(screen.queryByTestId("terminal-dock-close-confirm")).toBeNull()
    expect(mockKillFromDock).toHaveBeenCalledWith("s-1", expect.any(Object))
  })

  it("toggles the maximized dock state from the toolbar button", () => {
    seedProjectAndSession({ sessionId: "s-1" })
    render(<TerminalDock />)
    expect(useTerminalStore.getState().maximized).toBe(false)
    fireEvent.click(screen.getByTestId("terminal-dock-maximize"))
    expect(useTerminalStore.getState().maximized).toBe(true)
  })

  it("shows split + clear toolbar buttons on desktop with an active session", () => {
    seedProjectAndSession({ sessionId: "s-1" })
    render(<TerminalDock />)
    expect(screen.getByTestId("terminal-dock-split")).toBeInTheDocument()
    expect(screen.getByTestId("terminal-dock-clear")).toBeInTheDocument()
  })

  it("calls setActiveSession when a tab body is clicked", () => {
    const project = seedProjectAndSession({ sessionId: "s-1" })
    useTerminalStore.getState().registerSession({
      id: "s-2",
      projectId: project.id,
      extensionId: null,
      origin: "local",
      shell: "/bin/bash",
    })
    render(<TerminalDock />)
    const tab = screen.getAllByTestId("terminal-tab")[0]!
    fireEvent.click(tab)
    expect(useTerminalStore.getState().getActiveSession(project.id)).toBe("s-1")
  })

  it("locates the spawning chat session from an agent tab's history button", async () => {
    seedProjectAndSession({ sessionId: "s-1" })
    useTerminalStore.getState().setAgentSpawner("s-1", "chat-7")
    useTerminalStore.getState().setHistoryOpen("s-1", true)
    render(<TerminalDock />)
    await act(async () => {
      await Promise.resolve()
    })
    fireEvent.click(screen.getByTestId("terminal-history-locate"))
    expect(useChatStore.getState().activeSessionId).toBe("chat-7")
    expect(mockPush).toHaveBeenCalledWith("/")
  })

  it("renders the mobile empty state when running under Capacitor", () => {
    transportKind = "ws"
    seedProjectAndSession()
    render(<TerminalDock />)
    expect(screen.getByTestId("terminal-empty-state").getAttribute("data-variant")).toBe("mobile")
    // No "+ New" button when remote isn't yet wired up (task #14).
    expect(screen.queryByTestId("terminal-dock-new")).toBeNull()
  })

  it("renders the unsupported empty state in plain browser", () => {
    transportKind = "unsupported"
    seedProjectAndSession()
    render(<TerminalDock />)
    expect(screen.getByTestId("terminal-empty-state").getAttribute("data-variant")).toBe(
      "unsupported"
    )
  })
})
