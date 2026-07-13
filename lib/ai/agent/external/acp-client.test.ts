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
import {
  AcpClientAdapter,
  buildSpawnArgs,
  createAcpClient,
  SUPPORTED_ACP_PROTOCOL_VERSIONS,
  LATEST_ACP_PROTOCOL_VERSION,
  RAPID_EXIT_THRESHOLD_MS,
  MAX_RAPID_EXITS,
} from "./acp-client"
import type { ExternalAgentConfig, AcpPermissionResponse } from "@/types/agent/external-agent"
import { loggers } from "@cognia/logging"
import { LOG_VALUE_MAX_CHARS, truncateForLog } from "@cognia/logging/truncate"

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
type PermissionParams = {
  sessionId?: string
  kind?: string
  title?: string
  rawInput?: Record<string, unknown>
  options?: PermissionOption[]
  // Spec shape nests the tool-call fields under `toolCall`.
  toolCall?: {
    toolCallId?: string
    title?: string
    kind?: string
    rawInput?: Record<string, unknown>
  }
}
type PermissionOutcome = { outcome: { outcome: string; optionId?: string } }

const ALLOW: PermissionOption = { optionId: "allow", name: "Allow", kind: "allow_once" }
const REJECT: PermissionOption = { optionId: "reject", name: "Reject", kind: "reject_once" }

/** Seed a session with the permissionMode (and optional allow-list) the
 * permission handler reads. */
