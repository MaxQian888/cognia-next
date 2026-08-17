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
// The dock now reads the reactive hook rather than calling the resolver during
// render, so the stub moves with it. `canSpawn` is derived the same way the
// real hook derives it: "is there a spawn chain", not "is this the local PTY".
jest.mock("@/hooks/terminal/use-terminal-transport", () => ({
  useTerminalTransport: () => ({
    kind: transportKind,
    canSpawn: transportKind !== "unsupported",
    isLocalPty: transportKind === "tauri-channel",
  }),
}))
jest.mock("@/lib/terminal/pick-transport", () => ({
  selectTerminalTransport: () => transportKind,
  selectTerminalTransportChain: () => (transportKind === "unsupported" ? [] : [transportKind]),
  terminalAvailable: () => transportKind !== "unsupported",
}))

let platformKind: "tauri" | "mobile" | "web" = "tauri"
jest.mock("@/hooks/use-platform", () => ({
  usePlatform: () => platformKind,
}))

const mockSpawnFromDock = jest.fn(async (..._args: unknown[]) => ({
  kind: "spawned" as const,
  sessionId: "s-new",
  shell: "/bin/bash",
}))
const mockKillFromDock = jest.fn(async (..._args: unknown[]) => undefined)
const mockDetachFromDock = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock("@/lib/terminal/spawn-orchestrator", () => ({
  spawnFromDock: (...args: unknown[]) => mockSpawnFromDock(...(args as [])),
  killFromDock: (...args: unknown[]) => mockKillFromDock(...(args as [])),
  detachFromDock: (...args: unknown[]) => mockDetachFromDock(...(args as [])),
}))

// The dock delegates shell / profile / cwd precedence to `spawnDefaultTerminal`
// (shared with the title bar's Terminal → New). Keep the real module so those
// precedence assertions still exercise it — it calls the mocked
// `spawnFromDock` above.

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

jest.mock("@/lib/terminal/session-registry", () => {
  const liveSession = {
    info: { id: "s-1" },
    onData: jest.fn(() => () => undefined),
    onIntegration: jest.fn(() => () => undefined),
    onExit: jest.fn(() => () => undefined),
    onControlState: jest.fn(() => () => undefined),
    onReplayGap: jest.fn(() => () => undefined),
    write: jest.fn(async () => undefined),
    resize: jest.fn(async () => undefined),
    takeControl: jest.fn(async () => undefined),
    releaseControl: jest.fn(async () => undefined),
    kill: jest.fn(async () => undefined),
    supportsFlowControl: false,
    setFlowControl: jest.fn(async () => false),
  }
  return {
    getLiveSession: () => liveSession,
    // The session chip subscribes so live facts are read reactively.
    subscribeLiveSessions: () => () => undefined,
  }
})

const toastError = jest.fn()
const toastSuccess = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: (...args: unknown[]) => toastSuccess(...args),
  },
}))

const mockConnectSsh = jest.fn(async (..._args: unknown[]): Promise<unknown> => ({
  kind: "connected",
  sessionId: "ssh-session-1",
  hostKeyStatus: "learned",
  hostKeyFingerprint: "SHA256:abc",
}))
// `resolveSshHostLaunch` stays real — the dock's guard rails are the point of
// these tests; only the native connection is stubbed.
jest.mock("@/lib/terminal/ssh-connect", () => ({
  ...jest.requireActual("@/lib/terminal/ssh-connect"),
  connectSshFromDock: (...args: unknown[]) => mockConnectSsh(...args),
}))

// The picker's own rendering (grouping, filtering, Radix menu) is covered by
// `terminal-shell-picker.test.tsx`. Here it is reduced to the two affordances
// the dock wires, keeping `terminal-dock-new` so the spawn tests still work.
jest.mock("./terminal-share-dialog", () => ({
  TerminalShareDialog: ({
    sessionId,
    open,
    onOpenChange,
  }: {
    sessionId: string
    open: boolean
    onOpenChange: (open: boolean) => void
  }) =>
    open ? (
      <div data-testid="terminal-share-dialog" data-session-id={sessionId}>
        <button
          type="button"
          data-testid="terminal-share-close"
          onClick={() => onOpenChange(false)}
        />
      </div>
    ) : null,
}))

