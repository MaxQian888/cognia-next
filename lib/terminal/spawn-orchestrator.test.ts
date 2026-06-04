/**
 * @jest-environment jsdom
 */

import { spawnFromDock, killFromDock, restartFromDock } from "./spawn-orchestrator"
import { __clearLiveSessionsForTesting, getLiveSession } from "./session-registry"
import type { SpawnRequest, SessionInfo } from "./types"

// The persist path (`persistCommandHistory`) lazy-imports these three —
// mocked so command_end events in every test stay deterministic and the
// durable-history gating is assertable.
jest.mock("@/lib/db/terminal-history", () => ({
  recordTerminalHistory: jest.fn(async () => undefined),
}))
jest.mock("@/stores/settings/settings-store", () => {
  const state = { persistHistory: undefined as boolean | undefined }
  return {
    __mockSettingsState: state,
    useSettingsStore: {
      getState: () => ({
        settings: { terminal: { autocomplete: { persistHistory: state.persistHistory } } },
      }),
    },
  }
})
jest.mock("@/lib/twin/ingest/redact", () => {
  const state = { piiOk: true }
  return {
    __mockPiiState: state,
    hasNoLeakingPii: () => state.piiOk,
  }
})

const { recordTerminalHistory: mockRecordHistory } = jest.requireMock(
  "@/lib/db/terminal-history"
) as { recordTerminalHistory: jest.Mock }
const { __mockSettingsState } = jest.requireMock("@/stores/settings/settings-store") as {
  __mockSettingsState: { persistHistory: boolean | undefined }
}
const { __mockPiiState } = jest.requireMock("@/lib/twin/ingest/redact") as {
  __mockPiiState: { piiOk: boolean }
}