function seedSession(
  a: AcpClientAdapter,
  id: string,
  permissionMode: string,
  allowedTools?: string[]
): void {
  ;(
    a as unknown as {
      _sessions: Map<string, { permissionMode: string; allowedTools?: string[] }>
    }
  )._sessions.set(id, { permissionMode, allowedTools })
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

  it("dontAsk mode rejects a tool that is not pre-approved", async () => {
    const a = new AcpClientAdapter()
    seedSession(a, "s", "dontAsk", ["Read"])
    const res = await callPermission(a, {
      sessionId: "s",
      title: "Bash",
      kind: "execute",
      options: [ALLOW, REJECT],
    })
    expect(res.outcome).toEqual({ outcome: "selected", optionId: "reject" })
  })

  it("dontAsk mode rejects everything when no allow-list is configured", async () => {
    const a = new AcpClientAdapter()
    seedSession(a, "s", "dontAsk")
    const res = await callPermission(a, {
      sessionId: "s",
      title: "Read",
      kind: "read",
      options: [ALLOW, REJECT],
    })
    expect(res.outcome).toEqual({ outcome: "selected", optionId: "reject" })
  })

  it("dontAsk mode silently approves a pre-approved tool", async () => {
    const a = new AcpClientAdapter()
    seedSession(a, "s", "dontAsk", ["Read", "Bash(git*)"])
    // Bare-name match.
    const read = await callPermission(a, {
      sessionId: "s",
      title: "Read",
      kind: "read",
      options: [ALLOW, REJECT],
    })
    expect(read.outcome).toEqual({ outcome: "selected", optionId: "allow" })
    // Specifier match against the tool's rawInput command.
    const bash = await callPermission(a, {
      sessionId: "s",
      toolCall: { title: "Bash", kind: "execute", rawInput: { command: "git status" } },
      options: [ALLOW, REJECT],
    })
    expect(bash.outcome).toEqual({ outcome: "selected", optionId: "allow" })
    // Specifier miss → rejected.
    const rm = await callPermission(a, {
      sessionId: "s",
      toolCall: { title: "Bash", kind: "execute", rawInput: { command: "rm -rf /" } },
      options: [ALLOW, REJECT],
    })
    expect(rm.outcome).toEqual({ outcome: "selected", optionId: "reject" })
  })

  it("dontAsk pre-approval still cancels when no allow option is offered", async () => {
    const a = new AcpClientAdapter()
    seedSession(a, "s", "dontAsk", ["Read"])
    const res = await callPermission(a, {
      sessionId: "s",
      title: "Read",
      kind: "read",
      options: [REJECT],
    })
    // Pre-approved but the agent offered no allow option → reject wins.
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

  it("reads the spec-nested toolCall shape (kind under params.toolCall)", async () => {
    // Per ACP, RequestPermissionRequest nests tool-call fields under `toolCall`.
    // acceptEdits only auto-approves non-destructive kinds, so reading the
    // nested `kind: "write"` proves the handler unwraps `toolCall` (a flat call
    // with no top-level kind would have an undefined kind and stay pending).
    const a = new AcpClientAdapter()
    seedSession(a, "s", "acceptEdits")
    const res = await callPermission(a, {
      sessionId: "s",
      toolCall: { toolCallId: "tc1", title: "Edit file", kind: "write" },
      options: [ALLOW, REJECT],
    })
    expect(res.outcome).toEqual({ outcome: "selected", optionId: "allow" })
  })

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

// After the JsonRpcPeer migration (json-rpc-peer.ts), the request/response loop
// is delegated to the shared peer. These tests drive a real stdio connect over
// the mocked Tauri bridge to lock the integration seam: outbound framing keeps
// the `jsonrpc:"2.0"` field, an inbound response resolves the pending request,
// and an inbound server→client request gets a response written back.
describe("AcpClientAdapter — JsonRpcPeer integration over stdio", () => {
  function connectWithStdio(): {
    adapter: AcpClientAdapter
    sent: Array<Record<string, unknown>>
    feed: (frame: Record<string, unknown>) => void
    connected: Promise<void>
  } {
    mockIsTauri.mockReturnValue(true)
    const sent: Array<Record<string, unknown>> = []
    let stdoutCb: ((event: { payload: { agentId: string; data: string } }) => void) | undefined

    mockListen.mockImplementation(async (channel: string, cb: (e: unknown) => void) => {
      if (channel === "external-agent://stdout") {
        stdoutCb = cb as typeof stdoutCb
      }
      return jest.fn()
    })
    const feed = (frame: Record<string, unknown>) =>
      stdoutCb?.({ payload: { agentId: "proc-1", data: JSON.stringify(frame) } })

    mockInvoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "spawn_external_agent") return "proc-1"
      if (cmd === "send_to_external_agent") {
        const msg = JSON.parse(args!.message as string) as Record<string, unknown>
        sent.push(msg)
        // Auto-resolve the initialize handshake so connect() can settle. The
        // stdout listener is already registered by the time this fires.
        if (msg.method === "initialize") {
          queueMicrotask(() =>
            feed({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                protocolVersion: 1,
                agentCapabilities: { loadSession: true },
                agentInfo: { name: "codex-acp", version: "1" },
              },
            })
          )
        }
      }
      return undefined
    })

    const adapter = new AcpClientAdapter()
    const connected = adapter.connect(stdioConfig())
    return { adapter, sent, feed, connected }
  }

  it("frames the initialize request WITH jsonrpc and resolves on the response", async () => {
    const { adapter, sent, connected } = connectWithStdio()
    await connected
    const init = sent.find((m) => m.method === "initialize")!
    expect(init).toBeDefined()
    expect(init.jsonrpc).toBe("2.0")
    expect(init.id).toBe(1)
    expect(adapter.isConnected()).toBe(true)
    await adapter.disconnect()
  })

  it("answers an unknown server→client request with a -32601 error response", async () => {
    const { adapter, sent, feed, connected } = connectWithStdio()
    await connected
    feed({ jsonrpc: "2.0", id: 77, method: "bogus/method", params: {} })
    await new Promise((r) => setTimeout(r, 0))
    const reply = sent.find((m) => m.id === 77)
    expect(reply).toBeDefined()
    expect((reply!.error as { code: number }).code).toBe(-32601)
    await adapter.disconnect()
  })
})

