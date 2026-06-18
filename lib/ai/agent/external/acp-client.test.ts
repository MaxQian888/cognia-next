/**
 * Smoke tests for AcpClientAdapter — exercises the public surface that runs
 * without a live ACP process. Full protocol negotiation requires a Tauri
 * runtime + child process, which jsdom can't provide; those paths are covered
 * by integration tests under src-tauri/.
 */

jest.mock("@/lib/native/external-agent", () => ({
  acpTerminalCreate: jest.fn(async () => "terminal-1"),
  acpTerminalKill: jest.fn(async () => undefined),
  acpTerminalOutput: jest.fn(async () => ({
    output: "",
    truncated: false,
    exitStatus: { exitCode: 0, signal: null },
  })),
  acpTerminalRelease: jest.fn(async () => undefined),
  acpTerminalWaitForExit: jest.fn(async () => ({
    exitStatus: { exitCode: 0, signal: null },
  })),
  acpTerminalWrite: jest.fn(async () => undefined),
}))

jest.mock("@/lib/network/proxy-fetch", () => ({
  proxyFetch: jest.fn(),
}))

// Tauri IPC + event bridge — override only invoke/listen so the stdio connect
// path can register listeners and spawn without a real desktop runtime. Keep
// the rest real (plugin-fs extends `Resource` from core, so a bare mock that
// drops it breaks module load).
jest.mock("@tauri-apps/api/core", () => ({
  ...jest.requireActual("@tauri-apps/api/core"),
  invoke: jest.fn(async () => "proc-1"),
}))
jest.mock("@tauri-apps/api/event", () => ({
  ...jest.requireActual("@tauri-apps/api/event"),
  listen: jest.fn(async () => jest.fn()),
}))

// isTauri is togglable so terminal/fs paths can be exercised both ways. cn and
// the rest of @/lib/utils stay real.
jest.mock("@/lib/utils", () => ({
  ...jest.requireActual("@/lib/utils"),
  isTauri: jest.fn(() => false),
}))

import { isTauri } from "@/lib/utils"
import { acpTerminalWrite } from "@/lib/native/external-agent"
import { listen } from "@tauri-apps/api/event"
import { invoke } from "@tauri-apps/api/core"
import { AcpClientAdapter, buildSpawnArgs, createAcpClient } from "./acp-client"
import type { ExternalAgentConfig, AcpPermissionResponse } from "@/types/agent/external-agent"

const mockIsTauri = isTauri as jest.Mock
const mockTerminalWrite = acpTerminalWrite as jest.Mock
const mockListen = listen as jest.Mock
const mockInvoke = invoke as jest.Mock

afterEach(() => {
  mockIsTauri.mockReturnValue(false)
  mockTerminalWrite.mockClear()
  mockListen.mockReset()
  mockInvoke.mockReset()
  mockListen.mockImplementation(async () => jest.fn())
  mockInvoke.mockImplementation(async () => "proc-1")
})

/** Poke the private listener bag the cleanup logic manages. */
function listenerBag(a: AcpClientAdapter): Array<() => void> {
  return (a as unknown as { unsubscribeFunctions: Array<() => void> }).unsubscribeFunctions
}
function setListenerBag(a: AcpClientAdapter, fns: Array<() => void>): void {
  ;(a as unknown as { unsubscribeFunctions: Array<() => void> }).unsubscribeFunctions = fns
}
function setStatus(a: AcpClientAdapter, status: string): void {
  ;(a as unknown as { _connectionStatus: string })._connectionStatus = status
}

function stdioConfig(): ExternalAgentConfig {
  return {
    id: "agent",
    name: "Test",
    protocol: "acp",
    transport: "stdio",
    enabled: true,
    defaultPermissionMode: "default",
    timeout: 1000,
    metadata: {},
    process: { command: "node", args: ["--stdio"] },
    createdAt: new Date(),
    updatedAt: new Date(),
  }
}

// ---- helpers for exercising the private agent-facing handlers --------------

type PermissionOption = { optionId: string; name: string; kind: string; isDefault?: boolean }
type PermissionParams = { sessionId?: string; kind?: string; options?: PermissionOption[] }
type PermissionOutcome = { outcome: { outcome: string; optionId?: string } }

const ALLOW: PermissionOption = { optionId: "allow", name: "Allow", kind: "allow_once" }
const REJECT: PermissionOption = { optionId: "reject", name: "Reject", kind: "reject_once" }

/** Seed a session with just the permissionMode the permission handler reads. */
function seedSession(a: AcpClientAdapter, id: string, permissionMode: string): void {
  ;(a as unknown as { _sessions: Map<string, { permissionMode: string }> })._sessions.set(id, {
    permissionMode,
  })
}

