type Handler = (
  payload: unknown,
  context: { pluginId: string; method: string; requestId: null }
) => unknown
const handlers = new Map<string, Handler>()

jest.mock("./rpc-dispatcher", () => ({
  registerMethod: (method: string, handler: Handler) => {
    handlers.set(method, handler)
    return () => handlers.delete(method)
  },
}))

const mockLog = jest.fn()
jest.mock("./vscode-log-buffer", () => ({
  appendVscodeLog: (...args: unknown[]) => mockLog(...args),
}))

jest.mock("@/lib/plugin/core/transport", () => ({
  listPluginPermissions: async () => ["terminal:spawn"],
}))

const mockSpawnFromDock = jest.fn()
const mockKillFromDock = jest.fn(async (_id: string, _store: unknown) => {})
const mockWire = jest.fn()
jest.mock("@/lib/terminal/spawn-orchestrator", () => ({
  spawnFromDock: (...args: unknown[]) => mockSpawnFromDock(...args),
  killFromDock: (id: string, store: unknown) => mockKillFromDock(id, store),
  wireSessionToStore: (...args: unknown[]) => mockWire(...args),
}))
const mockLifecycle = jest.fn()
jest.mock("@/lib/plugin/messaging/hooks-system", () => ({
  getPluginEventHooks: () => ({ dispatchTerminalLifecycle: mockLifecycle }),
}))

import { BaseTerminalSession } from "@/lib/terminal/base-session"
import { getLiveSession, __clearLiveSessionsForTesting } from "@/lib/terminal/session-registry"
import type { SessionInfo } from "@/lib/terminal/types"
import { useProjectStore } from "@/stores/project/project-store"
import { useTerminalStore } from "@/stores/terminal/terminal-store"

import { ExtensionPtySession } from "./extension-pty-session"
import {
  __resetVscodeTerminalsForTesting,
  clearVscodeTerminalsForPlugin,
  configureVscodeTerminals,
  createVscodeTerminalDependencies,
  INITIAL_DIMENSIONS,
  installVscodeTerminalHandlers,
  TERMINAL_EXIT_REASON,
  type VscodeTerminalDependencies,
} from "./terminal-handlers"

class FakeShell extends BaseTerminalSession {
  readonly info: SessionInfo
  readonly written: string[] = []
  constructor(id: string) {
    super()
    this.info = { id, projectId: "p1", extensionId: "acme.ext", origin: "local", shell: "zsh" }
  }
  async write(data: Uint8Array | string) {
    this.written.push(typeof data === "string" ? data : new TextDecoder().decode(data))
  }
  async resize() {}
  async detach() {}
  async takeControl() {}
  async releaseControl() {}
  async kill() {
    this.exit(null)
  }
  exit(code: number | null) {
    this.handleExit(code)
  }
}