// ---------------------------------------------------------------------------
// Workstream A — ACP protocol version negotiation correctness.
// The client advertises LATEST_ACP_PROTOCOL_VERSION and must close the
// connection if the agent negotiates a version it does not implement.
// ---------------------------------------------------------------------------
describe("AcpClientAdapter — protocol version negotiation", () => {
  /** Drive a real stdio connect, negotiating `version` in the initialize reply. */
  function connectStdioWithVersion(version: number): {
    adapter: AcpClientAdapter
    connected: Promise<void>
    killed: () => boolean
  } {
    mockIsTauri.mockReturnValue(true)
    let stdoutCb: ((event: { payload: { agentId: string; data: string } }) => void) | undefined
    let killCalled = false

    mockListen.mockImplementation(async (channel: string, cb: (e: unknown) => void) => {
      if (channel === "external-agent://stdout") stdoutCb = cb as typeof stdoutCb
      return jest.fn()
    })
    const feed = (frame: Record<string, unknown>) =>
      stdoutCb?.({ payload: { agentId: "proc-1", data: JSON.stringify(frame) } })

    mockInvoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "spawn_external_agent") return "proc-1"
      if (cmd === "kill_external_agent") killCalled = true
      if (cmd === "send_to_external_agent") {
        const msg = JSON.parse(args!.message as string) as Record<string, unknown>
        if (msg.method === "initialize") {
          queueMicrotask(() =>
            feed({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                protocolVersion: version,
                agentCapabilities: { loadSession: true },
                agentInfo: { name: "codex-acp", version: "1" },
              },
            })
          )
        }
      }
      return undefined
    })

    const adapter = new AcpClientAdapter()
    return { adapter, connected: adapter.connect(stdioConfig()), killed: () => killCalled }
  }

  it("advertises the latest supported version in the initialize request", async () => {
    expect(SUPPORTED_ACP_PROTOCOL_VERSIONS).toContain(LATEST_ACP_PROTOCOL_VERSION)
    const { adapter, connected } = connectStdioWithVersion(LATEST_ACP_PROTOCOL_VERSION)
    await connected
    expect(adapter.isConnected()).toBe(true)
    await adapter.disconnect()
  })

  it("connects when the agent negotiates a supported version", async () => {
    const { adapter, connected } = connectStdioWithVersion(1)
    await expect(connected).resolves.toBeUndefined()
    expect(adapter.connectionStatus).toBe("connected")
    await adapter.disconnect()
  })

  it("closes the connection and surfaces a protocol/unsupported error on an unknown version", async () => {
    const { adapter, connected, killed } = connectStdioWithVersion(99)
    const message = await connected.then(
      () => "resolved",
      (e) => (e as Error).message
    )
    expect(message).toMatch(/protocol version 99/i)
    expect(message).toMatch(/unsupported/i)
    // Honors the spec rule to close the connection: status error + process killed.
    expect(adapter.connectionStatus).toBe("error")
    expect(killed()).toBe(true)
    expect(listenerBag(adapter)).toHaveLength(0)
  })

  it("initialize() rejects directly when the negotiated version is unsupported", async () => {
    const a = new AcpClientAdapter()
    ;(a as unknown as { sendRequest: (m: string) => Promise<unknown> }).sendRequest = jest.fn(
      async () => ({ protocolVersion: 2, agentCapabilities: {}, agentInfo: { name: "x" } })
    )
    await expect(
      (a as unknown as { initialize: () => Promise<unknown> }).initialize()
    ).rejects.toThrow(/Unsupported ACP protocol version/)
  })
})

