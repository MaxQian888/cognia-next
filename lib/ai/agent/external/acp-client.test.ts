/**
 * Smoke tests for AcpClientAdapter — exercises the public surface that runs
 * without a live ACP process. Full protocol negotiation requires a Tauri
 * runtime + child process, which jsdom can't provide; those paths are covered
 * by integration tests under src-tauri/.
 */

jest.mock("@/lib/native/external-agent", () => ({
  acpTerminalCreate: jest.fn(async () => "terminal-1"),
  cleanupSessionTerminals: jest.fn(async () => undefined),
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

jest.mock("@/lib/network/platform-streaming-fetch", () => ({
  platformStreamingFetch: jest.fn(),
}))

jest.mock("@/lib/network/platform-websocket", () => ({
  createPlatformWebSocket: jest.fn(),
}))

jest.mock("./agent-transport", () => ({
  ...jest.requireActual("./agent-transport"),
  agentReadTextFile: jest.fn(),
  agentWriteTextFile: jest.fn(),
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
import {
  acpTerminalCreate,
  acpTerminalOutput,
  acpTerminalWaitForExit,
  acpTerminalWrite,
  cleanupSessionTerminals,
} from "@/lib/native/external-agent"
import { listen } from "@tauri-apps/api/event"
import { invoke } from "@tauri-apps/api/core"
import { proxyFetch } from "@/lib/network/proxy-fetch"
import { platformStreamingFetch } from "@/lib/network/platform-streaming-fetch"
import { createPlatformWebSocket } from "@/lib/network/platform-websocket"
import {
  AcpClientAdapter,
  buildSpawnArgs,
  createAcpClient,
  SUPPORTED_ACP_PROTOCOL_VERSIONS,
  LATEST_ACP_PROTOCOL_VERSION,
  RAPID_EXIT_THRESHOLD_MS,
  MAX_RAPID_EXITS,
} from "./acp-client"
import type {
  ExternalAgentConfig,
  AcpPermissionResponse,
  ExternalAgentEvent,
} from "@/types/agent/external-agent"
import { loggers } from "@cognia/logging"
import { LOG_VALUE_MAX_CHARS, truncateForLog } from "@cognia/logging/truncate"
import { agentReadTextFile, agentWriteTextFile } from "./agent-transport"

const mockIsTauri = isTauri as jest.Mock
const mockTerminalWrite = acpTerminalWrite as jest.Mock
const mockTerminalCreate = acpTerminalCreate as jest.Mock
const mockTerminalOutput = acpTerminalOutput as jest.Mock
const mockTerminalWaitForExit = acpTerminalWaitForExit as jest.Mock
const mockCleanupSessionTerminals = cleanupSessionTerminals as jest.Mock
const mockListen = listen as jest.Mock
const mockInvoke = invoke as jest.Mock
const mockAgentReadTextFile = agentReadTextFile as jest.Mock
const mockAgentWriteTextFile = agentWriteTextFile as jest.Mock

afterEach(() => {
  mockIsTauri.mockReturnValue(false)
  mockTerminalWrite.mockClear()
  mockTerminalCreate.mockClear()
  mockTerminalOutput.mockClear()
  mockTerminalWaitForExit.mockClear()
  mockCleanupSessionTerminals.mockClear()
  mockListen.mockReset()
  mockInvoke.mockReset()
  mockListen.mockImplementation(async () => jest.fn())
  mockInvoke.mockImplementation(async () => "proc-1")
  mockAgentReadTextFile.mockReset()
  mockAgentWriteTextFile.mockReset()
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

function callPermission(
  a: AcpClientAdapter,
  params: PermissionParams,
  signal?: AbortSignal,
  wireRequestId?: number | string
): Promise<PermissionOutcome> {
  return (
    a as unknown as {
      handlePermissionRequest: (
        p: PermissionParams,
        signal?: AbortSignal,
        wireRequestId?: number | string
      ) => Promise<PermissionOutcome>
    }
  ).handlePermissionRequest(params, signal, wireRequestId)
}

function callTerminalWrite(
  a: AcpClientAdapter,
  sessionId: string,
  terminalId: string,
  data: string
): Promise<void> {
  return (
    a as unknown as {
      handleTerminalWrite: (p: {
        sessionId: string
        terminalId: string
        data: string
      }) => Promise<void>
    }
  ).handleTerminalWrite({ sessionId, terminalId, data })
}

function seedTerminal(a: AcpClientAdapter, sessionId: string, terminalId: string): void {
  ;(a as unknown as { terminalSessions: Map<string, string> }).terminalSessions.set(
    terminalId,
    sessionId
  )
}

function dispatchAgentRequest(
  a: AcpClientAdapter,
  method: string,
  params: Record<string, unknown>
): Promise<unknown> {
  return (
    a as unknown as {
      dispatchAgentRequest: (method: string, params: Record<string, unknown>) => Promise<unknown>
    }
  ).dispatchAgentRequest(method, params)
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
    const session = (a as unknown as { _sessions: Map<string, { status?: string }> })._sessions.get(
      "s"
    )!
    session.status = "executing"
    await a.cancel("s")
    await expect(pending).resolves.toEqual({ outcome: { outcome: "cancelled" } })
  })

  it("resolves an outstanding permission as cancelled when its turn is cancelled", async () => {
    const a = new AcpClientAdapter()
    seedSession(a, "s", "default")
    const session = (
      a as unknown as {
        _sessions: Map<string, { permissionMode: string; status?: string }>
      }
    )._sessions.get("s")!
    session.status = "executing"
    const pending = callPermission(a, {
      sessionId: "s",
      toolCall: { toolCallId: "tc", title: "Shell", kind: "execute" },
      options: [ALLOW, REJECT],
    })

    await a.cancel("s")

    await expect(pending).resolves.toEqual({ outcome: { outcome: "cancelled" } })
  })

  it("rejects a nested permission request with -32800 when its request is cancelled", async () => {
    const a = new AcpClientAdapter()
    seedSession(a, "s", "default")
    const controller = new AbortController()
    const pending = (
      a as unknown as {
        handlePermissionRequest: (
          params: Record<string, unknown>,
          signal: AbortSignal
        ) => Promise<unknown>
      }
    ).handlePermissionRequest(
      {
        sessionId: "s",
        requestId: "permission-1",
        toolCall: { toolCallId: "tc", title: "Shell", kind: "execute" },
        options: [ALLOW, REJECT],
      },
      controller.signal
    )

    controller.abort()

    await expect(pending).rejects.toMatchObject({ code: -32800 })
  })

  it("keys concurrent permissions by JSON-RPC id even when tool ids repeat", async () => {
    const a = new AcpClientAdapter()
    seedSession(a, "s", "default")
    const firstController = new AbortController()
    const secondController = new AbortController()
    const params = {
      sessionId: "s",
      requestId: "agent-reused-id",
      toolCall: { toolCallId: "same-tool", title: "Shell", kind: "execute" },
      options: [ALLOW, REJECT],
    }
    const first = callPermission(a, params, firstController.signal, 41)
    const second = callPermission(a, params, secondController.signal, 42)
    const pending = (a as unknown as { pendingPermissions: Map<string, unknown> })
      .pendingPermissions

    expect([...pending.keys()]).toEqual(["41", "42"])
    firstController.abort()
    secondController.abort()
    await expect(first).rejects.toMatchObject({ code: -32800 })
    await expect(second).rejects.toMatchObject({ code: -32800 })
  })

  it("does not cancel a permission belonging to a session with the same id prefix", async () => {
    const a = new AcpClientAdapter()
    seedSession(a, "s", "default")
    seedSession(a, "s2", "default")
    const sessions = (a as unknown as { _sessions: Map<string, { status?: string }> })._sessions
    sessions.get("s")!.status = "executing"
    sessions.get("s2")!.status = "executing"
    const pending = callPermission(a, {
      sessionId: "s2",
      toolCall: { toolCallId: "tc", title: "Shell", kind: "execute" },
      options: [ALLOW, REJECT],
    })

    await a.cancel("s")
    const sentinel = Symbol("pending")
    await expect(
      Promise.race([pending, new Promise((resolve) => setTimeout(() => resolve(sentinel), 10))])
    ).resolves.toBe(sentinel)

    await a.cancel("s2")
    await expect(pending).resolves.toEqual({ outcome: { outcome: "cancelled" } })
  })
})

describe("AcpClientAdapter — ACP v1 feature-gated elicitation", () => {
  function elicitationInternals(a: AcpClientAdapter) {
    return a as unknown as {
      _config?: ExternalAgentConfig
      handleElicitationRequest: (
        id: number | string,
        params: Record<string, unknown>,
        signal: AbortSignal
      ) => Promise<unknown>
      handleNotification: (notification: {
        jsonrpc: "2.0"
        method: string
        params?: Record<string, unknown>
      }) => void
      addEventListener: (sessionId: string, listener: (event: ExternalAgentEvent) => void) => void
      knownUrlElicitations: Map<string, string | undefined>
    }
  }

  it("emits a form request and resolves it through respondToElicitation", async () => {
    const a = new AcpClientAdapter()
    seedSession(a, "s1", "default")
    const internals = elicitationInternals(a)
    internals._config = {
      ...stdioConfig(),
      metadata: { acpElicitationEnabled: true },
    }
    const events: ExternalAgentEvent[] = []
    internals.addEventListener("s1", (event) => events.push(event))

    const response = internals.handleElicitationRequest(
      17,
      {
        mode: "form",
        sessionId: "s1",
        message: "Choose",
        requestedSchema: {
          type: "object",
          properties: { enabled: { type: "boolean" } },
          required: ["enabled"],
        },
      },
      new AbortController().signal
    )
    expect(events.at(-1)).toMatchObject({
      type: "elicitation_request",
      request: { id: "17", mode: "form" },
    })

    await a.respondToElicitation({
      requestId: "17",
      action: "accept",
      content: { enabled: true },
    })
    await expect(response).resolves.toEqual({ action: "accept", content: { enabled: true } })
  })

  it("rejects elicitation when the extension was not explicitly enabled", async () => {
    const a = new AcpClientAdapter()
    elicitationInternals(a)._config = stdioConfig()
    await expect(
      elicitationInternals(a).handleElicitationRequest(
        18,
        {
          mode: "url",
          requestId: 1,
          message: "Sign in",
          elicitationId: "auth",
          url: "https://example.com",
        },
        new AbortController().signal
      )
    ).rejects.toMatchObject({ code: -32601 })
  })

  it("ignores unknown URL completion ids and emits known completions once", () => {
    const a = new AcpClientAdapter()
    seedSession(a, "s1", "default")
    const internals = elicitationInternals(a)
    const events: ExternalAgentEvent[] = []
    internals.addEventListener("s1", (event) => events.push(event))

    internals.handleNotification({
      jsonrpc: "2.0",
      method: "elicitation/complete",
      params: { elicitationId: "unknown" },
    })
    expect(events).toHaveLength(0)

    internals.knownUrlElicitations.set("known", "s1")
    internals.handleNotification({
      jsonrpc: "2.0",
      method: "elicitation/complete",
      params: { elicitationId: "known", _meta: { opaque: true } },
    })
    expect(events).toEqual([
      expect.objectContaining({
        type: "elicitation_complete",
        sessionId: "s1",
        elicitationId: "known",
        _meta: { opaque: true },
      }),
    ])
    expect(internals.knownUrlElicitations.has("known")).toBe(false)
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
    await expect(callTerminalWrite(a, "s1", "t1", "echo hi\n")).rejects.toThrow(/Tauri/)
    expect(mockTerminalWrite).not.toHaveBeenCalled()
  })

  it("delegates to the native binding inside Tauri", async () => {
    mockIsTauri.mockReturnValue(true)
    const a = new AcpClientAdapter()
    seedTerminal(a, "s1", "t1")
    await expect(callTerminalWrite(a, "s1", "t1", "echo hi\n")).resolves.toBeUndefined()
    expect(mockTerminalWrite).toHaveBeenCalledWith("t1", "echo hi\n")
  })

  it("rejects a terminal operation from a different ACP session", async () => {
    mockIsTauri.mockReturnValue(true)
    const a = new AcpClientAdapter()
    seedTerminal(a, "owner", "t1")

    await expect(
      dispatchAgentRequest(a, "terminal/output", { sessionId: "other", terminalId: "t1" })
    ).rejects.toThrow(/does not belong to ACP session/i)
    expect(mockTerminalOutput).not.toHaveBeenCalled()
  })
})

describe("AcpClientAdapter — current terminal wire shape", () => {
  it("converts ACP env entries to the native terminal map", async () => {
    mockIsTauri.mockReturnValue(true)
    const a = new AcpClientAdapter()
    seedSession(a, "s", "default")

    await expect(
      dispatchAgentRequest(a, "terminal/create", {
        sessionId: "s",
        command: "node",
        args: ["script.js"],
        env: [
          { name: "NODE_ENV", value: "test" },
          { name: "DEBUG", value: "1" },
        ],
      })
    ).resolves.toEqual({ terminalId: "terminal-1" })

    expect(mockTerminalCreate).toHaveBeenCalledWith(
      "s",
      "node",
      ["script.js"],
      undefined,
      { NODE_ENV: "test", DEBUG: "1" },
      undefined
    )
  })

  it("returns the canonical top-level terminal wait result", async () => {
    mockIsTauri.mockReturnValue(true)
    mockTerminalWaitForExit.mockResolvedValueOnce({
      exitStatus: { exitCode: null, signal: "SIGTERM" },
    })
    const a = new AcpClientAdapter()
    seedTerminal(a, "s", "terminal-1")

    await expect(
      dispatchAgentRequest(a, "terminal/wait_for_exit", {
        sessionId: "s",
        terminalId: "terminal-1",
      })
    ).resolves.toEqual({ exitCode: null, signal: "SIGTERM" })
  })

  it("kills owned native terminals when an ACP session closes", async () => {
    mockIsTauri.mockReturnValue(true)
    const a = new AcpClientAdapter()
    seedSession(a, "s", "default")
    seedTerminal(a, "s", "terminal-1")

    await a.closeSession("s")

    expect(mockCleanupSessionTerminals).toHaveBeenCalledWith("s")
  })
})

describe("AcpClientAdapter — session-confined file requests", () => {
  it("passes the session cwd and additional directories to host-confined reads and writes", async () => {
    const a = new AcpClientAdapter()
    seedSession(a, "s", "default")
    const session = (
      a as unknown as {
        _sessions: Map<string, { metadata?: Record<string, unknown> }>
      }
    )._sessions.get("s")!
    session.metadata = { cwd: "/work", additionalDirectories: ["/shared"] }
    mockAgentReadTextFile.mockResolvedValue("contents")
    mockAgentWriteTextFile.mockResolvedValue(undefined)

    await expect(
      dispatchAgentRequest(a, "fs/read_text_file", { sessionId: "s", path: "/shared/note.md" })
    ).resolves.toEqual({ content: "contents" })
    await expect(
      dispatchAgentRequest(a, "fs/write_text_file", {
        sessionId: "s",
        path: "/work/out.md",
        content: "done",
      })
    ).resolves.toBeUndefined()

    expect(mockAgentReadTextFile).toHaveBeenCalledWith("/shared/note.md", ["/work", "/shared"])
    expect(mockAgentWriteTextFile).toHaveBeenCalledWith("/work/out.md", "done", [
      "/work",
      "/shared",
    ])
  })

  it("fails closed when a file request has no known session roots", async () => {
    const a = new AcpClientAdapter()

    await expect(
      dispatchAgentRequest(a, "fs/read_text_file", { sessionId: "missing", path: "/tmp/x" })
    ).rejects.toThrow(/unknown ACP session/i)
  })
})

describe("AcpClientAdapter — outbound PII gate", () => {
  it("blocks a PII-bearing JSON-RPC payload before it reaches the agent transport", async () => {
    mockIsTauri.mockReturnValue(true)
    const a = new AcpClientAdapter()
    ;(a as unknown as { _config: ExternalAgentConfig })._config = stdioConfig()
    ;(a as unknown as { processId: string }).processId = "proc-1"

    await expect(
      (
        a as unknown as {
          sendMessage: (message: string) => Promise<void>
        }
      ).sendMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "session/prompt",
          params: { sessionId: "s", prompt: "Contact alice@example.com" },
        })
      )
    ).rejects.toThrow(/PII gate/i)
  })
})

describe("AcpClientAdapter — orphaned process reclaim", () => {
  // The Rust process manager keys children by the persisted config id and
  // outlives the JS realm, so a page reload / dev Fast Refresh leaves a child
  // nothing listens to while `spawn_external_agent` keeps refusing the id —
  // bricking the agent until the whole app restarts.
  function connectWithSpawn(spawn: () => string): {
    adapter: AcpClientAdapter
    calls: string[]
    connected: Promise<void>
  } {
    mockIsTauri.mockReturnValue(true)
    const calls: string[] = []
    let stdoutCb: ((event: { payload: { agentId: string; data: string } }) => void) | undefined

    mockListen.mockImplementation(async (channel: string, cb: (e: unknown) => void) => {
      if (channel === "external-agent://stdout") stdoutCb = cb as typeof stdoutCb
      return jest.fn()
    })

    mockInvoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      calls.push(cmd)
      if (cmd === "spawn_external_agent") return spawn()
      if (cmd === "send_to_external_agent") {
        const msg = JSON.parse(args!.message as string) as Record<string, unknown>
        if (msg.method === "initialize") {
          queueMicrotask(() =>
            stdoutCb?.({
              payload: {
                agentId: "proc-1",
                data: JSON.stringify({
                  jsonrpc: "2.0",
                  id: msg.id,
                  result: {
                    protocolVersion: 1,
                    agentCapabilities: {},
                    agentInfo: { name: "codex-acp", version: "1" },
                  },
                }),
              },
            })
          )
        }
      }
      return undefined
    })

    const adapter = new AcpClientAdapter()
    return { adapter, calls, connected: adapter.connect(stdioConfig()) }
  }

  it("kills the orphan and respawns when the id is already registered", async () => {
    let attempt = 0
    const { calls, connected } = connectWithSpawn(() => {
      attempt++
      if (attempt === 1) throw "Agent acp-agent is already running"
      return "proc-1"
    })

    await connected

    expect(calls.filter((c) => c === "spawn_external_agent")).toHaveLength(2)
    expect(calls).toContain("kill_external_agent")
  })

  it("propagates a spawn failure that is not an already-running collision", async () => {
    const { calls, connected } = connectWithSpawn(() => {
      throw "Failed to spawn process: ENOENT"
    })

    await expect(connected).rejects.toMatch(/ENOENT/)
    expect(calls.filter((c) => c === "spawn_external_agent")).toHaveLength(1)
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
    expect(init.params).toMatchObject({
      clientCapabilities: {
        session: { configOptions: { boolean: {} } },
        plan: {},
      },
    })
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
    networkEventAbort?: AbortController
    pendingPermissions: Map<
      string,
      { resolve: (r: unknown) => void; timeout: ReturnType<typeof setTimeout> }
    >
  }
  const internals = (a: AcpClientAdapter) => a as unknown as TeardownInternals

  it("closes the socket, aborts the event stream, resolves pending permissions, and tolerates a kill failure", async () => {
    mockIsTauri.mockReturnValue(true)
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "kill_external_agent") throw new Error("kill boom")
      return undefined
    })

    const a = new AcpClientAdapter()
    setStatus(a, "connected")
    internals(a).processId = "proc-1"
    const socket = { close: jest.fn().mockResolvedValue(undefined) }
    const eventAbort = new AbortController()
    internals(a).networkSocket = socket
    internals(a).networkEventAbort = eventAbort

    const resolved: unknown[] = []
    internals(a).pendingPermissions.set("p1", {
      resolve: (r) => resolved.push(r),
      timeout: setTimeout(() => undefined, 10_000),
    })

    // disconnect() drives teardownTransport through every branch.
    await expect(a.disconnect()).resolves.toBeUndefined()

    expect(mockInvoke).toHaveBeenCalledWith("kill_external_agent", { agentId: "proc-1" })
    expect(socket.close).toHaveBeenCalledTimes(1)
    // The SSE read loop is detached; aborting is what actually ends it and
    // releases the native stream behind it.
    expect(eventAbort.signal.aborted).toBe(true)
    expect(resolved).toEqual([{ outcome: { outcome: "cancelled" } }])
    expect(internals(a).networkSocket).toBeUndefined()
    expect(internals(a).networkEventAbort).toBeUndefined()
    expect(a.connectionStatus).toBe("disconnected")
  })

  it("does not let a failing socket close abort the rest of the teardown", async () => {
    mockIsTauri.mockReturnValue(false)
    const a = new AcpClientAdapter()
    setStatus(a, "connected")
    const socket = { close: jest.fn().mockRejectedValue(new Error("socket boom")) }
    internals(a).networkSocket = socket

    await expect(a.disconnect()).resolves.toBeUndefined()

    expect(internals(a).networkSocket).toBeUndefined()
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
  it.each([
    {
      label: "compact",
      commands: [{ name: "compact", description: "Compact context", input: null }],
      compaction: {
        status: "supported",
        routes: [{ kind: "command", command: "compact", supportsFocus: false }],
      },
      undo: { status: "unsupported" },
    },
    {
      label: "compress with input",
      commands: [{ name: "/compress", description: "Compress context", input: { hint: "focus" } }],
      compaction: {
        status: "supported",
        routes: [{ kind: "command", command: "compress", supportsFocus: true }],
      },
      undo: { status: "unsupported" },
    },
    {
      label: "provider undo",
      commands: [{ name: "/undo", description: "Undo last provider change", input: null }],
      compaction: { status: "unsupported", routes: [] },
      undo: { status: "supported", command: "undo" },
    },
    {
      label: "non-equivalent parameterized command",
      commands: [
        { name: "compress-fast", description: "Fast compression", input: { hint: "focus" } },
      ],
      compaction: { status: "unsupported", routes: [] },
      undo: { status: "unsupported" },
    },
    {
      label: "no relevant commands",
      commands: [{ name: "handoff", description: "Create a handoff", input: null }],
      compaction: { status: "unsupported", routes: [] },
      undo: { status: "unsupported" },
    },
  ])("projects $label command capabilities from the runtime fixture", async (fixture) => {
    const adapter = new AcpClientAdapter()
    seedSession(adapter, "s1", "default")
    handleUpdate(adapter, "s1", {
      sessionUpdate: "available_commands_update",
      availableCommands: fixture.commands,
    })

    expect(await adapter.getCompactionCapability("s1")).toEqual(fixture.compaction)
    expect(await adapter.getProviderUndoCapability("s1")).toEqual(fixture.undo)
  })

  it("maps item plan_update and plan_removed notifications", () => {
    const a = new AcpClientAdapter()
    seedSession(a, "s1", "default")
    const updated = handleUpdate(a, "s1", {
      sessionUpdate: "plan_update",
      plan: {
        type: "items",
        planId: "main",
        entries: [{ content: "Implement", priority: "high", status: "in_progress" }],
      },
    }) as { type: string; planId: string; entries: unknown[]; removed?: boolean }
    expect(updated).toMatchObject({
      type: "plan_update",
      planId: "main",
      entries: [{ content: "Implement", status: "in_progress" }],
      removed: false,
    })
    expect(sessionMeta(a, "s1")?.plan).toEqual(updated.entries)

    const removed = handleUpdate(a, "s1", {
      sessionUpdate: "plan_removed",
      planId: "main",
    }) as { type: string; planId: string; entries: unknown[]; removed?: boolean }
    expect(removed).toMatchObject({
      type: "plan_update",
      planId: "main",
      entries: [],
      removed: true,
    })
    expect(sessionMeta(a, "s1")?.plan).toEqual([])
  })

  it("preserves file and markdown plan updates in session metadata", () => {
    const a = new AcpClientAdapter()
    seedSession(a, "s1", "default")
    const file = handleUpdate(a, "s1", {
      sessionUpdate: "plan_update",
      plan: { type: "file", planId: "file-plan", uri: "file:///work/PLAN.md" },
    }) as { type: string; kind?: string; uri?: string; entries: unknown[] }
    expect(file).toMatchObject({
      type: "plan_update",
      planId: "file-plan",
      kind: "file",
      uri: "file:///work/PLAN.md",
      entries: [],
    })

    const markdown = handleUpdate(a, "s1", {
      sessionUpdate: "plan_update",
      plan: { type: "markdown", planId: "md-plan", content: "# Plan" },
    }) as { type: string; kind?: string; content?: string; entries: unknown[] }
    expect(markdown).toMatchObject({
      type: "plan_update",
      planId: "md-plan",
      kind: "markdown",
      content: "# Plan",
      entries: [],
    })
    expect(sessionMeta(a, "s1")?.plans).toMatchObject({
      "file-plan": { type: "file", uri: "file:///work/PLAN.md" },
      "md-plan": { type: "markdown", content: "# Plan" },
    })
  })

  it("keeps the active item plan when an unrelated identified plan is removed", () => {
    const a = new AcpClientAdapter()
    seedSession(a, "s1", "default")
    const entries = [{ content: "Implement", priority: "high", status: "in_progress" }]
    handleUpdate(a, "s1", {
      sessionUpdate: "plan_update",
      plan: { type: "items", planId: "main", entries },
    })
    handleUpdate(a, "s1", {
      sessionUpdate: "plan_update",
      plan: { type: "file", planId: "supporting-file", uri: "file:///work/PLAN.md" },
    })

    handleUpdate(a, "s1", {
      sessionUpdate: "plan_removed",
      planId: "supporting-file",
    })

    expect(sessionMeta(a, "s1")?.plan).toEqual(entries)
    expect(sessionMeta(a, "s1")?.plans).toEqual({
      main: { type: "items", planId: "main", entries },
    })
  })

  it("preserves a legacy active plan when an unrelated identified plan is removed", () => {
    const a = new AcpClientAdapter()
    seedSession(a, "s1", "default")
    const legacyEntries = [{ content: "Legacy", priority: "high", status: "in_progress" }]
    handleUpdate(a, "s1", { sessionUpdate: "plan", entries: legacyEntries })
    handleUpdate(a, "s1", {
      sessionUpdate: "plan_update",
      plan: { type: "file", planId: "file", uri: "file:///work/PLAN.md" },
    })

    handleUpdate(a, "s1", { sessionUpdate: "plan_removed", planId: "file" })

    expect(sessionMeta(a, "s1")?.plan).toEqual(legacyEntries)
  })

  it("keeps the latest active item plan when another plan is removed", () => {
    const a = new AcpClientAdapter()
    seedSession(a, "s1", "default")
    const first = [{ content: "First", priority: "medium", status: "pending" }]
    const second = [{ content: "Second", priority: "high", status: "in_progress" }]
    handleUpdate(a, "s1", {
      sessionUpdate: "plan_update",
      plan: { type: "items", planId: "first", entries: first },
    })
    handleUpdate(a, "s1", {
      sessionUpdate: "plan_update",
      plan: { type: "items", planId: "second", entries: second },
    })
    handleUpdate(a, "s1", {
      sessionUpdate: "plan_update",
      plan: { type: "file", planId: "file", uri: "file:///work/PLAN.md" },
    })

    handleUpdate(a, "s1", { sessionUpdate: "plan_removed", planId: "file" })
    expect(sessionMeta(a, "s1")?.plan).toEqual(second)

    handleUpdate(a, "s1", { sessionUpdate: "plan_removed", planId: "second" })
    expect(sessionMeta(a, "s1")?.plan).toEqual(first)
  })

  it("maps the canonical agent_thought_chunk to a thinking event", () => {
    const a = new AcpClientAdapter()
    seedSession(a, "s1", "default")
    const ev = handleUpdate(a, "s1", {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "pondering" },
    }) as { type: string; thinking: string }
    expect(ev).toMatchObject({ type: "thinking", thinking: "pondering" })
  })

  it("keeps ACP tool titles separate from presentation metadata and forwards title updates", () => {
    const a = new AcpClientAdapter()
    seedSession(a, "s1", "default")

    const started = handleUpdate(a, "s1", {
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "Reading configuration",
      kind: "read",
      status: "pending",
      rawInput: { path: "config.json" },
      locations: [{ path: "config.json" }],
    })
    expect(started).toMatchObject({
      type: "tool_use_start",
      toolUseId: "tool-1",
      toolName: "Reading configuration",
      title: "Reading configuration",
      toolMetadata: { kind: "read", locations: [{ path: "config.json" }] },
    })

    const updated = handleUpdate(a, "s1", {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      title: "Read config.json",
      kind: "read",
      status: "in_progress",
      rawInput: { path: "config.json", line: 1 },
      locations: [{ path: "config.json", line: 1 }],
      content: [{ type: "content", content: { type: "text", text: "working" } }],
    })
    expect(updated).toMatchObject({
      type: "tool_call_update",
      toolCallId: "tool-1",
      title: "Read config.json",
      rawInput: { path: "config.json", line: 1 },
    })

    const titleOnly = handleUpdate(a, "s1", {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      title: "Reading config.json",
      status: "in_progress",
    })
    expect(titleOnly).toMatchObject({
      type: "tool_call_update",
      toolCallId: "tool-1",
      title: "Reading config.json",
    })
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

  it("does not treat a boolean mode-category option as a permission mode", () => {
    const a = new AcpClientAdapter()
    seedSession(a, "s1", "default")

    handleUpdate(a, "s1", {
      sessionUpdate: "config_option_update",
      configOptions: [
        {
          id: "safeMode",
          name: "Safe mode",
          type: "boolean",
          currentValue: true,
          category: "mode",
        },
      ],
    })

    const session = (
      a as unknown as { _sessions: Map<string, { permissionMode?: string }> }
    )._sessions.get("s1")
    expect(session?.permissionMode).toBe("default")
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
    expect(ev).toMatchObject({
      type: "usage_update",
      used: 1200,
      size: 200000,
      cost: { amount: 0.04, currency: "USD" },
    })
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

  it("applies and emits session_info_update title", () => {
    const a = new AcpClientAdapter()
    seedSession(a, "s1", "default")
    const ev = handleUpdate(a, "s1", {
      sessionUpdate: "session_info_update",
      title: "Refactor auth",
    })
    expect(ev).toMatchObject({ type: "session_info_update", title: "Refactor auth" })
    expect(sessionMeta(a, "s1")?.title).toBe("Refactor auth")
  })

  it("applies current_mode_update from the canonical currentModeId field", () => {
    const a = new AcpClientAdapter()
    seedSession(a, "s1", "default")

    const event = handleUpdate(a, "s1", {
      sessionUpdate: "current_mode_update",
      currentModeId: "plan",
    }) as { type: string; modeId: string }

    expect(event).toMatchObject({ type: "mode_update", modeId: "plan" })
    const session = (
      a as unknown as { _sessions: Map<string, { permissionMode?: string }> }
    )._sessions.get("s1")
    expect(session?.permissionMode).toBe("plan")
  })
})

describe("AcpClientAdapter — boolean session config options", () => {
  it("validates and sends the typed boolean set_config_option request", async () => {
    const a = new AcpClientAdapter()
    seedSession(a, "s1", "default")
    const option = {
      id: "autoFormat",
      name: "Auto format",
      type: "boolean" as const,
      currentValue: false,
    }
    const session = (
      a as unknown as { _sessions: Map<string, { metadata?: Record<string, unknown> }> }
    )._sessions.get("s1")!
    session.metadata = { configOptions: [option] }
    const spy = jest
      .spyOn(
        a as unknown as { sendRequest: (m: string, p: unknown) => Promise<unknown> },
        "sendRequest"
      )
      .mockResolvedValue({ configOptions: [{ ...option, currentValue: true }] })

    await expect(a.setConfigOption("s1", "autoFormat", true)).resolves.toEqual([
      { ...option, currentValue: true },
    ])
    expect(spy).toHaveBeenCalledWith("session/set_config_option", {
      sessionId: "s1",
      configId: "autoFormat",
      type: "boolean",
      value: true,
    })
  })
})

describe("AcpClientAdapter — session/close · session/delete · logout gating", () => {
  it("sends strict session/new parameters including empty MCP servers and additional roots", async () => {
    const a = new AcpClientAdapter()
    setStatus(a, "connected")
    ;(a as unknown as { _config: ExternalAgentConfig })._config = stdioConfig()
    setAgentCaps(a, { sessionCapabilities: { additionalDirectories: {} } })
    const spy = jest
      .spyOn(
        a as unknown as { sendRequest: (m: string, p: unknown) => Promise<unknown> },
        "sendRequest"
      )
      .mockResolvedValue({ sessionId: "s-new" })

    const session = await a.createSession({ cwd: "/work", additionalDirectories: ["/shared"] })

    expect(spy).toHaveBeenCalledWith(
      "session/new",
      expect.objectContaining({
        cwd: "/work",
        additionalDirectories: ["/shared"],
        mcpServers: [],
      })
    )
    expect(session.metadata).toMatchObject({
      cwd: "/work",
      additionalDirectories: ["/shared"],
    })
  })

  it("rejects additional roots when the agent does not advertise them", async () => {
    const a = new AcpClientAdapter()
    setStatus(a, "connected")
    ;(a as unknown as { _config: ExternalAgentConfig })._config = stdioConfig()
    setAgentCaps(a, { sessionCapabilities: {} })
    await expect(
      a.createSession({ cwd: "/work", additionalDirectories: ["/shared"] })
    ).rejects.toThrow(/additionalDirectories/)
  })

  it("normalizes required empty MCP env and header arrays on the wire", async () => {
    const a = new AcpClientAdapter()
    setStatus(a, "connected")
    ;(a as unknown as { _config: ExternalAgentConfig })._config = stdioConfig()
    const spy = jest
      .spyOn(
        a as unknown as { sendRequest: (m: string, p: unknown) => Promise<unknown> },
        "sendRequest"
      )
      .mockResolvedValue({ sessionId: "s-mcp" })

    await a.createSession({
      cwd: "/work",
      mcpServers: [
        { name: "stdio", command: "mcp", args: [] },
        { type: "http", name: "http", url: "https://mcp.example/rpc" },
        { type: "sse", name: "sse", url: "https://mcp.example/events" },
      ],
    })

    expect(spy).toHaveBeenCalledWith(
      "session/new",
      expect.objectContaining({
        mcpServers: [
          { name: "stdio", command: "mcp", args: [], env: [] },
          { type: "http", name: "http", url: "https://mcp.example/rpc", headers: [] },
          { type: "sse", name: "sse", url: "https://mcp.example/events", headers: [] },
        ],
      })
    )
  })

  it("rejects empty additional root entries as invalid absolute paths", async () => {
    const a = new AcpClientAdapter()
    setStatus(a, "connected")
    ;(a as unknown as { _config: ExternalAgentConfig })._config = stdioConfig()
    setAgentCaps(a, { sessionCapabilities: { additionalDirectories: {} } })

    await expect(a.createSession({ cwd: "/work", additionalDirectories: [""] })).rejects.toThrow(
      /absolute paths/i
    )
  })

  it("rejects a relative session cwd before sending an ACP lifecycle request", async () => {
    const a = new AcpClientAdapter()
    setStatus(a, "connected")
    ;(a as unknown as { _config: ExternalAgentConfig })._config = stdioConfig()
    const spy = jest.spyOn(
      a as unknown as { sendRequest: (m: string, p: unknown) => Promise<unknown> },
      "sendRequest"
    )

    await expect(a.createSession({ cwd: "relative/work" })).rejects.toThrow(/absolute path/i)
    expect(spy).not.toHaveBeenCalled()
  })

  it("paginates session/list with a cwd filter and preserves authoritative roots", async () => {
    const a = new AcpClientAdapter()
    setAgentCaps(a, { sessionCapabilities: { list: {} } })
    const spy = jest
      .spyOn(
        a as unknown as { sendRequest: (m: string, p: unknown) => Promise<unknown> },
        "sendRequest"
      )
      .mockResolvedValueOnce({
        sessions: [{ sessionId: "s1", cwd: "/work", additionalDirectories: ["/shared"] }],
        nextCursor: "page-2",
      })
      .mockResolvedValueOnce({ sessions: [{ sessionId: "s2", cwd: "/work" }] })

    await expect(a.listSessions({ cwd: "/work" })).resolves.toEqual([
      { sessionId: "s1", cwd: "/work", additionalDirectories: ["/shared"] },
      { sessionId: "s2", cwd: "/work" },
    ])
    expect(spy).toHaveBeenNthCalledWith(1, "session/list", { cwd: "/work" })
    expect(spy).toHaveBeenNthCalledWith(2, "session/list", { cwd: "/work", cursor: "page-2" })
  })

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

describe("AcpClientAdapter — network transports", () => {
  const mockedProxyFetch = proxyFetch as jest.Mock
  const mockedStreamingFetch = platformStreamingFetch as jest.Mock
  const mockedCreateSocket = createPlatformWebSocket as jest.Mock

  function networkConfig(transport: "websocket" | "sse"): ExternalAgentConfig {
    return {
      id: "remote-agent",
      name: "Remote agent",
      protocol: "acp",
      transport,
      network: {
        endpoint: "https://agent.example.com",
        authMethod: "bearer",
        bearerToken: "secret-token",
      },
    } as unknown as ExternalAgentConfig
  }

  function sseBody(...frames: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder()
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame))
        controller.close()
      },
    })
  }

  beforeEach(() => {
    mockIsTauri.mockReturnValue(true)
    // The advisory /health probe runs before either transport is set up.
    mockedProxyFetch.mockReset().mockResolvedValue(new Response("", { status: 404 }))
    mockedStreamingFetch.mockReset()
    mockedCreateSocket.mockReset()
  })

  it("dials the WebSocket transport through the proxy-aware socket, carrying the bearer", async () => {
    const socket = { id: "h1", kind: "native", send: jest.fn(), close: jest.fn() }
    mockedCreateSocket.mockResolvedValue(socket)
    const adapter = new AcpClientAdapter()

    await (
      adapter as unknown as {
        connectViaNetwork: (c: ExternalAgentConfig) => Promise<void>
      }
    ).connectViaNetwork(networkConfig("websocket"))

    const [url, options] = mockedCreateSocket.mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ]
    expect(url).toBe("https://agent.example.com/message")
    // The bare `WebSocket` constructor cannot send this, which is why the
    // transport had to change rather than just being wrapped.
    expect(options.headers.Authorization).toBe("Bearer secret-token")
  })

  it("feeds WebSocket frames to the JSON-RPC peer", async () => {
    let onMessage: ((data: string) => void) | undefined
    mockedCreateSocket.mockImplementation(async (_url, options) => {
      onMessage = options.onMessage
      return { id: "h1", kind: "native", send: jest.fn(), close: jest.fn() }
    })
    const adapter = new AcpClientAdapter()
    const ingest = jest.fn()
    ;(adapter as unknown as { peer?: { ingest: jest.Mock } }).peer = { ingest }

    await (
      adapter as unknown as {
        connectViaNetwork: (c: ExternalAgentConfig) => Promise<void>
      }
    ).connectViaNetwork(networkConfig("websocket"))
    onMessage?.('{"jsonrpc":"2.0","id":1}')

    expect(ingest).toHaveBeenCalledWith('{"jsonrpc":"2.0","id":1}')
  })

  it("subscribes to the SSE endpoint with an Accept header and streams frames to the peer", async () => {
    mockedStreamingFetch.mockResolvedValue(
      new Response(sseBody('data: {"a":1}\n\n', 'data: {"b":2}\n\n'), { status: 200 })
    )
    const adapter = new AcpClientAdapter()
    const ingest = jest.fn()
    ;(adapter as unknown as { peer?: { ingest: jest.Mock } }).peer = { ingest }

    await (
      adapter as unknown as {
        connectViaNetwork: (c: ExternalAgentConfig) => Promise<void>
      }
    ).connectViaNetwork(networkConfig("sse"))
    // The read loop is detached on purpose; let it drain.
    await new Promise((resolve) => setTimeout(resolve, 0))

    const [url, init] = mockedStreamingFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://agent.example.com/events")
    expect((init.headers as Record<string, string>).accept).toBe("text/event-stream")
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret-token")
    expect(ingest).toHaveBeenNthCalledWith(1, '{"a":1}')
    expect(ingest).toHaveBeenNthCalledWith(2, '{"b":2}')
  })

  it("fails the connect when the SSE endpoint answers non-2xx", async () => {
    // `EventSource` reported this as an opaque onerror; the streaming
    // transport can say which status came back.
    mockedStreamingFetch.mockResolvedValue(new Response("nope", { status: 503 }))
    const adapter = new AcpClientAdapter()

    await expect(
      (
        adapter as unknown as {
          connectViaNetwork: (c: ExternalAgentConfig) => Promise<void>
        }
      ).connectViaNetwork(networkConfig("sse"))
    ).rejects.toThrow("SSE connection failed: HTTP 503")
  })

  it("fails the connect when the SSE transport itself throws", async () => {
    mockedStreamingFetch.mockRejectedValue(new Error("Proxy stream failed: dns error"))
    const adapter = new AcpClientAdapter()

    await expect(
      (
        adapter as unknown as {
          connectViaNetwork: (c: ExternalAgentConfig) => Promise<void>
        }
      ).connectViaNetwork(networkConfig("sse"))
    ).rejects.toThrow("SSE connection failed: Proxy stream failed: dns error")
  })
})