function setup(options: { granted?: string[] } = {}) {
  const granted = options.granted ?? ["terminal:spawn", "terminal:write"]
  const tabs = new Set<string>()
  const live = new Map<string, BaseTerminalSession>()
  let active: string | null = null
  let next = 0
  const listeners = new Set<() => void>()
  const changed = () => [...listeners].forEach((listener) => listener())
  const sent: Array<[string, string, Record<string, unknown>]> = []
  const deps: VscodeTerminalDependencies = {
    permissions: async () => granted,
    spawn: jest.fn(async () => {
      const id = `shell-${++next}`
      live.set(id, new FakeShell(id))
      tabs.add(id)
      active = id
      changed()
      return { sessionId: id, title: "zsh" }
    }),
    addPtySession: jest.fn((session: ExtensionPtySession) => {
      live.set(session.id, session)
      tabs.add(session.id)
      active = session.id
      changed()
    }),
    session: (id) => live.get(id),
    kill: jest.fn(async (id: string) => {
      await live.get(id)?.kill()
      live.delete(id)
      tabs.delete(id)
      changed()
    }),
    remove: jest.fn((id: string) => {
      live.delete(id)
      tabs.delete(id)
      changed()
    }),
    hasTab: (id) => tabs.has(id),
    activeSessionId: () => active,
    activeProjectId: () => "p1",
    setActive: jest.fn((_projectId: string | null, id: string | null) => {
      active = id
      changed()
    }),
    show: jest.fn(),
    hide: jest.fn(),
    setTitle: jest.fn(),
    setColor: jest.fn(),
    defaultCwd: () => "/repo",
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    sendToHost: async (pluginId, method, payload) => {
      sent.push([pluginId, method, payload as Record<string, unknown>])
      return null
    },
  }
  configureVscodeTerminals(deps)
  const call = async (
    method: string,
    payload: Record<string, unknown>,
    pluginId = "acme.ext"
  ): Promise<unknown> =>
    handlers.get(method)!(
      { extensionId: pluginId, ...payload },
      {
        pluginId,
        method,
        requestId: null,
      }
    )
  const reports = (method: string) =>
    sent
      .filter(([, name]) => name === method)
      .map(([pluginId, , payload]) => ({ pluginId, ...payload }))
  const userCloses = (id: string) => {
    live.delete(id)
    tabs.delete(id)
    changed()
  }
  return {
    deps,
    call,
    sent,
    reports,
    live,
    tabs,
    userCloses,
    setActiveTab: (id: string | null) => {
      active = id
      changed()
    },
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  handlers.clear()
  jest.clearAllMocks()
  __resetVscodeTerminalsForTesting()
  installVscodeTerminalHandlers()
})