// ---------------------------------------------------------------------------
// Workstream B — config-driven reconnection + network reconnect gate.
// ---------------------------------------------------------------------------
describe("AcpClientAdapter — reconnection policy", () => {
  type ReconnectInternals = {
    applyRetryConfig: (c: ExternalAgentConfig) => void
    shouldAutoReconnect: () => boolean
    attemptReconnection: () => Promise<void>
    handleProcessExit: (code: number) => void
    maxReconnectAttempts: number
    reconnectDelay: number
    maxReconnectDelay?: number
    useExponentialBackoff: boolean
    intentionalDisconnect: boolean
    reconnectAttempts: number
    _config?: ExternalAgentConfig
  }
  const internals = (a: AcpClientAdapter) => a as unknown as ReconnectInternals

  it("derives reconnect parameters from config.retryConfig", () => {
    const a = new AcpClientAdapter()
    internals(a).applyRetryConfig({
      ...stdioConfig(),
      retryConfig: {
        maxRetries: 7,
        retryDelay: 250,
        exponentialBackoff: false,
        maxRetryDelay: 5000,
      },
    })
    expect(internals(a).maxReconnectAttempts).toBe(7)
    expect(internals(a).reconnectDelay).toBe(250)
    expect(internals(a).maxReconnectDelay).toBe(5000)
    expect(internals(a).useExponentialBackoff).toBe(false)
  })

  it("falls back to historical defaults when retryConfig is absent", () => {
    const a = new AcpClientAdapter()
    internals(a).applyRetryConfig(stdioConfig())
    expect(internals(a).maxReconnectAttempts).toBe(3)
    expect(internals(a).reconnectDelay).toBe(1000)
    expect(internals(a).useExponentialBackoff).toBe(true)
    expect(internals(a).maxReconnectDelay).toBeUndefined()
  })

  it("auto-reconnects network transports but not stdio without restartOnCrash", () => {
    const a = new AcpClientAdapter()
    for (const transport of ["websocket", "sse", "http"] as const) {
      internals(a)._config = { ...stdioConfig(), transport, process: undefined }
      internals(a).intentionalDisconnect = false
      expect(internals(a).shouldAutoReconnect()).toBe(true)
    }
    internals(a)._config = { ...stdioConfig(), transport: "stdio" }
    expect(internals(a).shouldAutoReconnect()).toBe(false)
    internals(a)._config = {
      ...stdioConfig(),
      transport: "stdio",
      process: { command: "x", args: [], restartOnCrash: true },
    }
    expect(internals(a).shouldAutoReconnect()).toBe(true)
  })

  it("suppresses auto-reconnect after an intentional disconnect", async () => {
    const a = new AcpClientAdapter()
    setStatus(a, "connected")
    await a.disconnect()
    expect(internals(a).intentionalDisconnect).toBe(true)
    internals(a)._config = { ...stdioConfig(), transport: "websocket", process: undefined }
    expect(internals(a).shouldAutoReconnect()).toBe(false)
  })

  it("handleProcessExit reconnects a dropped network socket and closes open sessions", () => {
    const a = new AcpClientAdapter()
    internals(a)._config = { ...stdioConfig(), transport: "websocket", process: undefined }
    internals(a).intentionalDisconnect = false
    internals(a).reconnectAttempts = 0
    internals(a).maxReconnectAttempts = 3
    ;(a as unknown as { _sessions: Map<string, { id: string; status: string }> })._sessions.set(
      "s1",
      { id: "s1", status: "active" }
    )
    const spy = jest
      .spyOn(a as unknown as { attemptReconnection: () => Promise<void> }, "attemptReconnection")
      .mockResolvedValue(undefined)
    internals(a).handleProcessExit(1)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(
      (a as unknown as { _sessions: Map<string, { status: string }> })._sessions.get("s1")?.status
    ).toBe("closed")
  })

  it("retries then marks the adapter errored after the final failed attempt", async () => {
    jest.useFakeTimers()
    try {
      const a = new AcpClientAdapter()
      internals(a)._config = stdioConfig()
      internals(a).useExponentialBackoff = false
      internals(a).reconnectDelay = 10
      internals(a).maxReconnectAttempts = 2 // attempt 1 recurses, attempt 2 gives up
      internals(a).reconnectAttempts = 0
      const connectSpy = jest
        .spyOn(a as unknown as { connect: () => Promise<void> }, "connect")
        .mockRejectedValue(new Error("still down"))
      void internals(a).attemptReconnection()
      await jest.runAllTimersAsync()
      expect(connectSpy).toHaveBeenCalledTimes(2)
      expect(a.connectionStatus).toBe("error")
    } finally {
      jest.useRealTimers()
    }
  })

  it("handleProcessExit does not reconnect after a clean disconnect", async () => {
    const a = new AcpClientAdapter()
    setStatus(a, "connected")
    await a.disconnect()
    internals(a)._config = { ...stdioConfig(), transport: "websocket", process: undefined }
    const spy = jest
      .spyOn(a as unknown as { attemptReconnection: () => Promise<void> }, "attemptReconnection")
      .mockResolvedValue(undefined)
    internals(a).handleProcessExit(0)
    expect(spy).not.toHaveBeenCalled()
  })

  it("uses a flat delay and caps it when exponential backoff is disabled", async () => {
    jest.useFakeTimers()
    try {
      const a = new AcpClientAdapter()
      internals(a)._config = stdioConfig()
      internals(a).useExponentialBackoff = false
      internals(a).reconnectDelay = 400
      internals(a).maxReconnectDelay = 1000
      internals(a).maxReconnectAttempts = 1
      internals(a).reconnectAttempts = 0
      jest
        .spyOn(a as unknown as { connect: () => Promise<void> }, "connect")
        .mockResolvedValue(undefined)
      const setTimeoutSpy = jest.spyOn(global, "setTimeout")
      void internals(a).attemptReconnection()
      expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 400)
      await jest.runOnlyPendingTimersAsync()
    } finally {
      jest.useRealTimers()
    }
  })

  it("grows and caps the delay with exponential backoff enabled", async () => {
    jest.useFakeTimers()
    try {
      const a = new AcpClientAdapter()
      internals(a)._config = stdioConfig()
      internals(a).useExponentialBackoff = true
      internals(a).reconnectDelay = 1000
      internals(a).maxReconnectDelay = 1500
      internals(a).maxReconnectAttempts = 5
      internals(a).reconnectAttempts = 2 // next attempt => 3 => 1000 * 2^2 = 4000, capped to 1500
      jest
        .spyOn(a as unknown as { connect: () => Promise<void> }, "connect")
        .mockResolvedValue(undefined)
      const setTimeoutSpy = jest.spyOn(global, "setTimeout")
      void internals(a).attemptReconnection()
      expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 1500)
      await jest.runOnlyPendingTimersAsync()
    } finally {
      jest.useRealTimers()
    }
  })
})