/** Flush the fire-and-forget persist chain (dynamic imports + awaits). */
async function flushPersist(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

interface FakeSession {
  info: SessionInfo
  killed: number
  writes: Array<string | Uint8Array>
  onIntegrationListeners: Array<
    (e: { kind: string; cwd?: string; exit_code?: number | null }) => void
  >
  onExitListeners: Array<(code: number | null) => void>
  id: string
  kill: () => Promise<void>
  write: (data: string | Uint8Array) => Promise<void>
  onIntegration: (
    l: (e: { kind: string; cwd?: string; exit_code?: number | null }) => void
  ) => () => void
  onExit: (l: (c: number | null) => void) => () => void
}

function makeFakeSession(id: string, info: Partial<SessionInfo> = {}): FakeSession {
  const fullInfo: SessionInfo = {
    id,
    projectId: "proj-a",
    extensionId: null,
    origin: "local",
    shell: "/bin/bash",
    ...info,
  }
  const onIntegrationListeners: FakeSession["onIntegrationListeners"] = []
  const onExitListeners: FakeSession["onExitListeners"] = []
  const session: FakeSession = {
    info: fullInfo,
    killed: 0,
    writes: [],
    onIntegrationListeners,
    onExitListeners,
    id,
    kill: async () => {
      session.killed += 1
    },
    write: async (data) => {
      session.writes.push(data)
    },
    onIntegration: (l) => {
      onIntegrationListeners.push(l)
      return () => {}
    },
    onExit: (l) => {
      onExitListeners.push(l)
      return () => {}
    },
  }
  return session
}

interface FakeStoreRow {
  id: string
  shell: string
  cwd: string | null
  projectId: string | null
  extensionId: string | null
  agentSpawner: string | null
}

interface FakeStore {
  registered: Array<{ info: SessionInfo; opts?: { title?: string; agentSpawner?: string } }>
  removed: string[]
  statusUpdates: Array<[string, string]>
  exitUpdates: Array<[string, number | null]>
  cwdUpdates: Array<[string, string]>
  prompts: Array<{ id: string; kind: "open" | "close"; ts: number }>
  commands: Array<{ id: string; cmd: string; exitCode: number | null; endedAt: number }>
  sessions: Record<string, FakeStoreRow>
  registerSession: (
    info: Partial<SessionInfo> & { id: string },
    opts?: { title?: string; agentSpawner?: string }
  ) => void
  removeSession: (id: string) => void
  setSessionStatus: (id: string, s: "idle" | "running" | "exited") => void
  setSessionExit: (id: string, code: number | null) => void
  setSessionCwd: (id: string, cwd: string) => void
  pushPrompt: (id: string, ts: number) => void
  closePrompt: (id: string, ts: number) => void
  pushCommand: (
    id: string,
    record: { cmd: string; exitCode: number | null; endedAt: number }
  ) => void
}

function makeFakeStore(): FakeStore {
  const registered: FakeStore["registered"] = []
  const removed: string[] = []
  const statusUpdates: Array<[string, string]> = []
  const exitUpdates: Array<[string, number | null]> = []
  const cwdUpdates: Array<[string, string]> = []
  const prompts: FakeStore["prompts"] = []
  const commands: FakeStore["commands"] = []
  const sessions: Record<string, FakeStoreRow> = {}
  return {
    registered,
    removed,
    statusUpdates,
    exitUpdates,
    cwdUpdates,
    prompts,
    commands,
    sessions,
    registerSession: (info, opts) => {
      registered.push({ info: info as SessionInfo, opts })
      sessions[info.id] = {
        id: info.id,
        shell: (info as SessionInfo).shell,
        cwd: null,
        projectId: (info as SessionInfo).projectId ?? null,
        extensionId: (info as SessionInfo).extensionId ?? null,
        agentSpawner: opts?.agentSpawner ?? null,
      }
    },
    removeSession: (id) => {
      removed.push(id)
      delete sessions[id]
    },
    setSessionStatus: (id, s) => {
      statusUpdates.push([id, s])
    },
    setSessionExit: (id, code) => {
      exitUpdates.push([id, code])
    },
    setSessionCwd: (id, cwd) => {
      cwdUpdates.push([id, cwd])
      if (sessions[id]) sessions[id].cwd = cwd
    },
    pushPrompt: (id, ts) => {
      prompts.push({ id, kind: "open", ts })
    },
    closePrompt: (id, ts) => {
      prompts.push({ id, kind: "close", ts })
    },
    pushCommand: (id, record) => {
      commands.push({ id, ...record })
    },
  }
}

interface FakeHooks {
  willSpawnDecision: "allow" | "deny"
  willSpawnMutate?: Partial<SpawnRequest>
  lifecycle: Array<{ kind: string; sessionId: string }>
  dispatchTerminalWillSpawn: (
    req: SpawnRequest
  ) => Promise<{ decision: "allow" | "deny"; req: SpawnRequest }>
  dispatchTerminalLifecycle: (e: { kind: string; sessionId: string }) => void
}

function makeFakeHooks(): FakeHooks {
  const hooks: FakeHooks = {
    willSpawnDecision: "allow",
    willSpawnMutate: undefined,
    lifecycle: [],
    dispatchTerminalWillSpawn: async (req) => {
      if (hooks.willSpawnDecision === "deny") return { decision: "deny", req }
      return { decision: "allow", req: { ...req, ...hooks.willSpawnMutate } }
    },
    dispatchTerminalLifecycle: (e) => {
      hooks.lifecycle.push(e)
    },
  }
  return hooks
}

const baseReq: SpawnRequest = {
  shell: "/bin/bash",
  rows: 24,
  cols: 80,
  projectId: "proj-a",
}

beforeEach(() => {
  __clearLiveSessionsForTesting()
  mockRecordHistory.mockClear()
  __mockSettingsState.persistHistory = undefined
  __mockPiiState.piiOk = true
})

describe("spawnFromDock", () => {
  it("denies the spawn when a plugin returns 'deny'", async () => {
    const hooks = makeFakeHooks()
    hooks.willSpawnDecision = "deny"
    const store = makeFakeStore()
    const out = await spawnFromDock({
      req: baseReq,
      store,
      hooks: hooks as unknown as ReturnType<typeof import("@/lib/plugin").getPluginEventHooks>,
      spawn: async () =>
        makeFakeSession("never") as unknown as Awaited<
          ReturnType<typeof import("./session").TerminalSession.spawn>
        >,
    })
    expect(out.kind).toBe("denied")
    expect(store.registered).toHaveLength(0)
  })

  it("registers the session in store + live registry on success", async () => {
    const hooks = makeFakeHooks()
    const store = makeFakeStore()
    const fake = makeFakeSession("s-1")
    const out = await spawnFromDock({
      req: baseReq,
      store,
      hooks: hooks as unknown as ReturnType<typeof import("@/lib/plugin").getPluginEventHooks>,
      spawn: async () =>
        fake as unknown as Awaited<ReturnType<typeof import("./session").TerminalSession.spawn>>,
    })
    expect(out.kind).toBe("spawned")
    expect(store.registered.map((r) => r.info.id)).toEqual(["s-1"])
    expect(getLiveSession("s-1")).toBe(fake)
  })

  it("threads agentSpawner through registerSession", async () => {
    const hooks = makeFakeHooks()
    const store = makeFakeStore()
    const fake = makeFakeSession("s-1")
    await spawnFromDock({
      req: baseReq,
      store,
      agentSpawner: "claude:sess-9",
      hooks: hooks as unknown as ReturnType<typeof import("@/lib/plugin").getPluginEventHooks>,
      spawn: async () =>
        fake as unknown as Awaited<ReturnType<typeof import("./session").TerminalSession.spawn>>,
    })
    expect(store.registered[0]?.opts?.agentSpawner).toBe("claude:sess-9")
    expect(store.sessions["s-1"]?.agentSpawner).toBe("claude:sess-9")
  })

  it("wires command_start / command_end → status updates", async () => {
    const hooks = makeFakeHooks()
    const store = makeFakeStore()
    const fake = makeFakeSession("s-1")
    await spawnFromDock({
      req: baseReq,
      store,
      hooks: hooks as unknown as ReturnType<typeof import("@/lib/plugin").getPluginEventHooks>,
      spawn: async () =>
        fake as unknown as Awaited<ReturnType<typeof import("./session").TerminalSession.spawn>>,
    })
    fake.onIntegrationListeners[0]?.({ kind: "command_start" })
    fake.onIntegrationListeners[0]?.({ kind: "command_end", exit_code: 0 })
    expect(store.statusUpdates).toEqual([
      ["s-1", "running"],
      ["s-1", "idle"],
    ])
  })

  it("wires cwd_changed → store cwd update", async () => {
    const hooks = makeFakeHooks()
    const store = makeFakeStore()
    const fake = makeFakeSession("s-1")
    await spawnFromDock({
      req: baseReq,
      store,
      hooks: hooks as unknown as ReturnType<typeof import("@/lib/plugin").getPluginEventHooks>,
      spawn: async () =>
        fake as unknown as Awaited<ReturnType<typeof import("./session").TerminalSession.spawn>>,
    })
    fake.onIntegrationListeners[0]?.({ kind: "cwd_changed", cwd: "/tmp/x" })
    expect(store.cwdUpdates).toEqual([["s-1", "/tmp/x"]])
  })

  it("wires exit → exitCode in store + unregisters from live registry", async () => {
    const hooks = makeFakeHooks()
    const store = makeFakeStore()
    const fake = makeFakeSession("s-1")
    await spawnFromDock({
      req: baseReq,
      store,
      hooks: hooks as unknown as ReturnType<typeof import("@/lib/plugin").getPluginEventHooks>,
      spawn: async () =>
        fake as unknown as Awaited<ReturnType<typeof import("./session").TerminalSession.spawn>>,
    })
    fake.onExitListeners[0]?.(7)
    expect(store.exitUpdates).toEqual([["s-1", 7]])
    expect(getLiveSession("s-1")).toBeUndefined()
  })

  it("emits a 'spawned' lifecycle event on success", async () => {
    const hooks = makeFakeHooks()
    const store = makeFakeStore()
    const fake = makeFakeSession("s-1")
    await spawnFromDock({
      req: baseReq,
      store,
      hooks: hooks as unknown as ReturnType<typeof import("@/lib/plugin").getPluginEventHooks>,
      spawn: async () =>
        fake as unknown as Awaited<ReturnType<typeof import("./session").TerminalSession.spawn>>,
    })
    expect(hooks.lifecycle.find((e) => e.kind === "spawned")).toBeDefined()
  })

  it("returns 'error' when the spawn function throws", async () => {
    const hooks = makeFakeHooks()
    const store = makeFakeStore()
    const out = await spawnFromDock({
      req: baseReq,
      store,
      hooks: hooks as unknown as ReturnType<typeof import("@/lib/plugin").getPluginEventHooks>,
      spawn: async () => {
        throw new Error("shell not found")
      },
    })
    expect(out.kind).toBe("error")
    if (out.kind === "error") {
      expect(out.message).toBe("shell not found")
    }
    expect(store.registered).toHaveLength(0)
  })

  it("forwards prompt_start / prompt_end to store.pushPrompt / closePrompt", async () => {
    const hooks = makeFakeHooks()
    const store = makeFakeStore()
    const fake = makeFakeSession("s-1")
    await spawnFromDock({
      req: baseReq,
      store,
      hooks: hooks as unknown as ReturnType<typeof import("@/lib/plugin").getPluginEventHooks>,
      spawn: async () =>
        fake as unknown as Awaited<ReturnType<typeof import("./session").TerminalSession.spawn>>,
    })
    fake.onIntegrationListeners[0]?.({ kind: "prompt_start" })
    fake.onIntegrationListeners[0]?.({ kind: "prompt_end" })
    expect(store.prompts.map((p) => p.kind)).toEqual(["open", "close"])
    expect(store.prompts.every((p) => p.id === "s-1")).toBe(true)
  })

  it("captures the typed command line and pushes it on command_end", async () => {
    const hooks = makeFakeHooks()
    const store = makeFakeStore()
    const fake = makeFakeSession("s-1")
    await spawnFromDock({
      req: baseReq,
      store,
      hooks: hooks as unknown as ReturnType<typeof import("@/lib/plugin").getPluginEventHooks>,
      spawn: async () =>
        fake as unknown as Awaited<ReturnType<typeof import("./session").TerminalSession.spawn>>,
    })
    // User types `ls -la\r`. Pre-Enter we expect the buffer to fill; the CR
    // freezes it; command_start arms; command_end pushes.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (fake as any).write("ls -la")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (fake as any).write("\r")
    fake.onIntegrationListeners[0]?.({ kind: "command_start" })
    fake.onIntegrationListeners[0]?.({ kind: "command_end", exit_code: 0 })
    expect(store.commands).toHaveLength(1)
    expect(store.commands[0]).toMatchObject({ id: "s-1", cmd: "ls -la", exitCode: 0 })
  })

  it("handles backspace + DEL while capturing input", async () => {
    const hooks = makeFakeHooks()
    const store = makeFakeStore()
    const fake = makeFakeSession("s-1")
    await spawnFromDock({
      req: baseReq,
      store,
      hooks: hooks as unknown as ReturnType<typeof import("@/lib/plugin").getPluginEventHooks>,
      spawn: async () =>
        fake as unknown as Awaited<ReturnType<typeof import("./session").TerminalSession.spawn>>,
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (fake as any).write("lz") // typo
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (fake as any).write("\x7f") // DEL — delete 'z'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (fake as any).write("s\r")
    fake.onIntegrationListeners[0]?.({ kind: "command_start" })
    fake.onIntegrationListeners[0]?.({ kind: "command_end", exit_code: 0 })
    expect(store.commands[0]?.cmd).toBe("ls")
  })

  it("skips ANSI CSI sequences (arrow keys) when capturing", async () => {
    const hooks = makeFakeHooks()
    const store = makeFakeStore()
    const fake = makeFakeSession("s-1")
    await spawnFromDock({
      req: baseReq,
      store,
      hooks: hooks as unknown as ReturnType<typeof import("@/lib/plugin").getPluginEventHooks>,
      spawn: async () =>
        fake as unknown as Awaited<ReturnType<typeof import("./session").TerminalSession.spawn>>,
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (fake as any).write("ls\x1b[A\r") // typed `ls`, then arrow-up, then Enter
    fake.onIntegrationListeners[0]?.({ kind: "command_start" })
    fake.onIntegrationListeners[0]?.({ kind: "command_end", exit_code: 0 })
    expect(store.commands[0]?.cmd).toBe("ls")
  })

  it("Ctrl+C clears the pending capture", async () => {
    const hooks = makeFakeHooks()
    const store = makeFakeStore()
    const fake = makeFakeSession("s-1")
    await spawnFromDock({
      req: baseReq,
      store,
      hooks: hooks as unknown as ReturnType<typeof import("@/lib/plugin").getPluginEventHooks>,
      spawn: async () =>
        fake as unknown as Awaited<ReturnType<typeof import("./session").TerminalSession.spawn>>,
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (fake as any).write("rm -rf /\x03") // typed dangerous, then Ctrl+C
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (fake as any).write("ls\r")
    fake.onIntegrationListeners[0]?.({ kind: "command_start" })
    fake.onIntegrationListeners[0]?.({ kind: "command_end", exit_code: 0 })
    expect(store.commands[0]?.cmd).toBe("ls")
  })

  describe("durable history persistence", () => {
    async function runCommand(cmd: string, exitCode = 0) {
      const hooks = makeFakeHooks()
      const store = makeFakeStore()
      const fake = makeFakeSession("s-1")
      await spawnFromDock({
        req: baseReq,
        store,
        hooks: hooks as unknown as ReturnType<typeof import("@/lib/plugin").getPluginEventHooks>,
        spawn: async () =>
          fake as unknown as Awaited<ReturnType<typeof import("./session").TerminalSession.spawn>>,
      })
      fake.onIntegrationListeners[0]?.({ kind: "cwd_changed", cwd: "/work" })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (fake as any).write(`${cmd}\r`)
      fake.onIntegrationListeners[0]?.({ kind: "command_start" })
      fake.onIntegrationListeners[0]?.({ kind: "command_end", exit_code: exitCode })
      await flushPersist()
      return { store, fake }
    }

    it("records the command with shell, cwd, project, and exit code", async () => {
      await runCommand("git status")
      expect(mockRecordHistory).toHaveBeenCalledWith({
        command: "git status",
        shell: "/bin/bash",
        cwd: "/work",
        exitCode: 0,
        sessionId: "s-1",
        projectId: "proj-a",
      })
    })

    it("still pushes the ring record exactly once (consume-once capture)", async () => {
      const { store } = await runCommand("ls -la")
      expect(store.commands).toHaveLength(1)
      expect(store.commands[0]?.cmd).toBe("ls -la")
      expect(mockRecordHistory).toHaveBeenCalledTimes(1)
    })

    it("skips persistence when the setting is off", async () => {
      __mockSettingsState.persistHistory = false
      await runCommand("git status")
      expect(mockRecordHistory).not.toHaveBeenCalled()
    })

    it("skips persistence when the PII gate fails", async () => {
      __mockPiiState.piiOk = false
      await runCommand("export TOKEN=sk-secret")
      expect(mockRecordHistory).not.toHaveBeenCalled()
    })

    it("skips persistence for an empty captured command", async () => {
      const hooks = makeFakeHooks()
      const store = makeFakeStore()
      const fake = makeFakeSession("s-1")
      await spawnFromDock({
        req: baseReq,
        store,
        hooks: hooks as unknown as ReturnType<typeof import("@/lib/plugin").getPluginEventHooks>,
        spawn: async () =>
          fake as unknown as Awaited<ReturnType<typeof import("./session").TerminalSession.spawn>>,
      })
      // command_end with no typed input → blank capture.
      fake.onIntegrationListeners[0]?.({ kind: "command_end", exit_code: 0 })
      await flushPersist()
      expect(mockRecordHistory).not.toHaveBeenCalled()
    })

    it("never throws when the history write rejects", async () => {
      mockRecordHistory.mockRejectedValueOnce(new Error("quota exceeded"))
      await expect(runCommand("git status")).resolves.toBeDefined()
    })
  })

  it("honors mutated request from the plugin hook", async () => {
    const hooks = makeFakeHooks()
    hooks.willSpawnMutate = { shell: "/usr/local/bin/fish" }
    const store = makeFakeStore()
    let capturedReq: SpawnRequest | null = null
    const fake = makeFakeSession("s-1")
    await spawnFromDock({
      req: baseReq,
      store,
      hooks: hooks as unknown as ReturnType<typeof import("@/lib/plugin").getPluginEventHooks>,
      spawn: async (r) => {
        capturedReq = r
        return fake as unknown as Awaited<
          ReturnType<typeof import("./session").TerminalSession.spawn>
        >
      },
    })
    expect(capturedReq!.shell).toBe("/usr/local/bin/fish")
  })
})

describe("killFromDock", () => {
  it("calls session.kill, fires 'killed' lifecycle, and removes the store row", async () => {
    const hooks = makeFakeHooks()
    const store = makeFakeStore()
    const fake = makeFakeSession("s-1")
    await spawnFromDock({
      req: baseReq,
      store,
      hooks: hooks as unknown as ReturnType<typeof import("@/lib/plugin").getPluginEventHooks>,
      spawn: async () =>
        fake as unknown as Awaited<ReturnType<typeof import("./session").TerminalSession.spawn>>,
    })
    await killFromDock(
      "s-1",
      store,
      hooks as unknown as ReturnType<typeof import("@/lib/plugin").getPluginEventHooks>
    )
    expect(fake.killed).toBe(1)
    expect(store.removed).toEqual(["s-1"])
    expect(hooks.lifecycle.find((e) => e.kind === "killed")).toBeDefined()
  })

  it("is safe to call for an unknown session id", async () => {
    const hooks = makeFakeHooks()
    const store = makeFakeStore()
    await expect(
      killFromDock(
        "ghost",
        store,
        hooks as unknown as ReturnType<typeof import("@/lib/plugin").getPluginEventHooks>
      )
    ).resolves.not.toThrow()
    expect(store.removed).toEqual(["ghost"])
  })
})

describe("restartFromDock", () => {
  it("respawns with the previous row's shell + cwd + agent identity", async () => {
    const hooks = makeFakeHooks()
    const store = makeFakeStore()
    const fakeA = makeFakeSession("s-1", { shell: "/bin/bash" })
    await spawnFromDock({
      req: baseReq,
      store,
      agentSpawner: "claude:abc",
      hooks: hooks as unknown as ReturnType<typeof import("@/lib/plugin").getPluginEventHooks>,
      spawn: async () =>
        fakeA as unknown as Awaited<ReturnType<typeof import("./session").TerminalSession.spawn>>,
    })
    fakeA.onIntegrationListeners[0]?.({ kind: "cwd_changed", cwd: "/work/cog" })
    let capturedReq: SpawnRequest | null = null
    const fakeB = makeFakeSession("s-2", { shell: "/bin/bash" })
    const out = await restartFromDock({
      sessionId: "s-1",
      store,
      rows: 30,
      cols: 100,
      hooks: hooks as unknown as ReturnType<typeof import("@/lib/plugin").getPluginEventHooks>,
      spawn: async (r) => {
        capturedReq = r
        return fakeB as unknown as Awaited<
          ReturnType<typeof import("./session").TerminalSession.spawn>
        >
      },
    })
    expect(out.kind).toBe("spawned")
    expect(fakeA.killed).toBe(1)
    expect(capturedReq!.shell).toBe("/bin/bash")
    expect(capturedReq!.cwd).toBe("/work/cog")
    expect(capturedReq!.rows).toBe(30)
    expect(capturedReq!.cols).toBe(100)
    // agent identity carries to the new tab
    expect(store.registered.at(-1)?.opts?.agentSpawner).toBe("claude:abc")
  })

  it("returns error on unknown session id", async () => {
    const hooks = makeFakeHooks()
    const store = makeFakeStore()
    const out = await restartFromDock({
      sessionId: "ghost",
      store,
      rows: 24,
      cols: 80,
      hooks: hooks as unknown as ReturnType<typeof import("@/lib/plugin").getPluginEventHooks>,
      spawn: async () =>
        makeFakeSession("never") as unknown as Awaited<
          ReturnType<typeof import("./session").TerminalSession.spawn>
        >,
    })
    expect(out.kind).toBe("error")
  })
})