describe("process terminals", () => {
  it("need terminal:spawn", async () => {
    const h = setup({ granted: [] })
    await expect(h.call("terminal:create", { terminalId: "t1", kind: "process" })).rejects.toThrow(
      /requires permission terminal:spawn/
    )
    expect(h.deps.spawn).not.toHaveBeenCalled()
  })

  it("spawn a dock tab as the extension asked, in the first folder by default", async () => {
    const h = setup()
    await expect(
      h.call("terminal:create", {
        terminalId: "t1",
        kind: "process",
        name: "Build",
        shellPath: "/bin/bash",
        shellArgs: ["-l"],
        env: { A: "1", B: 2 },
        color: "terminal.ansiMagenta",
      })
    ).resolves.toEqual({ name: "Build" })
    expect(h.deps.spawn).toHaveBeenCalledWith({
      pluginId: "acme.ext",
      name: "Build",
      shell: "/bin/bash",
      args: ["-l"],
      cwd: "/repo",
      env: { A: "1" },
      projectId: "p1",
    })
    expect(h.deps.setColor).toHaveBeenCalledWith("shell-1", "purple")
    expect(h.reports("terminal:activeChanged")).toEqual([
      { pluginId: "acme.ext", terminalId: "t1" },
    ])

    await expect(
      h.call("terminal:create", { terminalId: "t2", kind: "process", cwd: "/elsewhere" })
    ).resolves.toEqual({ name: "zsh" })
    expect(h.deps.spawn).toHaveBeenLastCalledWith(
      expect.objectContaining({ shell: "", cwd: "/elsewhere", name: undefined })
    )
    await expect(h.call("terminal:create", { terminalId: "t2", kind: "process" })).rejects.toThrow(
      /already exists/
    )
  })

  it("log the environment options they cannot honour, and keep a hidden one from taking the tab", async () => {
    const h = setup()
    await h.call("terminal:create", { terminalId: "t1", kind: "process" })
    await h.call("terminal:create", {
      terminalId: "t2",
      kind: "process",
      strictEnv: true,
      unsetEnv: ["PATH"],
      hideFromUser: true,
    })
    expect(mockLog).toHaveBeenCalledWith(
      "acme.ext",
      expect.objectContaining({ level: "warn", message: expect.stringMatching(/strictEnv/) })
    )
    expect(h.deps.setActive).toHaveBeenCalledWith("p1", "shell-1")
    expect(h.reports("terminal:activeChanged").at(-1)).toEqual({
      pluginId: "acme.ext",
      terminalId: "t1",
    })
  })

  it("send text behind terminal:write, and only the user's typing counts as interaction", async () => {
    const h = setup()
    await h.call("terminal:create", { terminalId: "t1", kind: "process" })
    const shell = h.live.get("shell-1") as FakeShell
    await h.call("terminal:sendText", { terminalId: "t1", data: "ls\r" })
    expect(shell.written).toEqual(["ls\r"])
    expect(h.reports("terminal:interacted")).toEqual([])
    await shell.write("x")
    await shell.write("y")
    expect(h.reports("terminal:interacted")).toEqual([{ pluginId: "acme.ext", terminalId: "t1" }])

    const readOnly = setup({ granted: ["terminal:spawn"] })
    await readOnly.call("terminal:create", { terminalId: "t9", kind: "process" })
    await expect(
      readOnly.call("terminal:sendText", { terminalId: "t9", data: "ls" })
    ).rejects.toThrow(/terminal:write/)
  })

  it("report how they ended: by themselves, by the user, or by the extension", async () => {
    const h = setup()
    await h.call("terminal:create", { terminalId: "self", kind: "process" })
    await h.call("terminal:create", { terminalId: "user", kind: "process" })
    await h.call("terminal:create", { terminalId: "ext", kind: "process" })
    ;(h.live.get("shell-1") as FakeShell).exit(0)
    await tick()
    h.userCloses("shell-2")
    await h.call("terminal:dispose", { terminalId: "ext" })
    await tick()
    expect(h.reports("terminal:closed")).toEqual([
      { pluginId: "acme.ext", terminalId: "self", code: 0, reason: TERMINAL_EXIT_REASON.Process },
      { pluginId: "acme.ext", terminalId: "user", reason: TERMINAL_EXIT_REASON.User },
      { pluginId: "acme.ext", terminalId: "ext", reason: TERMINAL_EXIT_REASON.Extension },
    ])
    // A process that exited keeps its tab; disposing what has ended is a no-op.
    expect(h.tabs.has("shell-1")).toBe(true)
    await expect(h.call("terminal:dispose", { terminalId: "ext" })).resolves.toBeNull()
    await expect(h.call("terminal:sendText", { terminalId: "ext", data: "x" })).rejects.toThrow(
      /has ended/
    )
  })

  it("show, hide and stay the extension's own", async () => {
    const h = setup()
    await h.call("terminal:create", { terminalId: "t1", kind: "process" })
    await h.call("terminal:show", { terminalId: "t1", preserveFocus: true })
    await h.call("terminal:hide", { terminalId: "t1" })
    expect(h.deps.show).toHaveBeenCalledWith("shell-1")
    expect(h.deps.hide).toHaveBeenCalledWith("shell-1")
    await expect(h.call("terminal:show", { terminalId: "t1" }, "other.ext")).rejects.toThrow(
      /has ended/
    )
    await expect(
      Promise.resolve().then(() =>
        handlers.get("terminal:show")!(
          { extensionId: "other.ext", terminalId: "t1" },
          { pluginId: "acme.ext", method: "terminal:show", requestId: null }
        )
      )
    ).rejects.toThrow(/ownership mismatch/)
  })
})