describe("AcpClientAdapter — teardownTransport (shared by disconnect + connect error)", () => {
  type TeardownInternals = {
    processId?: string
    networkSocket?: { close: jest.Mock }
    networkEventSource?: { close: jest.Mock }
    pendingPermissions: Map<
      string,
      { resolve: (r: unknown) => void; timeout: ReturnType<typeof setTimeout> }
    >
  }
  const internals = (a: AcpClientAdapter) => a as unknown as TeardownInternals

  it("closes the socket + event source, resolves pending permissions, and tolerates a kill failure", async () => {
    mockIsTauri.mockReturnValue(true)
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "kill_external_agent") throw new Error("kill boom")
      return undefined
    })

    const a = new AcpClientAdapter()
    setStatus(a, "connected")
    internals(a).processId = "proc-1"
    const socket = { close: jest.fn() }
    const eventSource = { close: jest.fn() }
    internals(a).networkSocket = socket
    internals(a).networkEventSource = eventSource

    const resolved: unknown[] = []
    internals(a).pendingPermissions.set("p1", {
      resolve: (r) => resolved.push(r),
      timeout: setTimeout(() => undefined, 10_000),
    })

    // disconnect() drives teardownTransport through every branch.
    await expect(a.disconnect()).resolves.toBeUndefined()

    expect(mockInvoke).toHaveBeenCalledWith("kill_external_agent", { agentId: "proc-1" })
    expect(socket.close).toHaveBeenCalledTimes(1)
    expect(eventSource.close).toHaveBeenCalledTimes(1)
    expect(resolved).toEqual([{ outcome: { outcome: "cancelled" } }])
    expect(internals(a).networkSocket).toBeUndefined()
    expect(internals(a).networkEventSource).toBeUndefined()
    expect(a.connectionStatus).toBe("disconnected")
  })
})