jest.mock("./terminal-shell-picker", () => ({
  TerminalShellPicker: ({
    onNew,
    sshHosts,
    onNewSshHost,
  }: {
    onNew: (shell?: string) => void | Promise<void>
    sshHosts?: Array<{ id: string }>
    onNewSshHost?: (hostId: string) => void | Promise<void>
  }) => (
    <div>
      <button type="button" data-testid="terminal-dock-new" onClick={() => void onNew()} />
      {(sshHosts ?? []).map((host) => (
        <button
          key={host.id}
          type="button"
          data-testid={`dock-ssh-${host.id}`}
          onClick={() => void onNewSshHost?.(host.id)}
        />
      ))}
      <button
        type="button"
        data-testid="dock-ssh-missing"
        onClick={() => void onNewSshHost?.("ssh-does-not-exist")}
      />
    </div>
  ),
}))

import { TerminalDock } from "./terminal-dock"
import { useTerminalStore } from "@/stores/terminal/terminal-store"
import { useProjectStore } from "@/stores/project/project-store"
import { useChatStore } from "@/stores/chat/chat-store"
import { useSettingsStore } from "@/stores/settings"

beforeEach(() => {
  cleanup()
  useTerminalStore.getState().reset()
  // Hard-reset the project store too.
  useProjectStore.setState({ projects: [], activeProjectId: null })
  useChatStore.getState().setActiveSession(null)
  mockSpawnFromDock.mockClear()
  mockKillFromDock.mockClear()
  mockDetachFromDock.mockClear()
  mockPush.mockClear()
  toastError.mockClear()
  toastSuccess.mockClear()
  mockConnectSsh.mockClear()
  useSettingsStore.setState({ settings: undefined })
  transportKind = "tauri-channel"
  platformKind = "tauri"
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

  it("gives the resize separator a large hit target and keeps it keyboard-operable", () => {
    seedProjectAndSession({ sessionId: "s-1" })
    render(<TerminalDock />)
    const handle = screen.getByTestId("terminal-dock-resize-handle")
    expect(handle.getAttribute("role")).toBe("separator")
    expect(handle.getAttribute("tabindex")).toBe("0")
    // 10px transparent hit zone (h-2.5) replaced the old 4px sliver (h-1) so
    // it can actually be grabbed, including by touch.
    expect(handle.className).toContain("h-2.5")
    // Arrow keys still nudge the height.
    fireEvent.keyDown(handle, { key: "ArrowUp" })
    fireEvent.keyDown(handle, { key: "ArrowDown" })
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

  it("offers detach and terminate when a live tab × is clicked", async () => {
    seedProjectAndSession({ sessionId: "s-1" })
    render(<TerminalDock />)
    const closeBtn = screen.getAllByLabelText("close")[0]!
    await act(async () => {
      fireEvent.click(closeBtn)
    })
    expect(screen.getByTestId("terminal-dock-close-confirm")).toBeInTheDocument()
    expect(mockKillFromDock).not.toHaveBeenCalled()
    expect(mockDetachFromDock).not.toHaveBeenCalled()
  })

  it("confirms before closing a tab that is running a command", async () => {
    seedProjectAndSession({ sessionId: "s-1" })
    useTerminalStore.getState().setSessionStatus("s-1", "running")
    render(<TerminalDock />)
    const closeBtn = screen.getAllByLabelText("close")[0]!
    await act(async () => {
      fireEvent.click(closeBtn)
    })
    // Dialog shown, termination deferred; the primary action only detaches.
    expect(screen.getByTestId("terminal-dock-close-confirm")).toBeInTheDocument()
    expect(mockKillFromDock).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.click(screen.getByTestId("terminal-dock-close-confirm-accept"))
    })
    expect(mockDetachFromDock).toHaveBeenCalledWith("s-1", expect.any(Object))
    expect(mockKillFromDock).not.toHaveBeenCalled()
  })

  it("requires an explicit destructive action before terminating an idle live tab", async () => {
    seedProjectAndSession({ sessionId: "s-1" })
    render(<TerminalDock />)
    const closeBtn = screen.getAllByLabelText("close")[0]!
    await act(async () => {
      fireEvent.click(closeBtn)
    })
    expect(screen.getByTestId("terminal-dock-close-confirm")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("terminal-dock-close-terminate"))
    expect(mockKillFromDock).toHaveBeenCalledWith("s-1", expect.any(Object))
    expect(mockDetachFromDock).not.toHaveBeenCalled()
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
    platformKind = "mobile"
    seedProjectAndSession()
    render(<TerminalDock />)
    expect(screen.getByTestId("terminal-empty-state").getAttribute("data-variant")).toBe("mobile")
  })

  it("renders the remote empty state when a desktop is driving a remote host", () => {
    transportKind = "ws"
    platformKind = "tauri"
    seedProjectAndSession()
    render(<TerminalDock />)
    expect(screen.getByTestId("terminal-empty-state").getAttribute("data-variant")).toBe("remote")
  })

  it("still offers a way to create a terminal over ws", () => {
    // Regression: the spawn affordances used to be gated on
    // `transport === "tauri-channel"`, so a desktop driving a remote host got a
    // dock with no way to open a terminal at all.
    transportKind = "ws"
    platformKind = "tauri"
    seedProjectAndSession()
    render(<TerminalDock />)
    expect(screen.getByTestId("terminal-empty-state-new")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("terminal-empty-state-new"))
    expect(mockSpawnFromDock).toHaveBeenCalled()
  })

  it("offers Share on the desktop host and opens the share dialog for the active session (ADR-0131)", () => {
    seedProjectAndSession({ sessionId: "s-1" })
    render(<TerminalDock />)
    expect(screen.queryByTestId("terminal-share-dialog")).toBeNull()
    fireEvent.click(screen.getByTestId("terminal-dock-share"))
    expect(screen.getByTestId("terminal-share-dialog")).toHaveAttribute("data-session-id", "s-1")
    fireEvent.click(screen.getByTestId("terminal-share-close"))
    expect(screen.queryByTestId("terminal-share-dialog")).toBeNull()
  })

  it("hides Share on remote transports — only the desktop host can grant devices", () => {
    transportKind = "ws"
    platformKind = "tauri"
    seedProjectAndSession({ sessionId: "s-1" })
    render(<TerminalDock />)
    expect(screen.queryByTestId("terminal-dock-share")).toBeNull()
  })

  it("routes pane keyboard shortcuts: find, split, command jumps, focus moves", async () => {
    seedProjectAndSession({ sessionId: "s-1" })
    render(<TerminalDock />)
    const paneWrapper = screen.getByTestId("terminal-pane-group").parentElement!
    // Ctrl/⌘+F opens the search overlay.
    fireEvent.keyDown(paneWrapper, { key: "f", ctrlKey: true })
    expect(screen.getByTestId("terminal-search-overlay")).toBeInTheDocument()
    // Ctrl+\ splits; the split flow spawns a second pane.
    await act(async () => {
      fireEvent.keyDown(paneWrapper, { key: "\\", ctrlKey: true })
    })
    expect(mockSpawnFromDock).toHaveBeenCalled()
    // Command jumps and pane focus moves must not throw with a single pane.
    fireEvent.keyDown(paneWrapper, { key: "ArrowUp", metaKey: true })
    fireEvent.keyDown(paneWrapper, { key: "ArrowDown", metaKey: true })
    fireEvent.keyDown(paneWrapper, { key: "ArrowLeft", altKey: true })
    fireEvent.keyDown(paneWrapper, { key: "ArrowRight", altKey: true })
    // A plain key is ignored.
    fireEvent.keyDown(paneWrapper, { key: "a" })
    expect(screen.getByTestId("terminal-dock")).toBeInTheDocument()
  })

  it("keeps clearing available on every transport", () => {
    // `clearScreen()` is pure xterm; gating it on the local PTY meant a
    // remote-host user could not clear their own screen.
    transportKind = "ws"
    platformKind = "tauri"
    seedProjectAndSession({ sessionId: "s-1" })
    render(<TerminalDock />)
    expect(screen.getByTestId("terminal-dock-clear")).toBeInTheDocument()
  })

  it("renders the cloud empty state for a browser paired to a cognia-server", () => {
    // A paired browser is `platform === "web"` with a ws transport. It must NOT
    // get the mobile copy, which tells the user to pair with a desktop on their
    // LAN — the cloud pairing is an explicit server URL.
    transportKind = "ws"
    platformKind = "web"
    seedProjectAndSession()
    render(<TerminalDock />)
    expect(screen.getByTestId("terminal-empty-state").getAttribute("data-variant")).toBe("cloud")
  })

  it("offers a spawn action to a paired browser", () => {
    transportKind = "ws"
    platformKind = "web"
    seedProjectAndSession()
    render(<TerminalDock />)
    fireEvent.click(screen.getByTestId("terminal-empty-state-new"))
    expect(mockSpawnFromDock).toHaveBeenCalled()
  })

  it("renders the unsupported empty state in plain browser", () => {
    transportKind = "unsupported"
    platformKind = "web"
    seedProjectAndSession()
    render(<TerminalDock />)
    expect(screen.getByTestId("terminal-empty-state").getAttribute("data-variant")).toBe(
      "unsupported"
    )
    expect(screen.queryByTestId("terminal-empty-state-new")).toBeNull()
  })

  describe("SSH hosts in the shell picker", () => {
    function seedSshHost(overrides: Record<string, unknown> = {}) {
      useSettingsStore.setState({
        settings: {
          terminal: {
            sshHosts: [
              {
                id: "ssh-1",
                name: "Production",
                host: "prod.example.com",
                port: 22,
                username: "deploy",
                authMethod: "agent",
                ...overrides,
              },
            ],
          },
        },
      } as never)
    }

    it("connects the chosen host and reports the host-key verdict", async () => {
      seedSshHost()
      seedProjectAndSession()
      render(<TerminalDock />)
      await act(async () => {
        fireEvent.click(screen.getByTestId("dock-ssh-ssh-1"))
      })

      expect(mockConnectSsh).toHaveBeenCalledWith(
        expect.objectContaining({
          profile: expect.objectContaining({ id: "ssh-1" }),
          rows: 24,
          cols: 80,
        })
      )
      expect(toastSuccess).toHaveBeenCalledWith(
        "sshConnected.learned",
        expect.objectContaining({ description: "SHA256:abc" })
      )
      // SSH never routes through the local shell/profile/cwd precedence.
      expect(mockSpawnFromDock).not.toHaveBeenCalled()
    })

    it("sends a password host with no stored credential back to settings", async () => {
      seedSshHost({ authMethod: "password", credentialRef: undefined })
      seedProjectAndSession()
      render(<TerminalDock />)
      await act(async () => {
        fireEvent.click(screen.getByTestId("dock-ssh-ssh-1"))
      })

      expect(mockConnectSsh).not.toHaveBeenCalled()
      expect(toastError).toHaveBeenCalledWith("sshCredentialRequired")
    })

    it("surfaces a failed connection without opening a tab", async () => {
      seedSshHost()
      seedProjectAndSession()
      mockConnectSsh.mockResolvedValueOnce({ kind: "error", message: "host unreachable" })
      render(<TerminalDock />)
      await act(async () => {
        fireEvent.click(screen.getByTestId("dock-ssh-ssh-1"))
      })

      expect(toastError).toHaveBeenCalledWith("spawnError")
      expect(toastSuccess).not.toHaveBeenCalled()
    })

    it("ignores an id that no longer matches a saved host", async () => {
      seedSshHost()
      seedProjectAndSession()
      render(<TerminalDock />)
      await act(async () => {
        fireEvent.click(screen.getByTestId("dock-ssh-missing"))
      })

      expect(mockConnectSsh).not.toHaveBeenCalled()
      expect(toastError).not.toHaveBeenCalled()
    })

    it("withholds SSH hosts from the picker outside Tauri", () => {
      seedSshHost()
      transportKind = "ws"
      platformKind = "mobile"
      seedProjectAndSession()
      render(<TerminalDock />)
      expect(screen.queryByTestId("dock-ssh-ssh-1")).toBeNull()
    })
  })
})