function callPermission(a: AcpClientAdapter, params: PermissionParams): Promise<PermissionOutcome> {
  return (
    a as unknown as { handlePermissionRequest: (p: PermissionParams) => Promise<PermissionOutcome> }
  ).handlePermissionRequest(params)
}

function callTerminalWrite(a: AcpClientAdapter, terminalId: string, data: string): Promise<void> {
  return (
    a as unknown as {
      handleTerminalWrite: (p: { terminalId: string; data: string }) => Promise<void>
    }
  ).handleTerminalWrite({ terminalId, data })
}

describe("buildSpawnArgs", () => {
  it("returns the original args verbatim when no toggles are on", () => {
    expect(buildSpawnArgs({ args: ["-y", "@anthropics/claude-code", "--stdio"] })).toEqual([
      "-y",
      "@anthropics/claude-code",
      "--stdio",
    ])
  })

  it("appends --bare and --debug when their toggles are true", () => {
    expect(
      buildSpawnArgs({
        args: ["-y", "@anthropics/claude-code", "--stdio"],
        bare: true,
        debug: true,
      })
    ).toEqual(["-y", "@anthropics/claude-code", "--stdio", "--bare", "--debug"])
  })

  it("is idempotent — does not add a flag that's already present in args", () => {
    expect(buildSpawnArgs({ args: ["--bare", "--debug"], bare: true, debug: true })).toEqual([
      "--bare",
      "--debug",
    ])
  })

  it("handles undefined args by starting from an empty list", () => {
    expect(buildSpawnArgs({ bare: true })).toEqual(["--bare"])
  })

  it("appends only the toggles that are on", () => {
    expect(buildSpawnArgs({ args: ["x"], bare: true })).toEqual(["x", "--bare"])
    expect(buildSpawnArgs({ args: ["x"], debug: true })).toEqual(["x", "--debug"])
  })
})

describe("AcpClientAdapter — basic state", () => {
  it("starts disconnected with no capabilities or tools", () => {
    const a = new AcpClientAdapter()
    expect(a.protocol).toBe("acp")
    expect(a.connectionStatus).toBe("disconnected")
    expect(a.isConnected()).toBe(false)
    expect(a.capabilities).toBeUndefined()
    expect(a.tools).toBeUndefined()
  })

  it("createAcpClient produces a fresh instance", () => {
    expect(createAcpClient()).toBeInstanceOf(AcpClientAdapter)
  })

  it("getSessionExtensionSupport returns the unknown defaults before any probe", () => {
    const a = new AcpClientAdapter()
    const support = a.getSessionExtensionSupport()
    expect(support["session/list"].state).toBe("unknown")
    expect(support["session/fork"].state).toBe("unknown")
    expect(support["session/resume"].state).toBe("unknown")
  })

  it("getAcpInitializationMetadata reports an empty contract before connect()", () => {
    const a = new AcpClientAdapter()
    const meta = a.getAcpInitializationMetadata()
    expect(meta).toEqual({
      protocolVersion: undefined,
      agentInfo: undefined,
      agentCapabilities: undefined,
      authMethods: undefined,
    })
  })

  it("getAuthMethods/isAuthenticationRequired return safe defaults pre-connect", () => {
    const a = new AcpClientAdapter()
    expect(a.getAuthMethods()).toEqual([])
    expect(a.isAuthenticationRequired()).toBe(false)
  })

  it("clearSessionExtensionSupportCache clears extension state without throwing", () => {
    const a = new AcpClientAdapter()
    expect(() => a.clearSessionExtensionSupportCache()).not.toThrow()
  })
})

describe("AcpClientAdapter — unsupported transports and missing config", () => {
  function baseConfig(overrides: Partial<ExternalAgentConfig> = {}): ExternalAgentConfig {
    return {
      id: "agent",
      name: "Test",
      protocol: "acp",
      transport: "stdio",
      enabled: true,
      defaultPermissionMode: "default",
      timeout: 1000,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    }
  }

  it("rejects stdio transport when not in Tauri runtime", async () => {
    const a = new AcpClientAdapter()
    await expect(
      a.connect(baseConfig({ transport: "stdio", process: { command: "x", args: [] } }))
    ).rejects.toThrow(/Tauri/)
  })

  it("rejects unknown transports", async () => {
    const a = new AcpClientAdapter()
    await expect(a.connect(baseConfig({ transport: "carrier-pigeon" as never }))).rejects.toThrow(
      /Unsupported transport/
    )
  })

  it("rejects http transport when network endpoint is missing", async () => {
    const a = new AcpClientAdapter()
    await expect(a.connect(baseConfig({ transport: "http" }))).rejects.toThrow(
      /Network endpoint required/
    )
  })
})