describe("AcpClientAdapter — rapid-crash circuit breaker", () => {
  type BreakerInternals = {
    handleProcessExit: (code: number) => void
    attemptReconnection: () => Promise<void>
    intentionalDisconnect: boolean
    reconnectAttempts: number
    maxReconnectAttempts: number
    rapidExitCount: number
    lastConnectedAt?: number
    _connectionStatus: string
    _config?: ExternalAgentConfig
  }
  const breaker = (a: AcpClientAdapter) => a as unknown as BreakerInternals

  function networkAdapter(): AcpClientAdapter {
    const a = new AcpClientAdapter()
    const i = breaker(a)
    i._config = { ...stdioConfig(), transport: "websocket", process: undefined }
    i.intentionalDisconnect = false
    i.reconnectAttempts = 0
    // High attempt bound so the breaker — not the attempt count — is what stops it.
    i.maxReconnectAttempts = 99
    return a
  }

  it("trips after MAX_RAPID_EXITS consecutive fast exits and stops reconnecting", () => {
    const a = networkAdapter()
    const i = breaker(a)
    const spy = jest
      .spyOn(a as unknown as { attemptReconnection: () => Promise<void> }, "attemptReconnection")
      .mockResolvedValue(undefined)

    // Each exit follows a "successful" reconnect (recent lastConnectedAt) but the
    // process dies immediately — the crash loop the attempt bound can't catch.
    for (let n = 1; n < MAX_RAPID_EXITS; n++) {
      i.lastConnectedAt = Date.now()
      i.handleProcessExit(1)
    }
    expect(i.rapidExitCount).toBe(MAX_RAPID_EXITS - 1)
    expect(spy).toHaveBeenCalledTimes(MAX_RAPID_EXITS - 1)

    // The tripping exit: breaker engages — status "error", no further reconnect.
    i.lastConnectedAt = Date.now()
    i.handleProcessExit(1)
    expect(i.rapidExitCount).toBe(MAX_RAPID_EXITS)
    expect(spy).toHaveBeenCalledTimes(MAX_RAPID_EXITS - 1)
    expect(i._connectionStatus).toBe("error")
  })

  it("a healthy-uptime exit resets the rapid-crash counter", () => {
    const a = networkAdapter()
    const i = breaker(a)
    jest
      .spyOn(a as unknown as { attemptReconnection: () => Promise<void> }, "attemptReconnection")
      .mockResolvedValue(undefined)

    i.lastConnectedAt = Date.now()
    i.handleProcessExit(1)
    expect(i.rapidExitCount).toBe(1)

    // A session that ran longer than the threshold clears the breaker.
    i.lastConnectedAt = Date.now() - (RAPID_EXIT_THRESHOLD_MS + 1000)
    i.handleProcessExit(0)
    expect(i.rapidExitCount).toBe(0)
  })

  it("an exit with no prior successful connect does not count as a rapid crash", () => {
    const a = networkAdapter()
    const i = breaker(a)
    jest
      .spyOn(a as unknown as { attemptReconnection: () => Promise<void> }, "attemptReconnection")
      .mockResolvedValue(undefined)

    i.lastConnectedAt = undefined // never connected → uptime is Infinity
    i.handleProcessExit(1)
    expect(i.rapidExitCount).toBe(0)
  })

  it("disconnect() resets the breaker so a manual reconnect starts clean", async () => {
    const a = networkAdapter()
    const i = breaker(a)
    i.rapidExitCount = 5
    i.lastConnectedAt = Date.now()
    setStatus(a, "connected")
    await a.disconnect()
    expect(i.rapidExitCount).toBe(0)
    expect(i.lastConnectedAt).toBeUndefined()
  })
})

// ── ACP v1 session-update coverage ──────────────────────────────────────────

type AnyUpdate = { sessionUpdate: string; [k: string]: unknown }
function handleUpdate(a: AcpClientAdapter, sessionId: string, update: AnyUpdate) {
  return (
    a as unknown as {
      handleSessionUpdate: (s: string, t: Date, u: AnyUpdate) => unknown
    }
  ).handleSessionUpdate(sessionId, new Date(), update)
}
function sessionMeta(a: AcpClientAdapter, id: string): Record<string, unknown> | undefined {
  const s = (
    a as unknown as { _sessions: Map<string, { metadata?: Record<string, unknown> }> }
  )._sessions.get(id)
  return s?.metadata
}
function setAgentCaps(a: AcpClientAdapter, caps: unknown): void {
  ;(a as unknown as { _agentCapabilities?: unknown })._agentCapabilities = caps
}

