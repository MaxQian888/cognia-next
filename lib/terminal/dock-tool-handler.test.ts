/**
 * Tests for the renderer-side terminal-dock-tool dispatcher.
 *
 * The handler stitches together five collaborators — settings store,
 * terminal store, session registry, agent-trust gate, and the
 * runInDockTab helper. We mock all of them so each test asserts the
 * wiring without standing up the real PTY pipeline.
 */

jest.mock("@/stores/settings", () => ({
  useSettingsStore: { getState: jest.fn() },
}))

jest.mock("@/stores/terminal/terminal-store", () => ({
  useTerminalStore: { getState: jest.fn() },
}))

jest.mock("./agent-trust", () => ({ requestAgentTrust: jest.fn() }))
jest.mock("./run-in-dock", () => ({ runInDockTab: jest.fn() }))
jest.mock("./spawn-orchestrator", () => ({ spawnFromDock: jest.fn() }))
jest.mock("./session-registry", () => ({ getLiveSession: jest.fn() }))

import { useSettingsStore } from "@/stores/settings"
import { useTerminalStore } from "@/stores/terminal/terminal-store"

import { requestAgentTrust } from "./agent-trust"
import { runTerminalDockAction } from "./dock-tool-handler"
import { runInDockTab } from "./run-in-dock"
import { getLiveSession } from "./session-registry"
import { spawnFromDock } from "./spawn-orchestrator"

const mockedSettings = useSettingsStore as jest.Mocked<typeof useSettingsStore>
const mockedTerminalStore = useTerminalStore as jest.Mocked<typeof useTerminalStore>
const mockedTrust = requestAgentTrust as jest.MockedFunction<typeof requestAgentTrust>
const mockedRunInDock = runInDockTab as jest.MockedFunction<typeof runInDockTab>
const mockedSpawn = spawnFromDock as jest.MockedFunction<typeof spawnFromDock>
const mockedGetLive = getLiveSession as jest.MockedFunction<typeof getLiveSession>

function withGate(value: boolean): void {
  mockedSettings.getState.mockReturnValue({
    settings: { terminal: { exposeDockToAgents: value, runInDockTimeoutSec: 60 } },
  } as never)
}