describe("extension terminals", () => {
  it("open a tab fed by the extension, sized, and send back what the user types", async () => {
    const h = setup({ granted: [] })
    await expect(
      h.call("terminal:create", {
        terminalId: "p1",
        kind: "pty",
        name: "REPL",
        color: "terminal.ansiGreen",
      })
    ).resolves.toEqual({ dimensions: INITIAL_DIMENSIONS })
    const session = [...h.live.values()][0] as ExtensionPtySession
    expect(session).toBeInstanceOf(ExtensionPtySession)
    expect(h.deps.addPtySession).toHaveBeenCalledWith(session, "REPL")
    expect(h.deps.setColor).toHaveBeenCalledWith(session.id, "green")

    const seen: string[] = []
    session.onData((bytes) => seen.push(new TextDecoder().decode(bytes)))
    await h.call("terminal:ptyWrite", { terminalId: "p1", data: "> " })
    expect(seen).toEqual(["> "])

    await session.write("1+1\r")
    await session.resize(40, 120)
    expect(h.reports("terminal:ptyInput")).toEqual([
      { pluginId: "acme.ext", terminalId: "p1", data: "1+1\r" },
    ])
    expect(h.reports("terminal:interacted")).toHaveLength(1)
    expect(h.reports("terminal:ptyResize")).toEqual([
      { pluginId: "acme.ext", terminalId: "p1", columns: 120, rows: 40 },
    ])
    await h.call("terminal:rename", { terminalId: "p1", name: "REPL 2" })
    expect(h.deps.setTitle).toHaveBeenCalledWith(session.id, "REPL 2")
  })

  it("close when the extension closes them: gone when it ended well, kept when it failed", async () => {
    const h = setup()
    await h.call("terminal:create", { terminalId: "ok", kind: "pty", name: "A" })
    await h.call("terminal:create", { terminalId: "bad", kind: "pty", name: "B" })
    const [ok, bad] = [...h.live.keys()]
    await h.call("terminal:ptyClose", { terminalId: "ok", code: null })
    await h.call("terminal:ptyClose", { terminalId: "bad", code: 2 })
    await tick()
    expect(h.tabs.has(ok)).toBe(false)
    expect(h.tabs.has(bad)).toBe(true)
    expect(h.reports("terminal:closed")).toEqual([
      { pluginId: "acme.ext", terminalId: "ok", reason: TERMINAL_EXIT_REASON.Process },
      { pluginId: "acme.ext", terminalId: "bad", code: 2, reason: TERMINAL_EXIT_REASON.Process },
    ])
  })

  it("report the user closing one, and the extension disposing one", async () => {
    const h = setup()
    await h.call("terminal:create", { terminalId: "u", kind: "pty", name: "A" })
    await h.call("terminal:create", { terminalId: "e", kind: "pty", name: "B" })
    const [user] = [...h.live.keys()]
    await h.deps.kill(user)
    await h.call("terminal:dispose", { terminalId: "e" })
    await tick()
    expect(h.reports("terminal:closed")).toEqual([
      { pluginId: "acme.ext", terminalId: "u", reason: TERMINAL_EXIT_REASON.User },
      { pluginId: "acme.ext", terminalId: "e", reason: TERMINAL_EXIT_REASON.Extension },
    ])
  })
})

it("tells each extension its active terminal, only when that changes", async () => {
  const h = setup()
  await h.call("terminal:create", { terminalId: "a1", kind: "process" })
  await h.call("terminal:create", { terminalId: "b1", kind: "process" }, "other.ext")
  h.setActiveTab("shell-1")
  h.setActiveTab("shell-1")
  h.setActiveTab("users-own-tab")
  expect(h.reports("terminal:activeChanged")).toEqual([
    { pluginId: "acme.ext", terminalId: "a1" },
    { pluginId: "acme.ext", terminalId: null },
    { pluginId: "other.ext", terminalId: "b1" },
    { pluginId: "acme.ext", terminalId: "a1" },
    { pluginId: "other.ext", terminalId: null },
    { pluginId: "acme.ext", terminalId: null },
  ])
})