describe("AcpClientAdapter — ACP v1 session updates", () => {
  it("maps the canonical agent_thought_chunk to a thinking event", () => {
    const a = new AcpClientAdapter()
    seedSession(a, "s1", "default")
    const ev = handleUpdate(a, "s1", {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "pondering" },
    }) as { type: string; thinking: string }
    expect(ev).toMatchObject({ type: "thinking", thinking: "pondering" })
  })

  it("still maps the legacy thought_message_chunk alias", () => {
    const a = new AcpClientAdapter()
    seedSession(a, "s1", "default")
    const ev = handleUpdate(a, "s1", {
      sessionUpdate: "thought_message_chunk",
      content: { type: "text", text: "legacy" },
    }) as { type: string; thinking: string }
    expect(ev).toMatchObject({ type: "thinking", thinking: "legacy" })
  })

  it("maps the singular config_option_update to a config_options_update event", () => {
    const a = new AcpClientAdapter()
    seedSession(a, "s1", "default")
    const ev = handleUpdate(a, "s1", {
      sessionUpdate: "config_option_update",
      configOptions: [
        {
          id: "mode",
          name: "Mode",
          type: "select",
          currentValue: "plan",
          category: "mode",
          options: [],
        },
      ],
    }) as { type: string; configOptions: unknown[] }
    expect(ev).toMatchObject({ type: "config_options_update" })
    expect(ev.configOptions).toHaveLength(1)
  })

  it("records usage_update context occupancy in session metadata (no fabricated token total)", () => {
    const a = new AcpClientAdapter()
    seedSession(a, "s1", "default")
    const ev = handleUpdate(a, "s1", {
      sessionUpdate: "usage_update",
      used: 1200,
      size: 200000,
      cost: { amount: 0.04, currency: "USD" },
    })
    expect(ev).toBeNull()
    // Context occupancy + cost land in metadata, not as a bogus token total.
    expect(sessionMeta(a, "s1")?.usage).toMatchObject({
      used: 1200,
      size: 200000,
      cost: { amount: 0.04, currency: "USD" },
    })
    // No `latestUsage` map — the honest fix stopped conflating occupancy with tokens.
    expect((a as unknown as { latestUsage?: unknown }).latestUsage).toBeUndefined()
  })

  it("gives every agent_message_chunk of a turn the same stable message id", () => {
    const a = new AcpClientAdapter()
    seedSession(a, "s1", "default")
    const first = handleUpdate(a, "s1", {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Hel" },
    }) as { messageId: string }
    const second = handleUpdate(a, "s1", {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "lo" },
    }) as { messageId: string }
    expect(first.messageId).toBe(second.messageId)
    expect(first.messageId).toMatch(/^msg_\d+$/)
    // A user chunk gets a distinct-but-stable id derived from the same turn id.
    const user = handleUpdate(a, "s1", {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "hi" },
    }) as { messageId: string }
    expect(user.messageId).toBe(`${first.messageId}:user`)
  })

  it("applies session_info_update title without emitting an event", () => {
    const a = new AcpClientAdapter()
    seedSession(a, "s1", "default")
    const ev = handleUpdate(a, "s1", {
      sessionUpdate: "session_info_update",
      title: "Refactor auth",
    })
    expect(ev).toBeNull()
    expect(sessionMeta(a, "s1")?.title).toBe("Refactor auth")
  })
})