function withSession(
  tabId: string,
  lastCommands: Array<{ cmd: string; exitCode: number | null; endedAt: number }> = [],
  /** Chat session that spawned the tab. `null` = user-owned. */
  agentSpawner: string | null = "c"
) {
  const row = {
    id: tabId,
    title: "tab title",
    customTitle: null,
    agentSpawner,
    lastCommands,
  }
  mockedTerminalStore.getState.mockReturnValue({
    sessions: { [tabId]: row },
    // `read_recent` scopes by spawner so an agent cannot read the user's tabs
    // (or another chat's) — it has no consent prompt of its own.
    sessionsForAgent: (agentId: string) => (row.agentSpawner === agentId ? [row] : []),
  } as never)
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe("runTerminalDockAction — gate", () => {
  it("denies every action when exposeDockToAgents is off", async () => {
    withGate(false)
    const result = await runTerminalDockAction({ action: "spawn", args: {}, chatSessionId: "c1" })
    expect(result).toEqual({ ok: false, reason: "agent terminal access is disabled" })
    expect(mockedRunInDock).not.toHaveBeenCalled()
    expect(mockedSpawn).not.toHaveBeenCalled()
  })

  it("fails closed when the settings store throws", async () => {
    mockedSettings.getState.mockImplementation(() => {
      throw new Error("not initialised")
    })
    const result = await runTerminalDockAction({
      action: "write",
      args: { tabId: "t", command: "ls" },
      chatSessionId: "c1",
    })
    expect(result.ok).toBe(false)
  })
})

describe("runTerminalDockAction — spawn", () => {
  it("uses runInDockTab when a command is provided (spawn + run + wait)", async () => {
    withGate(true)
    mockedRunInDock.mockResolvedValue({
      kind: "ok",
      sessionId: "sess-1",
      exitCode: 0,
      output: "pnpm test",
    })

    const result = await runTerminalDockAction({
      action: "spawn",
      args: { command: "pnpm test", cwd: "/repo", shell: "/bin/bash", timeoutSec: 120 },
      chatSessionId: "chat-99",
    })

    expect(mockedRunInDock).toHaveBeenCalledTimes(1)
    const call = mockedRunInDock.mock.calls[0][0]
    expect(call.chatSessionId).toBe("chat-99")
    expect(call.command).toBe("pnpm test")
    expect(call.timeoutMs).toBe(120_000)
    expect(call.newTab?.req.shell).toBe("/bin/bash")
    expect(result).toEqual({ ok: true, sessionId: "sess-1", exitCode: 0, output: "pnpm test" })
  })

  it("uses spawnFromDock directly when no command is given (idle shell)", async () => {
    withGate(true)
    mockedTerminalStore.getState.mockReturnValue({} as never)
    mockedSpawn.mockResolvedValue({ kind: "spawned", sessionId: "sess-idle", shell: "/bin/bash" })

    const result = await runTerminalDockAction({
      action: "spawn",
      args: { projectId: "proj-A" },
      chatSessionId: "chat-1",
    })

    expect(mockedRunInDock).not.toHaveBeenCalled()
    expect(mockedSpawn).toHaveBeenCalledTimes(1)
    const arg = mockedSpawn.mock.calls[0][0]
    expect(arg.agentSpawner).toBe("chat-1")
    expect(arg.req.projectId).toBe("proj-A")
    expect(arg.req.enableShellIntegration).toBe(true)
    expect(result).toEqual({ ok: true, sessionId: "sess-idle" })
  })

  it("surfaces spawnFromDock 'denied' as a reason", async () => {
    withGate(true)
    mockedTerminalStore.getState.mockReturnValue({} as never)
    mockedSpawn.mockResolvedValue({ kind: "denied" })
    const result = await runTerminalDockAction({
      action: "spawn",
      args: {},
      chatSessionId: "c",
    })
    expect(result).toEqual({ ok: false, reason: "plugin policy denied terminal spawn" })
  })

  it("uses the user's runInDockTimeoutSec when no per-call timeout is given", async () => {
    mockedSettings.getState.mockReturnValue({
      settings: { terminal: { exposeDockToAgents: true, runInDockTimeoutSec: 30 } },
    } as never)
    mockedRunInDock.mockResolvedValue({ kind: "ok", sessionId: "s", exitCode: 0, output: "" })
    await runTerminalDockAction({
      action: "spawn",
      args: { command: "true" },
      chatSessionId: "c",
    })
    expect(mockedRunInDock.mock.calls[0][0].timeoutMs).toBe(30_000)
  })
})

describe("runTerminalDockAction — write", () => {
  it("requires tabId and command", async () => {
    withGate(true)
    expect(
      await runTerminalDockAction({ action: "write", args: { command: "ls" }, chatSessionId: "c" })
    ).toEqual({ ok: false, reason: "missing tabId" })
    expect(
      await runTerminalDockAction({ action: "write", args: { tabId: "t1" }, chatSessionId: "c" })
    ).toEqual({ ok: false, reason: "missing command" })
  })

  it("delegates to runInDockTab and maps the ok outcome", async () => {
    withGate(true)
    mockedRunInDock.mockResolvedValue({ kind: "ok", sessionId: "t1", exitCode: 2, output: "x" })
    const result = await runTerminalDockAction({
      action: "write",
      args: { tabId: "t1", command: "false" },
      chatSessionId: "c",
    })
    expect(result).toEqual({ ok: true, sessionId: "t1", exitCode: 2, output: "x" })
  })

  it("maps 'denied' / 'timeout' / 'error' outcomes to the discriminated reasons", async () => {
    withGate(true)
    mockedRunInDock.mockResolvedValueOnce({ kind: "denied" })
    const r1 = await runTerminalDockAction({
      action: "write",
      args: { tabId: "t1", command: "ls" },
      chatSessionId: "c",
    })
    expect(r1).toEqual({ ok: false, reason: "user denied terminal access" })

    mockedRunInDock.mockResolvedValueOnce({ kind: "timeout", sessionId: "t1" })
    const r2 = await runTerminalDockAction({
      action: "write",
      args: { tabId: "t1", command: "sleep 999" },
      chatSessionId: "c",
    })
    expect(r2).toEqual({ ok: false, reason: "timeout (session t1)" })

    mockedRunInDock.mockResolvedValueOnce({ kind: "error", message: "broke" })
    const r3 = await runTerminalDockAction({
      action: "write",
      args: { tabId: "t1", command: "ls" },
      chatSessionId: "c",
    })
    expect(r3).toEqual({ ok: false, reason: "broke" })
  })
})

describe("runTerminalDockAction — read_recent", () => {
  it("returns the last N records from the store", async () => {
    withGate(true)
    withSession("tab-A", [
      { cmd: "ls", exitCode: 0, endedAt: 1 },
      { cmd: "echo hi", exitCode: 0, endedAt: 2 },
      { cmd: "false", exitCode: 1, endedAt: 3 },
    ])
    const result = await runTerminalDockAction({
      action: "read_recent",
      args: { tabId: "tab-A", lineLimit: 2 },
      chatSessionId: "c",
    })
    expect(result).toEqual({
      ok: true,
      records: [
        { cmd: "echo hi", exitCode: 0, endedAt: 2 },
        { cmd: "false", exitCode: 1, endedAt: 3 },
      ],
    })
  })

  it("requires a tabId and reports unknown sessions", async () => {
    withGate(true)
    withSession("known")
    const noTab = await runTerminalDockAction({
      action: "read_recent",
      args: {},
      chatSessionId: "c",
    })
    expect(noTab).toEqual({ ok: false, reason: "missing tabId" })
    const unknown = await runTerminalDockAction({
      action: "read_recent",
      args: { tabId: "missing" },
      chatSessionId: "c",
    })
    expect(unknown).toEqual({ ok: false, reason: "unknown session: missing" })
  })

  it("refuses to read a tab this chat session did not spawn", async () => {
    // Regression: this path used to look the row up by raw id, so an agent
    // could read the command ring of a user-owned tab, or of another chat's.
    withGate(true)
    withSession("tab-A", [{ cmd: "ls", exitCode: 0, endedAt: 1 }], null)
    const result = await runTerminalDockAction({
      action: "read_recent",
      args: { tabId: "tab-A" },
      chatSessionId: "c",
    })
    expect(result).toEqual({ ok: false, reason: "unknown session: tab-A" })

    withSession("tab-A", [{ cmd: "ls", exitCode: 0, endedAt: 1 }], "other-chat")
    const foreign = await runTerminalDockAction({
      action: "read_recent",
      args: { tabId: "tab-A" },
      chatSessionId: "c",
    })
    expect(foreign).toEqual({ ok: false, reason: "unknown session: tab-A" })
  })

  it("clamps lineLimit to the 1..50 range with default 10", async () => {
    withGate(true)
    const lots = Array.from({ length: 30 }, (_, i) => ({
      cmd: `c${i}`,
      exitCode: 0,
      endedAt: i,
    }))
    withSession("tab-A", lots)
    const result = await runTerminalDockAction({
      action: "read_recent",
      args: { tabId: "tab-A" },
      chatSessionId: "c",
    })
    if (!("records" in result)) throw new Error("expected records branch")
    expect(result.records).toHaveLength(10)
  })
})

describe("runTerminalDockAction — wait_for_exit", () => {
  it("requires a tabId", async () => {
    withGate(true)
    const noTab = await runTerminalDockAction({
      action: "wait_for_exit",
      args: {},
      chatSessionId: "c",
    })
    expect(noTab).toEqual({ ok: false, reason: "missing tabId" })
  })

  it("fails when the live session is missing", async () => {
    withGate(true)
    withSession("tab")
    mockedGetLive.mockReturnValue(undefined)
    const result = await runTerminalDockAction({
      action: "wait_for_exit",
      args: { tabId: "tab" },
      chatSessionId: "c",
    })
    expect(result).toEqual({ ok: false, reason: "session tab is not live" })
  })

  it("denies when the user refuses consent", async () => {
    withGate(true)
    withSession("tab")
    mockedGetLive.mockReturnValue({ onIntegration: jest.fn() } as never)
    mockedTrust.mockResolvedValue(false)
    const result = await runTerminalDockAction({
      action: "wait_for_exit",
      args: { tabId: "tab" },
      chatSessionId: "c",
    })
    expect(result).toEqual({ ok: false, reason: "user denied terminal access" })
  })

  it("resolves with the next command_end event and the captured command", async () => {
    withGate(true)
    withSession("tab", [{ cmd: "ls", exitCode: 0, endedAt: 7 }])
    mockedTrust.mockResolvedValue(true)
    let listener: ((ev: { kind: string; exit_code?: number | null }) => void) | null = null
    const off = jest.fn()
    mockedGetLive.mockReturnValue({
      onIntegration: (l: (ev: { kind: string; exit_code?: number | null }) => void) => {
        listener = l
        return off
      },
    } as never)

    const promise = runTerminalDockAction({
      action: "wait_for_exit",
      args: { tabId: "tab", timeoutSec: 5 },
      chatSessionId: "c",
    })
    // The handler awaits requestAgentTrust before attaching its
    // integration listener — yield enough microtasks for that to settle.
    for (let i = 0; i < 4; i++) await Promise.resolve()
    if (!listener) throw new Error("listener not attached")
    ;(listener as (ev: { kind: string; exit_code?: number | null }) => void)({
      kind: "command_end",
      exit_code: 0,
    })

    const result = await promise
    expect(result).toEqual({
      ok: true,
      sessionId: "tab",
      exitCode: 0,
      output: "ls",
    })
    expect(off).toHaveBeenCalled()
  })

  it("times out when no command_end arrives in window", async () => {
    jest.useFakeTimers()
    try {
      withGate(true)
      withSession("tab")
      mockedTrust.mockResolvedValue(true)
      const off = jest.fn()
      mockedGetLive.mockReturnValue({ onIntegration: () => off } as never)

      const promise = runTerminalDockAction({
        action: "wait_for_exit",
        args: { tabId: "tab", timeoutSec: 5 },
        chatSessionId: "c",
      })
      await Promise.resolve()
      jest.advanceTimersByTime(5_000)
      const result = await promise
      expect(result).toEqual({ ok: false, reason: "timeout" })
      expect(off).toHaveBeenCalled()
    } finally {
      jest.useRealTimers()
    }
  })
})

describe("runTerminalDockAction — unknown action", () => {
  it("returns a structured reason", async () => {
    withGate(true)
    const result = await runTerminalDockAction({
      action: "nope" as never,
      args: {},
      chatSessionId: "c",
    })
    expect(result).toEqual({ ok: false, reason: "unknown action: nope" })
  })
})
