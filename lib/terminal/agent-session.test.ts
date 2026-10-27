/** @jest-environment jsdom */
import { BaseTerminalSession } from "./base-session"
import {
  agentTerminalStatus,
  findAgentTerminalSession,
  launchTerminalAgent,
  openAgentTerminal,
  stopTerminalAgent,
  type AgentTerminalHost,
} from "./agent-session"
import {
  __clearLiveSessionsForTesting,
  getLiveSession,
  registerLiveSession,
} from "./session-registry"
import { TerminalProfileRecoveryError } from "./rehydrate"
import { killFromDock, spawnFromDock } from "./spawn-orchestrator"
import { terminalAgentProfileId } from "@/lib/agent-ecosystem/terminal-agents"
import type { TerminalSessionRow } from "@/stores/terminal/terminal-store"
import type { SessionInfo, SpawnRequest } from "./types"

class NativeAgentFixture extends BaseTerminalSession {
  readonly info: SessionInfo
  readonly writeSpy = jest.fn(async (_data: string | Uint8Array) => {})
  readonly write = this.writeSpy
  readonly resize = jest.fn(async () => {})
  readonly detach = jest.fn(async () => {})
  readonly takeControl = jest.fn(async () => {})
  readonly releaseControl = jest.fn(async () => {})
  readonly kill = jest.fn(async () => this.finish(null))

  constructor(id: string, req: SpawnRequest) {
    super()
    this.info = {
      id,
      shell: req.shell,
      profileId: req.profileId,
      projectId: req.projectId ?? null,
      extensionId: null,
      origin: "local",
      alive: true,
    }
  }

  finish(code: number | null) {
    this.info.alive = false
    this.handleExit(code)
  }
}

function fixture() {
  const sessions: Record<string, TerminalSessionRow> = {}
  const store = {
    sessions,
    setPanelOpen: jest.fn(),
    setActiveSession: jest.fn(),
    registerSession: jest.fn((info: SessionInfo) => {
      sessions[info.id] = {
        ...info,
        status: "idle",
        cwd: null,
        createdAt: Date.now(),
        exitCode: null,
      } as TerminalSessionRow
    }),
    removeSession: jest.fn((id: string) => {
      delete sessions[id]
    }),
    setSessionStatus: jest.fn((id: string, status: TerminalSessionRow["status"]) => {
      if (sessions[id]) sessions[id].status = status
    }),
    setSessionExit: jest.fn((id: string, exitCode: number | null) => {
      if (sessions[id]) Object.assign(sessions[id], { status: "exited", exitCode })
    }),
    setSessionCwd: jest.fn((id: string, cwd: string) => {
      if (sessions[id]) sessions[id].cwd = cwd
    }),
    pushPrompt: jest.fn(),
    closePrompt: jest.fn(),
    pushCommand: jest.fn(),
  }
  const hooks = {
    dispatchTerminalWillSpawn: jest.fn(async (req: SpawnRequest) => ({ decision: "allow", req })),
    dispatchTerminalLifecycle: jest.fn(),
  }
  const native: NativeAgentFixture[] = []
  const nativeSpawn = jest.fn(async (req: SpawnRequest) => {
    const session = new NativeAgentFixture(`native-${native.length + 1}`, req)
    native.push(session)
    return session
  })
  const host: AgentTerminalHost = {
    getStore: () => store as never,
    activateProject: jest.fn(),
    spawn: jest.fn((input) =>
      spawnFromDock({ ...input, hooks: hooks as never, transportSpawns: [nativeSpawn] })
    ),
    close: jest.fn((id, current, _hooks, options) =>
      killFromDock(id, current, hooks as never, options)
    ),
    registerProfile: jest.fn(),
    releaseProfile: jest.fn(async () => {}),
    recoverProfile: jest.fn(async () => undefined),
  }
  return { store, hooks, native, nativeSpawn, host }
}