describe("AcpClientAdapter — operations on a disconnected client", () => {
  let a: AcpClientAdapter

  beforeEach(() => {
    a = new AcpClientAdapter()
  })

  it("createSession throws when not connected", async () => {
    await expect(a.createSession()).rejects.toThrow()
  })

  it("respondToPermission silently no-ops when no pending permission exists", async () => {
    await expect(
      a.respondToPermission("session-id", {
        requestId: "missing",
        outcome: { outcome: "selected", optionId: "yes" },
      } as unknown as AcpPermissionResponse)
    ).resolves.toBeUndefined()
  })

  it("setSessionModel throws for an unknown session id", async () => {
    await expect(a.setSessionModel("nope", "claude")).rejects.toThrow(/not found/i)
  })

  it("getSessionModels and getConfigOptions return undefined for unknown session", () => {
    expect(a.getSessionModels("nope")).toBeUndefined()
    expect(a.getConfigOptions("nope")).toBeUndefined()
  })

  it("setConfigOption throws without an active session", async () => {
    await expect(a.setConfigOption("nope", "k", "v")).rejects.toThrow()
  })

  it("disconnect on a disconnected client is a no-op", async () => {
    await expect(a.disconnect()).resolves.toBeUndefined()
  })

  it("healthCheck returns false when never connected", async () => {
    expect(await a.healthCheck()).toBe(false)
  })

  it("cancel on a missing session is a no-op", async () => {
    await expect(a.cancel("nope")).resolves.toBeUndefined()
  })
})

describe("AcpClientAdapter — extension handler registry", () => {
  it("registers and unregisters extension handlers without error", () => {
    const a = new AcpClientAdapter()
    const handler = jest.fn()
    a.registerExtensionHandler("_custom/method", handler)
    a.unregisterExtensionHandler("_custom/method")
    expect(handler).not.toHaveBeenCalled()
  })
})

describe("AcpClientAdapter — permission-mode auto-resolution", () => {
  it("cancels when the request names a session that does not exist", async () => {
    const a = new AcpClientAdapter()
    const res = await callPermission(a, { sessionId: "ghost", kind: "execute", options: [ALLOW] })
    expect(res.outcome.outcome).toBe("cancelled")
  })

  it("bypassPermissions auto-approves any kind, including execute", async () => {
    const a = new AcpClientAdapter()
    seedSession(a, "s", "bypassPermissions")
    const res = await callPermission(a, {
      sessionId: "s",
      kind: "execute",
      options: [ALLOW, REJECT],
    })
    expect(res.outcome).toEqual({ outcome: "selected", optionId: "allow" })
  })

  it("bypassPermissions cancels when options exist but none allow", async () => {
    const a = new AcpClientAdapter()
    seedSession(a, "s", "bypassPermissions")
    const res = await callPermission(a, { sessionId: "s", kind: "execute", options: [REJECT] })
    expect(res.outcome.outcome).toBe("cancelled")
  })

  it("plan mode auto-rejects every request (no execution)", async () => {
    const a = new AcpClientAdapter()
    seedSession(a, "s", "plan")
    const res = await callPermission(a, {
      sessionId: "s",
      kind: "execute",
      options: [ALLOW, REJECT],
    })
    expect(res.outcome).toEqual({ outcome: "selected", optionId: "reject" })
  })

  it("dontAsk mode auto-rejects every request", async () => {
    const a = new AcpClientAdapter()
    seedSession(a, "s", "dontAsk")
    const res = await callPermission(a, { sessionId: "s", kind: "write", options: [ALLOW, REJECT] })
    expect(res.outcome).toEqual({ outcome: "selected", optionId: "reject" })
  })

  it("plan/dontAsk cancel when the agent offered no reject option", async () => {
    const a = new AcpClientAdapter()
    seedSession(a, "s", "plan")
    const res = await callPermission(a, { sessionId: "s", kind: "execute", options: [ALLOW] })
    expect(res.outcome.outcome).toBe("cancelled")
  })

  it.each(["read", "file_read", "write", "file_write"])(
    "acceptEdits auto-approves the non-destructive kind %s",
    async (kind) => {
      const a = new AcpClientAdapter()
      seedSession(a, "s", "acceptEdits")
      const res = await callPermission(a, { sessionId: "s", kind, options: [ALLOW] })
      expect(res.outcome).toEqual({ outcome: "selected", optionId: "allow" })
    }
  )

  it("acceptEdits does NOT auto-approve execute — it stays pending for the UI", async () => {
    const a = new AcpClientAdapter()
    seedSession(a, "s", "acceptEdits")
    const pending = callPermission(a, { sessionId: "s", kind: "execute", options: [ALLOW, REJECT] })
    const sentinel = Symbol("pending")
    const winner = await Promise.race([
      pending,
      new Promise((r) => setTimeout(() => r(sentinel), 10)),
    ])
    expect(winner).toBe(sentinel)
  })
})