it("a stopped extension's terminals: its own end, its shells stay with the user", async () => {
  const h = setup()
  await h.call("terminal:create", { terminalId: "shell", kind: "process" })
  await h.call("terminal:create", { terminalId: "pty", kind: "pty", name: "P" })
  const ptyId = [...h.live.keys()][1]
  clearVscodeTerminalsForPlugin("acme.ext")
  await tick()
  expect(h.deps.kill).toHaveBeenCalledWith(ptyId)
  expect(h.tabs.has("shell-1")).toBe(true)
  expect(h.reports("terminal:closed")).toEqual([])
  await expect(h.call("terminal:show", { terminalId: "shell" })).rejects.toThrow(/has ended/)
})

it("fails plainly before the loader configures it", async () => {
  await expect(
    Promise.resolve().then(() =>
      handlers.get("terminal:create")!(
        { terminalId: "t", kind: "pty" },
        { pluginId: "a.b", method: "terminal:create", requestId: null }
      )
    )
  ).rejects.toThrow(/not available yet/)
})

describe("createVscodeTerminalDependencies", () => {
  beforeEach(() => {
    __clearLiveSessionsForTesting()
    useTerminalStore.getState().reset()
    useProjectStore.setState({ activeProjectId: "p1" } as never)
  })

  it("spawns through the dock, tagged with the extension, and reports refusals", async () => {
    const deps = createVscodeTerminalDependencies({ sendToHost: jest.fn() })
    mockSpawnFromDock.mockResolvedValueOnce({ kind: "spawned", sessionId: "s1", shell: "/bin/zsh" })
    await expect(
      deps.spawn({ pluginId: "acme.ext", name: "Build", shell: "", projectId: "p1" })
    ).resolves.toEqual({ sessionId: "s1", title: "/bin/zsh" })
    expect(mockSpawnFromDock).toHaveBeenCalledWith(
      expect.objectContaining({
        req: expect.objectContaining({ extensionId: "acme.ext", shell: "", rows: 24, cols: 80 }),
        title: "Build",
      })
    )
    mockSpawnFromDock.mockResolvedValueOnce({ kind: "denied", reason: "policy" })
    await expect(deps.spawn({ pluginId: "acme.ext", shell: "" })).rejects.toThrow(
      /denied the terminal: policy/
    )
    mockSpawnFromDock.mockResolvedValueOnce({ kind: "error", message: "no transport" })
    await expect(deps.spawn({ pluginId: "acme.ext", shell: "" })).rejects.toThrow("no transport")
  })

  it("gives an extension terminal a tab, and shows, hides, renames and closes tabs", async () => {
    const deps = createVscodeTerminalDependencies({ sendToHost: jest.fn() })
    const session = new ExtensionPtySession(
      { extensionId: "acme.ext", name: "REPL", projectId: "p1" },
      { onInput: jest.fn(), onResize: jest.fn(), onKill: jest.fn() }
    )
    const changes = jest.fn()
    const stop = deps.subscribe(changes)
    deps.addPtySession(session, "REPL")
    expect(getLiveSession(session.id)).toBe(session)
    expect(deps.hasTab(session.id)).toBe(true)
    expect(deps.activeSessionId()).toBe(session.id)
    expect(mockWire).toHaveBeenCalled()
    expect(mockLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "spawned", sessionId: session.id, extensionId: "acme.ext" })
    )
    deps.show(session.id)
    expect(useTerminalStore.getState().panelOpen).toBe(true)
    deps.hide(session.id)
    expect(useTerminalStore.getState().panelOpen).toBe(false)
    deps.setTitle(session.id, "Renamed")
    expect(useTerminalStore.getState().sessions[session.id].title).toBe("Renamed")
    deps.setColor(session.id, "red")
    expect(useTerminalStore.getState().sessions[session.id].tabColor).toBe("red")
    deps.remove(session.id)
    expect(deps.hasTab(session.id)).toBe(false)
    expect(getLiveSession(session.id)).toBeUndefined()
    await deps.kill("s9")
    expect(mockKillFromDock).toHaveBeenCalledWith("s9", expect.anything())
    stop()
    expect(changes).toHaveBeenCalled()
  })
})