describe("AcpClientAdapter — session/close · session/delete · logout gating", () => {
  it("logout no-ops when the agent does not advertise auth.logout", async () => {
    const a = new AcpClientAdapter()
    const spy = jest
      .spyOn(a as unknown as { sendRequest: (m: string) => Promise<unknown> }, "sendRequest")
      .mockResolvedValue(undefined)
    setAgentCaps(a, {})
    await a.logout()
    expect(spy).not.toHaveBeenCalled()
  })

  it("logout sends the RPC when auth.logout is advertised", async () => {
    const a = new AcpClientAdapter()
    const spy = jest
      .spyOn(a as unknown as { sendRequest: (m: string) => Promise<unknown> }, "sendRequest")
      .mockResolvedValue(undefined)
    setAgentCaps(a, { auth: { logout: true } })
    await a.logout()
    expect(spy).toHaveBeenCalledWith("logout", {})
  })

  it("closeSession sends session/close only when the capability is present", async () => {
    const a = new AcpClientAdapter()
    seedSession(a, "s1", "default")
    const spy = jest
      .spyOn(
        a as unknown as { sendRequest: (m: string, p: unknown) => Promise<unknown> },
        "sendRequest"
      )
      .mockResolvedValue(undefined)
    setAgentCaps(a, { sessionCapabilities: { close: {} } })
    await a.closeSession("s1")
    expect(spy).toHaveBeenCalledWith("session/close", { sessionId: "s1" })
  })

  it("deleteSession sends session/delete when the capability is present and clears local state", async () => {
    const a = new AcpClientAdapter()
    seedSession(a, "s1", "default")
    const spy = jest
      .spyOn(
        a as unknown as { sendRequest: (m: string, p: unknown) => Promise<unknown> },
        "sendRequest"
      )
      .mockResolvedValue(undefined)
    setAgentCaps(a, { sessionCapabilities: { delete: {} } })
    await a.deleteSession("s1")
    expect(spy).toHaveBeenCalledWith("session/delete", { sessionId: "s1" })
    const sessions = (a as unknown as { _sessions: Map<string, unknown> })._sessions
    expect(sessions.has("s1")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Subprocess stderr forwarding — routine stderr must not flood the Next dev
// server's forwarded-console buffer. It is logged at `debug` (below the
// forwarded warn+ threshold) with each chunk size-bounded, never at `warn`.
// ---------------------------------------------------------------------------
describe("AcpClientAdapter — stderr forwarding", () => {
  it("forwards subprocess stderr at debug (not warn) and truncates oversized chunks", async () => {
    mockIsTauri.mockReturnValue(true)
    const debugSpy = jest.spyOn(loggers.agent, "debug").mockImplementation(() => {})
    const warnSpy = jest.spyOn(loggers.agent, "warn").mockImplementation(() => {})

    let stdoutCb: ((e: { payload: { agentId: string; data: string } }) => void) | undefined
    let stderrCb: ((e: { payload: { agentId: string; data: string } }) => void) | undefined
    mockListen.mockImplementation(async (channel: string, cb: (e: unknown) => void) => {
      if (channel === "external-agent://stdout") stdoutCb = cb as typeof stdoutCb
      if (channel === "external-agent://stderr") stderrCb = cb as typeof stderrCb
      return jest.fn()
    })
    const feed = (frame: Record<string, unknown>) =>
      stdoutCb?.({ payload: { agentId: "proc-1", data: JSON.stringify(frame) } })
    mockInvoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "spawn_external_agent") return "proc-1"
      if (cmd === "send_to_external_agent") {
        const msg = JSON.parse(args!.message as string) as Record<string, unknown>
        if (msg.method === "initialize") {
          queueMicrotask(() =>
            feed({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                protocolVersion: 1,
                agentCapabilities: { loadSession: true },
                agentInfo: { name: "codex-acp", version: "1" },
              },
            })
          )
        }
      }
      return undefined
    })

    const adapter = new AcpClientAdapter()
    try {
      await adapter.connect(stdioConfig())
      expect(stderrCb).toBeDefined()

      const huge = "E".repeat(LOG_VALUE_MAX_CHARS + 4096)
      stderrCb!({ payload: { agentId: "proc-1", data: huge } })

      expect(debugSpy).toHaveBeenCalledWith("stderr", { data: truncateForLog(huge) })
      expect(warnSpy).not.toHaveBeenCalledWith("stderr", expect.anything())

      const forwarded = (
        debugSpy.mock.calls.find((c) => c[0] === "stderr")?.[1] as { data: string }
      ).data
      expect(forwarded.length).toBeLessThan(huge.length)
      expect(forwarded).toContain("chars truncated")

      // stderr from an unrelated process id is ignored.
      debugSpy.mockClear()
      stderrCb!({ payload: { agentId: "other-proc", data: "noise" } })
      expect(debugSpy).not.toHaveBeenCalledWith("stderr", expect.anything())

      await adapter.disconnect()
    } finally {
      debugSpy.mockRestore()
      warnSpy.mockRestore()
    }
  })
})