describe("AcpClientAdapter — Tauri listener lifecycle (T1)", () => {
  it("unsubscribes the partial set when connect throws mid-registration", async () => {
    mockIsTauri.mockReturnValue(true)
    const spies: Array<jest.Mock> = []
    // First listener registers; the second throws before all three are wired.
    mockListen
      .mockImplementationOnce(async () => {
        const spy = jest.fn()
        spies.push(spy)
        return spy
      })
      .mockImplementationOnce(async () => {
        throw new Error("listen boom")
      })

    const a = new AcpClientAdapter()
    await expect(a.connect(stdioConfig())).rejects.toThrow(/listen boom/)

    // The one listener that did register must have been torn down…
    expect(spies).toHaveLength(1)
    expect(spies[0]).toHaveBeenCalledTimes(1)
    // …and the bag is empty so a retry starts clean.
    expect(listenerBag(a)).toHaveLength(0)
    expect(a.connectionStatus).toBe("error")
  })

  it("clears stale listeners on reconnect-after-error and does not accumulate", async () => {
    mockIsTauri.mockReturnValue(true)
    const a = new AcpClientAdapter()

    // Simulate a prior failed connect that left listeners behind.
    const stale = [jest.fn(), jest.fn(), jest.fn()]
    setListenerBag(a, [...stale])
    setStatus(a, "error")

    // Registration succeeds (fresh spies), but initialize() fails fast so the
    // error path runs without a live process.
    const fresh: Array<jest.Mock> = []
    mockListen.mockImplementation(async () => {
      const spy = jest.fn()
      fresh.push(spy)
      return spy
    })
    ;(a as unknown as { initialize: () => Promise<unknown> }).initialize = jest.fn(async () => {
      throw new Error("init boom")
    })

    await expect(a.connect(stdioConfig())).rejects.toThrow(/init boom/)

    // Stale listeners were unsubscribed at connectViaStdio entry…
    for (const fn of stale) expect(fn).toHaveBeenCalledTimes(1)
    // …the fresh set was unsubscribed in the connect() catch…
    expect(fresh.length).toBeGreaterThan(0)
    for (const fn of fresh) expect(fn).toHaveBeenCalledTimes(1)
    // …and nothing accumulated.
    expect(listenerBag(a)).toHaveLength(0)
  })

  it("ignores a throwing unsubscribe and still tears down the rest", async () => {
    const a = new AcpClientAdapter()
    const good = jest.fn()
    setListenerBag(a, [
      () => {
        throw new Error("unsub boom")
      },
      good,
    ])
    setStatus(a, "connected")

    await expect(a.disconnect()).resolves.toBeUndefined()
    expect(good).toHaveBeenCalledTimes(1)
    expect(listenerBag(a)).toHaveLength(0)
  })

  it("disconnect unsubscribes every listener and empties the bag", async () => {
    const a = new AcpClientAdapter()
    const spies = [jest.fn(), jest.fn()]
    setListenerBag(a, [...spies])
    setStatus(a, "connected")

    await a.disconnect()

    for (const fn of spies) expect(fn).toHaveBeenCalledTimes(1)
    expect(listenerBag(a)).toHaveLength(0)
    expect(a.connectionStatus).toBe("disconnected")
  })
})

describe("AcpClientAdapter — terminal/write", () => {
  it("throws outside Tauri", async () => {
    mockIsTauri.mockReturnValue(false)
    const a = new AcpClientAdapter()
    await expect(callTerminalWrite(a, "t1", "echo hi\n")).rejects.toThrow(/Tauri/)
    expect(mockTerminalWrite).not.toHaveBeenCalled()
  })

  it("delegates to the native binding inside Tauri", async () => {
    mockIsTauri.mockReturnValue(true)
    const a = new AcpClientAdapter()
    await expect(callTerminalWrite(a, "t1", "echo hi\n")).resolves.toBeUndefined()
    expect(mockTerminalWrite).toHaveBeenCalledWith("t1", "echo hi\n")
  })
})