afterEach(() => __clearLiveSessionsForTesting())

describe("managed terminal agent lifecycle", () => {
  it("launches fixed argv directly, preserves literal workspace characters and submits no prompt", async () => {
    const { host, store, nativeSpawn, native } = fixture()
    const outcome = await launchTerminalAgent({
      agentId: "freebuff",
      cwd: "/work/my project;$(literal)",
      projectId: "p",
      host,
    })
    expect(outcome).toEqual({ kind: "launched", sessionId: "native-1" })
    expect(nativeSpawn).toHaveBeenCalledWith(
      expect.objectContaining({
        shell: "freebuff",
        args: [],
        cwd: "/work/my project;$(literal)",
        profileId: terminalAgentProfileId("freebuff"),
        projectId: "p",
        enableShellIntegration: false,
        forceUtf8: false,
      })
    )
    expect(native[0].writeSpy).not.toHaveBeenCalled()
    expect(store.sessions["native-1"].status).toBe("running")
    expect(store.setActiveSession).toHaveBeenCalledWith("p", "native-1")
    expect(store.setPanelOpen).toHaveBeenCalledWith(true)
  })

  it("deduplicates concurrent launches and reopens the original workspace", async () => {
    const { host, nativeSpawn, store } = fixture()
    const input = { agentId: "zcode", cwd: "/first", projectId: "first", host }
    const first = launchTerminalAgent(input)
    const second = launchTerminalAgent({ ...input, cwd: "/second", projectId: "second" })
    expect(second).toBe(first)
    await Promise.all([first, second])
    await expect(
      launchTerminalAgent({ ...input, cwd: "/second", projectId: "second" })
    ).resolves.toEqual({ kind: "opened", sessionId: "native-1" })
    expect(nativeSpawn).toHaveBeenCalledTimes(1)
    expect(host.activateProject).toHaveBeenLastCalledWith("first")
    expect(store.setActiveSession).toHaveBeenLastCalledWith("first", "native-1")
  })

  it("recovers a detached native agent before deciding whether another process may spawn", async () => {
    const { host, nativeSpawn, store } = fixture()
    const recover = host.recoverProfile as jest.Mock
    recover.mockImplementationOnce(async () => {
      const session = new NativeAgentFixture("survived-detach", {
        shell: "freebuff",
        profileId: terminalAgentProfileId("freebuff"),
        rows: 24,
        cols: 80,
        projectId: "old-project",
      })
      registerLiveSession(session)
      store.registerSession(session.info)
      return session.id
    })
    await expect(
      launchTerminalAgent({ agentId: "freebuff", cwd: "/new", projectId: "new-project", host })
    ).resolves.toEqual({ kind: "opened", sessionId: "survived-detach" })
    expect(nativeSpawn).not.toHaveBeenCalled()
    expect(host.registerProfile).not.toHaveBeenCalled()
    expect(host.activateProject).toHaveBeenCalledWith("old-project")
    expect(store.sessions["survived-detach"].status).toBe("running")
  })

  it("fails closed on an unknown host list or ambiguous live profile owners", async () => {
    const { host } = fixture()
    const recover = host.recoverProfile as jest.Mock
    recover.mockRejectedValueOnce(new Error("terminal list denied"))
    await expect(
      launchTerminalAgent({ agentId: "freebuff", cwd: "/work", host })
    ).resolves.toMatchObject({ kind: "error", code: "recovery-failed" })
    recover.mockRejectedValueOnce(new TerminalProfileRecoveryError("ambiguous", "duplicate owners"))
    await expect(
      launchTerminalAgent({ agentId: "freebuff", cwd: "/work", host })
    ).resolves.toMatchObject({ kind: "error", code: "profile-conflict" })
    expect(host.spawn).not.toHaveBeenCalled()
    expect(host.registerProfile).not.toHaveBeenCalled()
  })

  it("reports native exit rather than an idle or running shell, retaining its output tab", async () => {
    const { host, native, store } = fixture()
    await launchTerminalAgent({ agentId: "freebuff", cwd: "/work", host })
    native[0].finish(7)
    const row = findAgentTerminalSession("freebuff", store.sessions)
    expect(agentTerminalStatus(row)).toBe("exited")
    expect(row?.exitCode).toBe(7)
    expect(getLiveSession("native-1")).toBeUndefined()
    expect(openAgentTerminal("freebuff", host)).toEqual({ kind: "opened", sessionId: "native-1" })
  })

  it("cleans an exited session before launching a replacement", async () => {
    const { host, native, store } = fixture()
    await launchTerminalAgent({ agentId: "freebuff", cwd: "/work", host })
    native[0].finish(0)
    await expect(launchTerminalAgent({ agentId: "freebuff", cwd: "/new", host })).resolves.toEqual({
      kind: "launched",
      sessionId: "native-2",
    })
    expect(store.sessions["native-1"]).toBeUndefined()
    expect(host.releaseProfile).toHaveBeenCalledWith(terminalAgentProfileId("freebuff"))
    expect(store.sessions["native-2"].cwd).toBe("/new")
  })

  it("rejects unknown agents and nonabsolute/invalid workspaces before spawning", async () => {
    const { host } = fixture()
    await expect(
      launchTerminalAgent({ agentId: "shell-injection", cwd: "/work", host })
    ).resolves.toEqual({ kind: "error", code: "unknown-agent" })
    for (const cwd of ["", "relative", "/invalid\0dir"]) {
      await expect(launchTerminalAgent({ agentId: "freebuff", cwd, host })).resolves.toEqual({
        kind: "error",
        code: "invalid-workspace",
      })
    }
    expect(host.spawn).not.toHaveBeenCalled()
    expect(host.registerProfile).not.toHaveBeenCalled()
  })

  it("releases launch metadata on policy denial and native launch failure", async () => {
    const { host, hooks, nativeSpawn } = fixture()
    hooks.dispatchTerminalWillSpawn.mockResolvedValueOnce({
      decision: "deny",
      req: {} as SpawnRequest,
    })
    await expect(
      launchTerminalAgent({ agentId: "freebuff", cwd: "/work", host })
    ).resolves.toMatchObject({ kind: "error", code: "spawn-denied" })
    expect(nativeSpawn).not.toHaveBeenCalled()
    nativeSpawn.mockRejectedValueOnce(new Error("executable not found"))
    await expect(
      launchTerminalAgent({ agentId: "freebuff", cwd: "/work", host })
    ).resolves.toMatchObject({
      kind: "error",
      code: "spawn-failed",
      message: "executable not found",
    })
    expect(host.releaseProfile).toHaveBeenCalledTimes(2)
  })

  it("stops the captured process and removes its row, registry handle and transient profile", async () => {
    const { host, native, store, hooks } = fixture()
    await launchTerminalAgent({ agentId: "freebuff", cwd: "/work", host })
    await expect(stopTerminalAgent("freebuff", host)).resolves.toEqual({ kind: "stopped" })
    expect(native[0].kill).toHaveBeenCalledTimes(1)
    expect(store.sessions).toEqual({})
    expect(getLiveSession("native-1")).toBeUndefined()
    expect(host.close).toHaveBeenCalledWith("native-1", expect.anything(), undefined, {
      strict: true,
    })
    expect(hooks.dispatchTerminalLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "killed", sessionId: "native-1" })
    )
    expect(host.releaseProfile).toHaveBeenCalledWith(terminalAgentProfileId("freebuff"))
  })

  it("cleans an already spawned process if its ownership identity or UI handoff cannot be established", async () => {
    const { host, nativeSpawn, native, store } = fixture()
    nativeSpawn.mockImplementationOnce(async (req) => {
      const session = new NativeAgentFixture("wrong-profile", {
        ...req,
        profileId: "different-profile",
      })
      native.push(session)
      return session
    })
    await expect(
      launchTerminalAgent({ agentId: "freebuff", cwd: "/work", host })
    ).resolves.toMatchObject({ kind: "error", code: "spawn-failed" })
    expect(native[0].kill).toHaveBeenCalledTimes(1)
    expect(store.sessions).toEqual({})
    const activate = host.activateProject as jest.Mock
    activate.mockImplementationOnce(() => {
      throw new Error("workspace handoff failed")
    })
    await expect(
      launchTerminalAgent({ agentId: "freebuff", cwd: "/work", host })
    ).resolves.toMatchObject({ kind: "error", code: "spawn-failed" })
    expect(native[1].kill).toHaveBeenCalledTimes(1)
    expect(store.sessions).toEqual({})
  })

  it("retains a failed-stop process for retry and does not remove its host profile", async () => {
    const { host, native, store } = fixture()
    await launchTerminalAgent({ agentId: "freebuff", cwd: "/work", host })
    native[0].kill.mockRejectedValueOnce(new Error("termination refused"))
    await expect(stopTerminalAgent("freebuff", host)).resolves.toMatchObject({
      kind: "error",
      code: "stop-failed",
    })
    expect(store.sessions["native-1"]).toBeDefined()
    expect(getLiveSession("native-1")).toBe(native[0])
    expect(host.releaseProfile).not.toHaveBeenCalled()
    await expect(stopTerminalAgent("freebuff", host)).resolves.toEqual({ kind: "stopped" })
  })

  it("does not duplicate or falsely stop a row whose live connection is unavailable", async () => {
    const { host, store } = fixture()
    store.sessions.detached = {
      id: "detached",
      profileId: terminalAgentProfileId("freebuff"),
      status: "running",
      createdAt: 1,
      projectId: null,
    } as TerminalSessionRow
    expect(agentTerminalStatus(store.sessions.detached)).toBe("disconnected")
    await expect(launchTerminalAgent({ agentId: "freebuff", cwd: "/work", host })).resolves.toEqual(
      { kind: "opened", sessionId: "detached" }
    )
    await expect(stopTerminalAgent("freebuff", host)).resolves.toEqual({
      kind: "error",
      code: "session-unavailable",
    })
    expect(host.spawn).not.toHaveBeenCalled()
    expect(host.close).not.toHaveBeenCalled()
  })

  it("retries profile cleanup after the process has already stopped", async () => {
    const { host } = fixture()
    await launchTerminalAgent({ agentId: "freebuff", cwd: "/work", host })
    const release = host.releaseProfile as jest.Mock
    release.mockRejectedValueOnce(new Error("host sync unavailable"))
    await expect(stopTerminalAgent("freebuff", host)).resolves.toMatchObject({
      kind: "error",
      code: "cleanup-failed",
    })
    await expect(stopTerminalAgent("freebuff", host)).resolves.toEqual({ kind: "stopped" })
    expect(host.close).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(2)
  })

  it("waits for an in-flight launch before stopping and refuses replacement launches while stopping", async () => {
    const { host, nativeSpawn, native } = fixture()
    let release!: () => void
    const ready = new Promise<void>((resolve) => {
      release = resolve
    })
    const original = nativeSpawn.getMockImplementation()!
    nativeSpawn.mockImplementationOnce(async (req) => {
      await ready
      return original(req)
    })
    const started = launchTerminalAgent({ agentId: "freebuff", cwd: "/work", host })
    const stopped = stopTerminalAgent("freebuff", host)
    await expect(
      launchTerminalAgent({ agentId: "freebuff", cwd: "/other", host })
    ).resolves.toEqual({ kind: "error", code: "stopping" })
    release()
    await started
    await expect(stopped).resolves.toEqual({ kind: "stopped" })
    expect(native[0].kill).toHaveBeenCalledTimes(1)
  })
})
