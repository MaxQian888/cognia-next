/**
 * Tests for OpenCodeClientAdapter. Unlike the previous smoke suite (which used
 * the no-method stub mock), this suite installs a programmable fake SDK client
 * so we can exercise the real connection, auth, streaming, and auto-spawn paths
 * against deterministic fixtures.
 */

import type {
  ExternalAgentConfig,
  ExternalAgentMessage,
  AcpPermissionResponse,
} from "@/types/agent/external-agent"

// --- Mock the SDK client factory -------------------------------------------
const mockCreateOpencodeClient = jest.fn()
jest.mock("@opencode-ai/sdk/client", () => ({
  createOpencodeClient: (...args: unknown[]) => mockCreateOpencodeClient(...args),
}))

// --- Mock the desktop runtime + native process bridge ----------------------
const mockIsTauri = jest.fn(() => false)
jest.mock("@/lib/utils", () => {
  const actual = jest.requireActual("@/lib/utils")
  return { ...actual, isTauri: () => mockIsTauri() }
})

const mockSpawn = jest.fn()
const mockKill = jest.fn()
const mockOnStdout = jest.fn()
const mockOnStderr = jest.fn()
const mockOnExit = jest.fn()
jest.mock("@/lib/native/external-agent", () => ({
  spawnExternalAgent: (...args: unknown[]) => mockSpawn(...args),
  killExternalAgent: (...args: unknown[]) => mockKill(...args),
  onExternalAgentStdout: (...args: unknown[]) => mockOnStdout(...args),
  onExternalAgentStderr: (...args: unknown[]) => mockOnStderr(...args),
  onExternalAgentExit: (...args: unknown[]) => mockOnExit(...args),
}))

type StreamingFetchArgs = [RequestInfo | URL, RequestInit?]
const mockedStreamingFetch = jest.fn(
  async (..._args: StreamingFetchArgs): Promise<Response> => new Response("ok")
)
jest.mock("@/lib/network/platform-streaming-fetch", () => ({
  // Forwarded by rest so arity is preserved: `fetch(request)` and
  // `fetch(request, undefined)` must stay distinguishable in the assertions.
  platformStreamingFetch: (...args: StreamingFetchArgs) => mockedStreamingFetch(...args),
}))

import { OpenCodeClientAdapter } from "./opencode-client"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type AsyncStream<T> = { stream: AsyncIterable<T> }

function streamOf<T>(items: T[]): AsyncStream<T> {
  return {
    stream: (async function* () {
      for (const item of items) {
        yield item
      }
    })(),
  }
}

function failingStream(error: Error): AsyncStream<never> {
  return {
    stream: (async function* () {
      throw error
    })(),
  }
}

/** A fully-populated fake OpencodeClient where every call resolves `{ data }`. */
function makeFakeClient(overrides: Record<string, unknown> = {}) {
  const ok = (data: unknown) => jest.fn().mockResolvedValue({ data })
  const client = {
    global: { event: jest.fn().mockResolvedValue(streamOf([])) },
    config: {
      get: ok({ model: "anthropic/claude" }),
      update: ok(true),
      providers: ok({ providers: [], default: {} }),
    },
    provider: {
      list: ok({ all: [], default: {}, connected: [] }),
      auth: ok({}),
      oauth: { authorize: ok({ url: "http://oauth" }) },
    },
    app: { agents: ok([]), log: ok(true) },
    command: { list: ok([]) },
    tool: { list: ok([]), ids: ok(["bash"]) },
    session: {
      create: ok({ id: "s1", title: "t", time: { created: 1, updated: 2 } }),
      list: ok([{ id: "s1", title: "t", time: { created: 1, updated: 2 } }]),
      fork: ok({ id: "s2", time: { created: 3, updated: 4 } }),
      get: ok({ id: "s1", time: { created: 1, updated: 2 } }),
      update: ok({ id: "s1", title: "new" }),
      delete: ok(true),
      abort: ok(true),
      promptAsync: jest.fn().mockResolvedValue({}),
      prompt: ok({ info: { id: "m1" }, parts: [] }),
      command: ok({ info: { id: "m2" }, parts: [] }),
      shell: ok({ output: "ok" }),
      diff: ok([]),
      todo: ok([]),
      messages: ok([]),
      message: ok({ info: { id: "m1" }, parts: [] }),
      share: ok({ id: "s1", share: { url: "http://share" } }),
      unshare: ok({ id: "s1" }),
      summarize: ok(true),
      revert: ok({ id: "s1" }),
      unrevert: ok({ id: "s1" }),
      init: ok(true),
      children: ok([]),
      status: ok({}),
    },
    event: { subscribe: jest.fn().mockResolvedValue(streamOf([])) },
    file: { read: ok({ type: "raw", content: "x" }), list: ok([]), status: ok([]) },
    find: { text: ok([]), files: ok([]), symbols: ok([]) },
    vcs: { get: ok({ branch: "main" }) },
    project: { current: ok({ id: "p1" }), list: ok([]) },
    mcp: { status: ok({}), add: ok(true), connect: ok(true), disconnect: ok(true) },
    lsp: { status: ok({}) },
    formatter: { status: ok({}) },
    pty: {
      list: ok([]),
      create: ok({ id: "pty1" }),
      get: ok({ id: "pty1" }),
      remove: ok(true),
    },
    tui: {
      appendPrompt: ok(true),
      submitPrompt: ok(true),
      clearPrompt: ok(true),
      executeCommand: ok(true),
      showToast: ok(true),
      openHelp: ok(true),
      openSessions: ok(true),
      openThemes: ok(true),
      openModels: ok(true),
    },
    auth: { set: ok(true) },
    instance: { dispose: ok(true) },
    path: { get: ok({ cwd: "/tmp" }) },
    postSessionIdPermissionsPermissionId: jest.fn().mockResolvedValue({ data: true }),
  }
  return Object.assign(client, overrides)
}

function buildConfig(overrides: Partial<ExternalAgentConfig> = {}): ExternalAgentConfig {
  return {
    id: "agent",
    name: "OC",
    protocol: "opencode",
    transport: "sse",
    enabled: true,
    defaultPermissionMode: "default",
    timeout: 1000,
    metadata: { hostname: "127.0.0.1", port: 4096 },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

function textMessage(text: string): ExternalAgentMessage {
  return {
    id: "u1",
    role: "user",
    content: [{ type: "text", text }],
    timestamp: new Date(),
  } as ExternalAgentMessage
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of iter) out.push(item)
  return out
}

beforeEach(() => {
  jest.clearAllMocks()
  // `clearAllMocks` clears call records but NOT queued `mockResolvedValueOnce` /
  // `mockRejectedValueOnce` implementations — an unconsumed one-shot leaks into
  // the next test and makes results order-dependent. Reset the spawn/kill queues
  // so each test starts from a known state.
  mockSpawn.mockReset()
  mockKill.mockReset()
  mockIsTauri.mockReturnValue(false)
  // Default: stderr listener registers fine but never emits. Individual
  // spawn tests override it to exercise the stderr "listening" path.
  mockOnStderr.mockResolvedValue(() => {})
})

// ---------------------------------------------------------------------------
// Basic state (no connection required)
// ---------------------------------------------------------------------------

describe("OpenCodeClientAdapter — basic state", () => {
  it("has the expected protocol identifier and starts disconnected", () => {
    const a = new OpenCodeClientAdapter()
    expect(a.protocol).toBe("opencode")
    expect(a.connectionStatus).toBe("disconnected")
    expect(a.isConnected()).toBe(false)
    expect(a.capabilities).toBeUndefined()
  })

  it("reports extensions as unknown before connect and supported once connected", () => {
    const a = new OpenCodeClientAdapter()
    // Before connect there is no server to exercise — report unknown, not a
    // hardcoded supported.
    const before = a.getSessionExtensionSupport()
    expect(before["session/list"].state).toBe("unknown")
    expect(before["session/fork"].state).toBe("unknown")
    expect(before["session/resume"].state).toBe("unknown")
    expect(before["session/resume"].reason).toMatch(/not connected/i)

    // Once connected, the typed SDK contract guarantees these operations.
    ;(a as unknown as { _connectionStatus: string })._connectionStatus = "connected"
    const after = a.getSessionExtensionSupport()
    expect(after["session/list"].state).toBe("supported")
    expect(after["session/fork"].state).toBe("supported")
    expect(after["session/resume"].state).toBe("supported")
    expect(() => a.clearSessionExtensionSupportCache()).not.toThrow()
  })

  it("exposes canonical init metadata and empty auth methods", () => {
    const a = new OpenCodeClientAdapter()
    expect(a.getAcpInitializationMetadata().agentInfo?.name).toBe("opencode")
    expect(a.isAuthenticationRequired()).toBe(false)
    expect(a.getAuthMethods()).toEqual([])
    expect(a.getSessionModels("missing")).toBeUndefined()
    expect(a.getConfigOptions("missing")).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Connection + health probe
// ---------------------------------------------------------------------------

describe("OpenCodeClientAdapter — connect", () => {
  it("connects using the explicit endpoint and probes via config.get (not SSE)", async () => {
    const client = makeFakeClient()
    mockCreateOpencodeClient.mockReturnValue(client)
    const a = new OpenCodeClientAdapter()

    await a.connect(buildConfig({ network: { endpoint: "http://example:9999/" } }))

    expect(a.connectionStatus).toBe("connected")
    expect(mockCreateOpencodeClient).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: "http://example:9999" })
    )
    expect(client.config.get).toHaveBeenCalled()
    // No SSE leak: connect must not open the persistent global event stream.
    expect(client.global.event).not.toHaveBeenCalled()
    expect(a.capabilities?.streaming).toBe(true)
  })

  it("falls back to the default local URL when no endpoint is configured", async () => {
    mockCreateOpencodeClient.mockReturnValue(makeFakeClient())
    const a = new OpenCodeClientAdapter()
    await a.connect(buildConfig({ metadata: {} }))
    expect(mockCreateOpencodeClient).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: "http://127.0.0.1:4096" })
    )
  })

  it("marks status error and rethrows when the probe fails", async () => {
    const client = makeFakeClient({
      config: { get: jest.fn().mockRejectedValue(new Error("ECONNREFUSED")) },
    })
    mockCreateOpencodeClient.mockReturnValue(client)
    const a = new OpenCodeClientAdapter()
    await expect(a.connect(buildConfig({ network: { endpoint: "http://x" } }))).rejects.toThrow()
    expect(a.connectionStatus).toBe("error")
  })

  it("healthCheck returns true/false based on config.get", async () => {
    const client = makeFakeClient()
    mockCreateOpencodeClient.mockReturnValue(client)
    const a = new OpenCodeClientAdapter()
    await a.connect(buildConfig({ network: { endpoint: "http://x" } }))
    await expect(a.healthCheck()).resolves.toBe(true)
    client.config.get.mockRejectedValueOnce(new Error("down"))
    await expect(a.healthCheck()).resolves.toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

describe("OpenCodeClientAdapter — auth fetch", () => {
  async function captureFetch(config: ExternalAgentConfig) {
    mockCreateOpencodeClient.mockReturnValue(makeFakeClient())
    const a = new OpenCodeClientAdapter()
    await a.connect(config)
    const arg = mockCreateOpencodeClient.mock.calls[0][0] as {
      fetch?: (req: Request) => unknown
    }
    return arg.fetch
  }

  it("injects HTTP Basic Auth from metadata.serverPassword", async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response("ok")) as typeof fetch
    const fetchFn = await captureFetch(
      buildConfig({ network: { endpoint: "http://x" }, metadata: { serverPassword: "secret" } })
    )
    expect(typeof fetchFn).toBe("function")
    const setSpy = jest.fn()
    fetchFn!({ headers: { set: setSpy } } as unknown as Request)
    const expected = `Basic ${Buffer.from("opencode:secret", "utf-8").toString("base64")}`
    expect(setSpy).toHaveBeenCalledWith("Authorization", expected)
  })

  it("honors a custom server username for Basic Auth", async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response("ok")) as typeof fetch
    const fetchFn = await captureFetch(
      buildConfig({
        network: { endpoint: "http://x" },
        metadata: { serverPassword: "p", serverUsername: "admin" },
      })
    )
    const setSpy = jest.fn()
    fetchFn!({ headers: { set: setSpy } } as unknown as Request)
    expect(setSpy).toHaveBeenCalledWith(
      "Authorization",
      `Basic ${Buffer.from("admin:p", "utf-8").toString("base64")}`
    )
  })

  it("injects a Bearer token from network.bearerToken / apiKey", async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response("ok")) as typeof fetch
    const fetchFn = await captureFetch(
      buildConfig({ network: { endpoint: "http://x", bearerToken: "tok" } })
    )
    const setSpy = jest.fn()
    fetchFn!({ headers: { set: setSpy } } as unknown as Request)
    expect(setSpy).toHaveBeenCalledWith("Authorization", "Bearer tok")
  })

  it("merges custom headers", async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response("ok")) as typeof fetch
    const fetchFn = await captureFetch(
      buildConfig({ network: { endpoint: "http://x", headers: { "X-Trace": "1" } } })
    )
    const setSpy = jest.fn()
    fetchFn!({ headers: { set: setSpy } } as unknown as Request)
    expect(setSpy).toHaveBeenCalledWith("X-Trace", "1")
  })

  it("still installs the host transport when no auth is configured", async () => {
    // Previously `undefined`, which let the SDK fall back to a bare `fetch` —
    // unreachable in the packaged shell for BOTH a remote host and the
    // auto-spawned loopback one, and invisible to the configured proxy.
    const fetchFn = await captureFetch(buildConfig({ network: { endpoint: "http://x" } }))
    expect(typeof fetchFn).toBe("function")
  })

  it("routes every request through the streaming transport, headers or not", async () => {
    const fetchFn = await captureFetch(
      buildConfig({ network: { endpoint: "http://x", bearerToken: "tok" } })
    )
    const request = { headers: { set: jest.fn() } } as unknown as Request

    await fetchFn!(request)

    // The SDK reuses this hook for `/event`, whose SSE body never ends, so it
    // has to be the streaming transport rather than the buffered bridge.
    expect(mockedStreamingFetch).toHaveBeenCalledWith(request)
  })
})

// ---------------------------------------------------------------------------
// Desktop auto-spawn
// ---------------------------------------------------------------------------

describe("OpenCodeClientAdapter — auto-spawn", () => {
  it("throws when auto-spawn is requested off-desktop", async () => {
    mockIsTauri.mockReturnValue(false)
    mockCreateOpencodeClient.mockReturnValue(makeFakeClient())
    const a = new OpenCodeClientAdapter()
    await expect(a.connect(buildConfig({ metadata: { autoSpawnServer: true } }))).rejects.toThrow(
      /desktop/i
    )
  })

  it("spawns opencode serve, parses the listening URL, and connects", async () => {
    mockIsTauri.mockReturnValue(true)
    mockCreateOpencodeClient.mockReturnValue(makeFakeClient())
    mockSpawn.mockResolvedValue("agent")
    mockKill.mockResolvedValue(undefined)
    mockOnExit.mockResolvedValue(() => {})
    mockOnStdout.mockImplementation((cb: (e: { agentId: string; data: string }) => void) => {
      setTimeout(
        () =>
          cb({
            agentId: "opencode-server-agent",
            data: "opencode server listening on http://127.0.0.1:55001\n",
          }),
        0
      )
      return Promise.resolve(() => {})
    })

    const a = new OpenCodeClientAdapter()
    await a.connect(
      buildConfig({ metadata: { autoSpawnServer: true }, process: { command: "opencode" } })
    )

    expect(mockSpawn).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "opencode-server-agent",
        command: "opencode",
        args: expect.arrayContaining(["serve", "--port=0"]),
      })
    )
    expect(mockCreateOpencodeClient).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: "http://127.0.0.1:55001" })
    )

    await a.disconnect()
    expect(mockKill).toHaveBeenCalledWith("opencode-server-agent")
  })

  it("reclaims an orphaned server process when the id is already registered", async () => {
    // The Rust process manager keys children by id and outlives the JS realm, so
    // a page reload / dev Fast Refresh leaves an `opencode-server-<id>` child
    // that nothing listens to while every respawn is rejected — bricking the
    // agent until the whole app restarts.
    mockIsTauri.mockReturnValue(true)
    mockCreateOpencodeClient.mockReturnValue(makeFakeClient())
    mockSpawn
      .mockRejectedValueOnce("Agent opencode-server-agent is already running")
      .mockResolvedValueOnce("agent")
    mockKill.mockResolvedValue(undefined)
    mockOnExit.mockResolvedValue(() => {})
    mockOnStdout.mockImplementation((cb: (e: { agentId: string; data: string }) => void) => {
      setTimeout(
        () =>
          cb({
            agentId: "opencode-server-agent",
            data: "opencode server listening on http://127.0.0.1:55001\n",
          }),
        0
      )
      return Promise.resolve(() => {})
    })

    const a = new OpenCodeClientAdapter()
    await a.connect(
      buildConfig({ metadata: { autoSpawnServer: true }, process: { command: "opencode" } })
    )

    expect(mockKill).toHaveBeenCalledWith("opencode-server-agent")
    expect(mockSpawn).toHaveBeenCalledTimes(2)
    expect(mockCreateOpencodeClient).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: "http://127.0.0.1:55001" })
    )
  })

  it("propagates a spawn failure that is not an already-running collision", async () => {
    mockIsTauri.mockReturnValue(true)
    mockCreateOpencodeClient.mockReturnValue(makeFakeClient())
    mockSpawn.mockRejectedValueOnce("Failed to spawn process: ENOENT")
    mockKill.mockResolvedValue(undefined)
    mockOnExit.mockResolvedValue(() => {})
    mockOnStdout.mockResolvedValue(() => {})

    const a = new OpenCodeClientAdapter()
    await expect(
      a.connect(
        buildConfig({ metadata: { autoSpawnServer: true }, process: { command: "opencode" } })
      )
    ).rejects.toMatch(/ENOENT/)
    expect(mockSpawn).toHaveBeenCalledTimes(1)
  })

  it("also resolves the listening URL from stderr (some runtimes log there)", async () => {
    mockIsTauri.mockReturnValue(true)
    mockCreateOpencodeClient.mockReturnValue(makeFakeClient())
    mockSpawn.mockResolvedValue("agent")
    mockKill.mockResolvedValue(undefined)
    mockOnExit.mockResolvedValue(() => {})
    mockOnStdout.mockResolvedValue(() => {})
    mockOnStderr.mockImplementation((cb: (e: { agentId: string; data: string }) => void) => {
      setTimeout(
        () =>
          cb({
            agentId: "opencode-server-agent",
            data: "opencode server listening on http://127.0.0.1:55002\n",
          }),
        0
      )
      return Promise.resolve(() => {})
    })

    const a = new OpenCodeClientAdapter()
    await a.connect(
      buildConfig({ metadata: { autoSpawnServer: true }, process: { command: "opencode" } })
    )
    expect(mockCreateOpencodeClient).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: "http://127.0.0.1:55002" })
    )
    await a.disconnect()
  })

  it("kills the process and fails if it exits before becoming ready", async () => {
    mockIsTauri.mockReturnValue(true)
    mockCreateOpencodeClient.mockReturnValue(makeFakeClient())
    mockSpawn.mockResolvedValue("agent")
    mockKill.mockResolvedValue(undefined)
    mockOnStdout.mockResolvedValue(() => {})
    mockOnExit.mockImplementation((cb: (e: { agentId: string; code: number }) => void) => {
      setTimeout(() => cb({ agentId: "opencode-server-agent", code: 1 }), 0)
      return Promise.resolve(() => {})
    })

    const a = new OpenCodeClientAdapter()
    await expect(a.connect(buildConfig({ metadata: { autoSpawnServer: true } }))).rejects.toThrow(
      /exited/i
    )
    expect(mockKill).toHaveBeenCalledWith("opencode-server-agent")
  })

  it("times out (and kills) when the listening line never arrives", async () => {
    mockIsTauri.mockReturnValue(true)
    mockCreateOpencodeClient.mockReturnValue(makeFakeClient())
    mockSpawn.mockResolvedValue("agent")
    mockKill.mockResolvedValue(undefined)
    mockOnStdout.mockResolvedValue(() => {})
    mockOnExit.mockResolvedValue(() => {})

    const a = new OpenCodeClientAdapter()
    await expect(
      a.connect(
        buildConfig({
          metadata: { autoSpawnServer: true },
          process: { command: "opencode", startupTimeout: 30 },
        })
      )
    ).rejects.toThrow(/timed out/i)
    expect(mockKill).toHaveBeenCalledWith("opencode-server-agent")
  })
})

// ---------------------------------------------------------------------------
// Streaming prompt (the previously-broken event path)
// ---------------------------------------------------------------------------

describe("OpenCodeClientAdapter — streaming prompt", () => {
  async function connectWithEvents(events: unknown[]) {
    const client = makeFakeClient()
    client.event.subscribe = jest.fn().mockResolvedValue(streamOf(events))
    mockCreateOpencodeClient.mockReturnValue(client)
    const a = new OpenCodeClientAdapter()
    await a.connect(buildConfig({ network: { endpoint: "http://x" } }))
    return { a, client }
  }

  it("subscribes to events BEFORE sending the prompt (no missed early events)", async () => {
    const { a, client } = await connectWithEvents([{ type: "session.idle", properties: {} }])
    const session = await a.createSession()
    await collect(a.prompt(session.id, textMessage("hi")))

    const subscribeOrder = (client.event.subscribe as jest.Mock).mock.invocationCallOrder[0]
    const promptOrder = (client.session.promptAsync as jest.Mock).mock.invocationCallOrder[0]
    expect(subscribeOrder).toBeLessThan(promptOrder)
  })

  it("translates message/tool/idle SSE events into external-agent events", async () => {
    const events = [
      {
        type: "message.part.updated",
        properties: { part: { type: "text", sessionID: "s1", text: "Hello" }, delta: "Hello" },
      },
      {
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            sessionID: "s1",
            callID: "c1",
            tool: "bash",
            state: { status: "running", input: { cmd: "ls" } },
          },
        },
      },
      { type: "session.idle", properties: { sessionID: "s1" } },
    ]
    const { a } = await connectWithEvents(events)
    const session = await a.createSession()
    const out = await collect(a.prompt(session.id, textMessage("hi")))

    const types = out.map((e) => e.type)
    expect(types).toContain("session_start")
    expect(types).toContain("message_delta")
    expect(types).toContain("tool_use_start")
    expect(types).toContain("done")
    const delta = out.find((e) => e.type === "message_delta") as { delta: { text: string } }
    expect(delta.delta.text).toBe("Hello")
  })

  it("emits a cancelled done event when aborted via signal", async () => {
    const { a, client } = await connectWithEvents([])
    // The real SDK rejects an SSE subscribe whose AbortSignal is already
    // aborted; mirror that so the cancellation path is exercised.
    client.event.subscribe = jest
      .fn()
      .mockImplementation(({ signal }: { signal?: AbortSignal }) => {
        if (signal?.aborted) {
          return Promise.reject(new DOMException("Aborted", "AbortError"))
        }
        return Promise.resolve(streamOf([]))
      })
    const session = await a.createSession()
    const controller = new AbortController()
    controller.abort()
    const out = await collect(
      a.prompt(session.id, textMessage("hi"), { signal: controller.signal })
    )
    const done = out.find((e) => e.type === "done") as { success: boolean; stopReason?: string }
    expect(done.success).toBe(false)
    expect(done.stopReason).toBe("cancelled")
  })

  it("cancel() aborts the controller and calls session.abort", async () => {
    const { a, client } = await connectWithEvents([])
    const session = await a.createSession()
    await a.cancel(session.id)
    expect(client.session.abort).toHaveBeenCalledWith({ path: { id: session.id } })
  })
})

// ---------------------------------------------------------------------------
// translateSdkEvent (pure)
// ---------------------------------------------------------------------------

describe("translateSdkEvent", () => {
  const a = new OpenCodeClientAdapter()

  it("maps reasoning parts to thinking", () => {
    const events = a.translateSdkEvent("s1", {
      type: "message.part.updated",
      properties: { part: { type: "reasoning", sessionID: "s1", text: "hmm" } },
    } as never)
    expect(events[0]).toMatchObject({ type: "thinking", thinking: "hmm" })
  })

  it("maps completed tool parts to a successful tool_result", () => {
    const events = a.translateSdkEvent("s1", {
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          sessionID: "s1",
          callID: "c1",
          tool: "bash",
          state: { status: "completed", output: "done" },
        },
      },
    } as never)
    expect(events[0]).toMatchObject({ type: "tool_result", isError: false, result: "done" })
  })

  it("maps todo.updated to a plan_update", () => {
    const events = a.translateSdkEvent("s1", {
      type: "todo.updated",
      properties: {
        sessionID: "s1",
        todos: [
          { content: "a", status: "completed", priority: "high" },
          { content: "b", status: "in_progress", priority: "medium" },
        ],
      },
    } as never)
    expect(events[0]).toMatchObject({ type: "plan_update", totalSteps: 2 })
  })

  it("maps permission.updated to a permission_request", () => {
    const events = a.translateSdkEvent("s1", {
      type: "permission.updated",
      properties: { id: "perm1", sessionID: "s1", type: "edit", title: "Edit file" },
    } as never)
    expect(events[0]).toMatchObject({ type: "permission_request" })
  })

  it("maps current permission.asked events and replies through the current endpoint", async () => {
    const client = makeFakeClient()
    mockCreateOpencodeClient.mockReturnValue(client)
    mockedStreamingFetch.mockResolvedValue(new Response(null, { status: 200 }))
    const connected = new OpenCodeClientAdapter()
    await connected.connect(buildConfig({ network: { endpoint: "http://opencode.test" } }))

    const events = connected.translateSdkEvent("s1", {
      type: "permission.asked",
      properties: {
        id: "perm-current",
        sessionID: "s1",
        permission: "bash",
        patterns: ["git status", "git diff"],
        metadata: { command: "git status" },
        always: ["git *"],
        tool: { messageID: "m1", callID: "call-1" },
      },
    } as never)

    expect(events[0]).toMatchObject({
      type: "permission_request",
      request: {
        requestId: "perm-current",
        toolCallId: "call-1",
        rawInput: { patterns: ["git status", "git diff"] },
      },
    })
    await connected.respondToPermission("s1", {
      requestId: "perm-current",
      granted: true,
      rememberChoice: true,
    })

    const request = mockedStreamingFetch.mock.calls.at(-1)![0] as Request
    expect(request.url).toBe("http://opencode.test/permission/perm-current/reply")
    await expect(request.json()).resolves.toEqual({ reply: "always" })
    expect(client.postSessionIdPermissionsPermissionId).not.toHaveBeenCalled()
  })

  it("maps permission.v2.asked and replies through the session-scoped v2 endpoint", async () => {
    mockCreateOpencodeClient.mockReturnValue(makeFakeClient())
    mockedStreamingFetch.mockResolvedValue(new Response(null, { status: 204 }))
    const connected = new OpenCodeClientAdapter()
    await connected.connect(buildConfig({ network: { endpoint: "http://opencode.test" } }))

    const events = connected.translateSdkEvent("s1", {
      type: "permission.v2.asked",
      properties: {
        id: "perm-v2",
        sessionID: "s1",
        action: "edit",
        resources: ["/workspace/file.ts"],
        save: ["/workspace/*"],
        metadata: { diff: "+change" },
        source: { type: "tool", messageID: "m2", callID: "call-2" },
      },
    } as never)

    expect(events[0]).toMatchObject({
      type: "permission_request",
      request: {
        requestId: "perm-v2",
        toolCallId: "call-2",
        rawInput: { resources: ["/workspace/file.ts"] },
      },
    })
    await connected.respondToPermission("s1", { requestId: "perm-v2", granted: false })

    const request = mockedStreamingFetch.mock.calls.at(-1)![0] as Request
    expect(request.url).toBe("http://opencode.test/api/session/s1/permission/perm-v2/reply")
    await expect(request.json()).resolves.toEqual({ reply: "reject" })
  })

  it.each([
    ["question.asked", "/question/question-1/reply"],
    ["question.v2.asked", "/api/session/s1/question/question-1/reply"],
  ])("maps %s and returns ordered answers", async (eventType, expectedPath) => {
    mockCreateOpencodeClient.mockReturnValue(makeFakeClient())
    mockedStreamingFetch.mockResolvedValue(new Response(null, { status: 200 }))
    const connected = new OpenCodeClientAdapter()
    await connected.connect(buildConfig({ network: { endpoint: "http://opencode.test" } }))

    const events = connected.translateSdkEvent("s1", {
      type: eventType,
      properties: {
        id: "question-1",
        sessionID: "s1",
        questions: [
          {
            header: "Region",
            question: "Choose regions",
            options: [
              { label: "us-east", description: "Virginia" },
              { label: "eu-west", description: "Ireland" },
            ],
            multiple: true,
            custom: false,
          },
          { header: "Note", question: "Deployment note", options: [], custom: true },
        ],
        tool: { messageID: "m3", callID: "call-3" },
      },
    } as never)

    expect(events[0]).toMatchObject({
      type: "permission_request",
      request: {
        requestId: "question-1",
        toolCallId: "call-3",
        metadata: {
          codexUserInput: {
            questions: [
              { id: "question-1:0", multiple: true },
              { id: "question-1:1", isOther: true },
            ],
          },
        },
      },
    })
    await connected.respondToPermission("s1", {
      requestId: "question-1",
      granted: true,
      answers: {
        "question-1:0": ["us-east", "eu-west"],
        "question-1:1": ["ship tonight"],
      },
    })

    const request = mockedStreamingFetch.mock.calls.at(-1)![0] as Request
    expect(request.url).toBe(`http://opencode.test${expectedPath}`)
    await expect(request.json()).resolves.toEqual({
      answers: [["us-east", "eu-west"], ["ship tonight"]],
    })
  })

  it("rejects a partially malformed question payload instead of leaving the server blocked", async () => {
    mockCreateOpencodeClient.mockReturnValue(makeFakeClient())
    mockedStreamingFetch.mockResolvedValue(new Response(null, { status: 200 }))
    const connected = new OpenCodeClientAdapter()
    await connected.connect(buildConfig({ network: { endpoint: "http://opencode.test" } }))

    const events = connected.translateSdkEvent("s1", {
      type: "question.asked",
      properties: {
        id: "question-malformed",
        sessionID: "s1",
        questions: [
          { header: "Valid", question: "First question", options: [] },
          { header: "Invalid", options: [] },
        ],
      },
    } as never)

    expect(events).toEqual([])
    await Promise.resolve()
    const request = mockedStreamingFetch.mock.calls.at(-1)![0] as Request
    expect(request.url).toBe("http://opencode.test/question/question-malformed/reject")
  })

  it("correlates pending v2 interactions by session and request id", async () => {
    mockCreateOpencodeClient.mockReturnValue(makeFakeClient())
    mockedStreamingFetch.mockResolvedValue(new Response(null, { status: 204 }))
    const connected = new OpenCodeClientAdapter()
    await connected.connect(buildConfig({ network: { endpoint: "http://opencode.test" } }))

    for (const sessionID of ["s1", "s2"]) {
      connected.translateSdkEvent(sessionID, {
        type: "permission.v2.asked",
        properties: {
          id: "shared-request",
          sessionID,
          action: "edit",
          resources: [`/${sessionID}/file.ts`],
        },
      } as never)
    }

    await connected.respondToPermission("s1", {
      requestId: "shared-request",
      granted: true,
    })
    await connected.respondToPermission("s2", {
      requestId: "shared-request",
      granted: false,
    })

    const urls = mockedStreamingFetch.mock.calls
      .slice(-2)
      .map(([request]) => (request as Request).url)
    expect(urls).toEqual([
      "http://opencode.test/api/session/s1/permission/shared-request/reply",
      "http://opencode.test/api/session/s2/permission/shared-request/reply",
    ])
  })

  it("ignores events for other sessions", () => {
    const events = a.translateSdkEvent("s1", {
      type: "message.part.updated",
      properties: { part: { type: "text", sessionID: "other", text: "x" } },
    } as never)
    expect(events).toEqual([])
  })

  it("surfaces assistant token usage and message_end on a completed message.updated", () => {
    const events = a.translateSdkEvent("s1", {
      type: "message.updated",
      properties: {
        info: {
          id: "m1",
          role: "assistant",
          tokens: { input: 100, output: 40, reasoning: 10, cache: { read: 5, write: 0 } },
          cost: 0.01,
          time: { created: 1, completed: 2 },
        },
      },
    } as never)
    const end = events.find((e) => e.type === "message_end") as {
      tokenUsage?: { promptTokens: number; completionTokens: number; totalTokens: number }
    }
    expect(end?.tokenUsage).toMatchObject({
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
    })
  })

  it("keeps the provider's own cost, without inventing a currency", () => {
    // `cost` was read off `message.updated` and then dropped, so a paid
    // OpenCode turn reported tokens but never a price. OpenCode returns a bare
    // number, so the currency stays ABSENT rather than being guessed as USD —
    // a fabricated unit is worse than a missing one in anything that sums it.
    const events = a.translateSdkEvent("s1", {
      type: "message.updated",
      properties: {
        info: {
          id: "m1",
          role: "assistant",
          tokens: { input: 100, output: 40 },
          cost: 0.0123,
          time: { created: 1, completed: 2 },
        },
      },
    } as never)
    const end = events.find((e) => e.type === "message_end") as {
      tokenUsage?: { providerCost?: { amount: number; currency?: string } }
    }
    expect(end?.tokenUsage?.providerCost).toEqual({ amount: 0.0123 })
    expect(end?.tokenUsage?.providerCost).not.toHaveProperty("currency")
  })

  it("reports no cost when the provider reported none", () => {
    const events = a.translateSdkEvent("s1", {
      type: "message.updated",
      properties: {
        info: {
          id: "m1",
          role: "assistant",
          tokens: { input: 10, output: 1 },
          time: { created: 1, completed: 2 },
        },
      },
    } as never)
    const end = events.find((e) => e.type === "message_end") as {
      tokenUsage?: { providerCost?: unknown }
    }
    expect(end?.tokenUsage).toBeDefined()
    expect(end?.tokenUsage).not.toHaveProperty("providerCost")
  })

  it("emits an error event when an assistant message carries a provider error", () => {
    const events = a.translateSdkEvent("s1", {
      type: "message.updated",
      properties: {
        info: {
          id: "m2",
          role: "assistant",
          error: { name: "ProviderAuthError", data: { message: "bad key" } },
          time: { created: 1 },
        },
      },
    } as never)
    expect(events.find((e) => e.type === "error")).toMatchObject({
      error: "bad key",
      recoverable: false,
    })
  })

  it("maps permission.replied to a permission_response that clears the request", () => {
    const events = a.translateSdkEvent("s1", {
      type: "permission.replied",
      properties: { sessionID: "s1", permissionID: "perm1", response: "reject" },
    } as never)
    expect(events[0]).toMatchObject({
      type: "permission_response",
      response: { requestId: "perm1", granted: false },
    })
  })

  it("carries callID and metadata on a permission.updated request", () => {
    const events = a.translateSdkEvent("s1", {
      type: "permission.updated",
      properties: {
        id: "perm2",
        sessionID: "s1",
        type: "bash",
        title: "Run",
        callID: "call-9",
        pattern: "rm *",
        metadata: { command: "rm -rf x" },
      },
    } as never)
    expect(events[0]).toMatchObject({
      type: "permission_request",
      request: { toolCallId: "call-9", metadata: { command: "rm -rf x" } },
    })
  })

  it("acknowledges message.part.removed without an unhandled fallthrough", () => {
    const events = a.translateSdkEvent("s1", {
      type: "message.part.removed",
      properties: { sessionID: "s1", messageID: "m1", partID: "p1" },
    } as never)
    expect(events).toEqual([])
  })
})

describe("OpenCodeClientAdapter — multimodal prompt parts", () => {
  it("maps image content to OpenCode file parts (url + inline base64)", async () => {
    const client = makeFakeClient()
    client.event.subscribe = jest
      .fn()
      .mockResolvedValue(streamOf([{ type: "session.idle", properties: { sessionID: "s1" } }]))
    mockCreateOpencodeClient.mockReturnValue(client)
    const a = new OpenCodeClientAdapter()
    await a.connect(buildConfig({ network: { endpoint: "http://x" } }))
    const session = await a.createSession()
    const msg = {
      id: "m",
      role: "user" as const,
      content: [
        { type: "text" as const, text: "look" },
        {
          type: "image" as const,
          source: { type: "url" as const, url: "https://x/i.png", mediaType: "image/png" },
        },
        {
          type: "image" as const,
          source: { type: "base64" as const, data: "QUJD", mediaType: "image/jpeg" },
        },
      ],
      timestamp: new Date(),
    }
    await collect(a.prompt(session.id, msg))
    const body = (client.session.promptAsync as jest.Mock).mock.calls[0][0].body
    const parts = body.parts as Array<{ type: string; mime?: string; url?: string }>
    expect(parts.some((p) => p.type === "file" && p.url === "https://x/i.png")).toBe(true)
    expect(
      parts.some((p) => p.type === "file" && p.url?.startsWith("data:image/jpeg;base64,QUJD"))
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Session management + delegating SDK operations
// ---------------------------------------------------------------------------

describe("OpenCodeClientAdapter — session + delegating ops", () => {
  let a: OpenCodeClientAdapter
  let client: ReturnType<typeof makeFakeClient>

  beforeEach(async () => {
    client = makeFakeClient()
    mockCreateOpencodeClient.mockReturnValue(client)
    a = new OpenCodeClientAdapter()
    await a.connect(buildConfig({ network: { endpoint: "http://x" } }))
  })

  it("creates, lists, forks, resumes, and closes sessions", async () => {
    const session = await a.createSession({ metadata: { title: "T" }, systemPrompt: "sys" })
    expect(session.id).toBe("s1")
    expect((await a.listSessions())[0].sessionId).toBe("s1")
    expect((await a.forkSession("s1")).id).toBe("s2")
    expect((await a.resumeSession("s1", { systemPrompt: "s" })).id).toBe("s1")
    await expect(a.closeSession("s1")).resolves.toBeUndefined()
  })

  it("maps OpenCode millisecond timestamps without scaling them again", async () => {
    const created = 1_750_000_000_000
    const updated = 1_750_000_060_000
    client.session.create.mockResolvedValueOnce({
      data: { id: "s-ms", title: "milliseconds", time: { created, updated } },
    })
    client.session.list.mockResolvedValueOnce({
      data: [{ id: "s-ms", title: "milliseconds", time: { created, updated } }],
    })

    const session = await a.createSession()
    const [listed] = await a.listSessions()

    expect(session.createdAt.toISOString()).toBe(new Date(created).toISOString())
    expect(session.lastActivityAt.toISOString()).toBe(new Date(updated).toISOString())
    expect(listed.createdAt).toBe(new Date(created).toISOString())
    expect(listed.updatedAt).toBe(new Date(updated).toISOString())
  })

  it("responds to permission requests via the SDK endpoint", async () => {
    await a.respondToPermission("s1", {
      requestId: "perm1",
      granted: true,
      rememberChoice: true,
    } as unknown as AcpPermissionResponse)
    expect(client.postSessionIdPermissionsPermissionId).toHaveBeenCalledWith(
      expect.objectContaining({ body: { response: "always" } })
    )
  })

  it("covers the file / vcs / project / mcp / lsp / pty / tui wrappers", async () => {
    await expect(a.readFile("/a")).resolves.toBeTruthy()
    await expect(a.listFiles("/")).resolves.toEqual([])
    await expect(a.getFileStatus()).resolves.toEqual([])
    await expect(a.findText("x")).resolves.toEqual([])
    await expect(a.findFiles("x", { type: "file" })).resolves.toEqual([])
    await expect(a.findSymbols("x")).resolves.toEqual([])
    await expect(a.getVcsInfo()).resolves.toBeTruthy()
    await expect(a.getProject()).resolves.toBeTruthy()
    await expect(a.listProjects()).resolves.toEqual([])
    await expect(a.getMcpStatus()).resolves.toBeTruthy()
    await expect(a.addMcpServer("m", {})).resolves.toBeUndefined()
    await expect(a.connectMcpServer("m")).resolves.toBeUndefined()
    await expect(a.disconnectMcpServer("m")).resolves.toBeUndefined()
    await expect(a.getLspStatus()).resolves.toBeTruthy()
    await expect(a.getFormatterStatus()).resolves.toBeTruthy()
    await expect(a.listPty()).resolves.toEqual([])
    await expect(a.createPty("sh")).resolves.toBeTruthy()
    await expect(a.getPty("pty1")).resolves.toBeTruthy()
    await expect(a.removePty("pty1")).resolves.toBe(true)
    await expect(a.tuiAppendPrompt("x")).resolves.toBe(true)
    await expect(a.tuiSubmitPrompt()).resolves.toBe(true)
    await expect(a.tuiClearPrompt()).resolves.toBe(true)
    await expect(a.tuiExecuteCommand("c")).resolves.toBe(true)
    await expect(a.tuiShowToast("hi")).resolves.toBe(true)
    await expect(a.tuiOpenHelp()).resolves.toBe(true)
    await expect(a.tuiOpenSessions()).resolves.toBe(true)
    await expect(a.tuiOpenThemes()).resolves.toBe(true)
    await expect(a.tuiOpenModels()).resolves.toBe(true)
  })

  it("covers session-level operations + logging + config accessors", async () => {
    await expect(a.executeCommand("s1", "/help")).resolves.toBeTruthy()
    await expect(a.executeShell("s1", "ls")).resolves.toBeTruthy()
    await expect(a.getSessionDiff("s1", "m1")).resolves.toEqual([])
    await expect(a.getSessionTodos("s1")).resolves.toEqual([])
    await expect(a.getSessionMessages("s1", 10)).resolves.toEqual([])
    await expect(a.getSessionMessage("s1", "m1")).resolves.toBeTruthy()
    await expect(a.updateSessionTitle("s1", "x")).resolves.toBeTruthy()
    await expect(a.shareSession("s1")).resolves.toBeTruthy()
    await expect(a.unshareSession("s1")).resolves.toBeTruthy()
    await expect(a.deleteSession("s1")).resolves.toBe(true)
    await expect(a.summarizeSession("s1", "p", "m")).resolves.toBe(true)
    await expect(a.revertMessage("s1", "m1")).resolves.toBeUndefined()
    await expect(a.unrevertMessages("s1")).resolves.toBeUndefined()
    await expect(a.initSession("s1", "m1", "p", "m")).resolves.toBe(true)
    await expect(a.getChildSessions("s1")).resolves.toEqual([])
    await expect(a.getSessionStatus()).resolves.toBeTruthy()
    await expect(a.listToolIds()).resolves.toEqual(["bash"])
    await expect(a.listToolsForModel("p", "m")).resolves.toBeTruthy()
    await expect(a.getProviderAuthMethods()).resolves.toBeTruthy()
    await expect(a.authorizeProviderOAuth("p")).resolves.toBeTruthy()
    await expect(a.writeLog("svc", "info", "msg")).resolves.toBe(true)
    await expect(a.disposeInstance()).resolves.toBe(true)
    await expect(a.getConfig()).resolves.toBeTruthy()
    await expect(a.getConfigProviders()).resolves.toBeTruthy()
    await expect(a.getPath()).resolves.toBeTruthy()
    await expect(a.setSessionModel("s1", "anthropic/claude")).resolves.toBeUndefined()
    expect(a.getSdkClient()).toBe(client)
  })

  it("compacts with the session model before an advertised command", async () => {
    const client = makeFakeClient()
    client.provider.list.mockResolvedValue({
      data: {
        all: [{ id: "anthropic", models: { claude: { id: "claude", name: "Claude" } } }],
        default: { anthropic: "claude" },
        connected: ["anthropic"],
      },
    })
    client.command.list.mockResolvedValue({
      data: [{ name: "/compact", description: "Compact", args: { focus: "string" } }],
    })
    mockCreateOpencodeClient.mockReturnValue(client)
    const adapter = new OpenCodeClientAdapter()
    await adapter.connect(buildConfig())
    const session = await adapter.createSession()

    await expect(adapter.getCompactionCapability(session.id)).resolves.toEqual({
      status: "supported",
      routes: [
        { kind: "native", supportsFocus: false },
        { kind: "command", command: "compact", supportsFocus: true },
      ],
    })
    await adapter.compactSession(session.id)
    expect(client.session.summarize).toHaveBeenCalledWith({
      path: { id: session.id },
      body: { providerID: "anthropic", modelID: "claude" },
    })
    expect(client.session.command).not.toHaveBeenCalled()
  })

  it("uses a parameterized command for focus and only falls back on explicit unsupported", async () => {
    const client = makeFakeClient()
    client.provider.list.mockResolvedValue({
      data: {
        all: [{ id: "anthropic", models: { claude: { id: "claude" } } }],
        default: { anthropic: "claude" },
        connected: ["anthropic"],
      },
    })
    client.command.list.mockResolvedValue({
      data: [{ name: "compress", args: { focus: "string" } }],
    })
    mockCreateOpencodeClient.mockReturnValue(client)
    const adapter = new OpenCodeClientAdapter()
    await adapter.connect(buildConfig())
    const session = await adapter.createSession()

    await adapter.compactSession(session.id, { focus: "Keep API decisions" })
    expect(client.session.command).toHaveBeenCalledWith({
      path: { id: session.id },
      body: { command: "compress", arguments: "Keep API decisions" },
    })
    expect(client.session.summarize).not.toHaveBeenCalled()

    client.session.command.mockClear()
    client.session.summarize.mockRejectedValueOnce(new Error("Authentication failed"))
    await expect(adapter.compactSession(session.id)).rejects.toThrow("Authentication failed")
    expect(client.session.command).not.toHaveBeenCalled()

    client.session.summarize.mockResolvedValueOnce({
      error: { message: "Provider model not found", code: "MODEL_NOT_FOUND" },
      response: { status: 404 },
    } as never)
    await expect(adapter.compactSession(session.id)).rejects.toThrow("Provider model not found")
    expect(client.session.command).not.toHaveBeenCalled()

    client.session.summarize.mockResolvedValueOnce({
      error: { message: "Method not found", code: "METHOD_NOT_FOUND" },
      response: { status: 404 },
    } as never)
    await adapter.compactSession(session.id)
    expect(client.session.command).toHaveBeenCalledWith({
      path: { id: session.id },
      body: { command: "compress", arguments: "" },
    })
  })

  it("reports compaction unavailable when neither model nor command exists", async () => {
    const client = makeFakeClient()
    mockCreateOpencodeClient.mockReturnValue(client)
    const adapter = new OpenCodeClientAdapter()
    await adapter.connect(buildConfig())
    const session = await adapter.createSession()

    await expect(adapter.getCompactionCapability(session.id)).resolves.toEqual({
      status: "unsupported",
      routes: [],
      reason: "model_unavailable",
    })
    await expect(adapter.compactSession(session.id)).rejects.toThrow(
      "OpenCode compaction requires a session model"
    )
  })

  it("authenticate sets an API key via the auth endpoint", async () => {
    await a.authenticate("anthropic", { key: "sk-1" })
    expect(client.auth.set).toHaveBeenCalledWith(
      expect.objectContaining({ path: { id: "anthropic" }, body: { type: "api", key: "sk-1" } })
    )
  })
})

// ---------------------------------------------------------------------------
// Capability discovery + config options + model resolution + sync fallback
// ---------------------------------------------------------------------------

describe("OpenCodeClientAdapter — capabilities, config, fallback", () => {
  function richClient() {
    const ok = (data: unknown) => jest.fn().mockResolvedValue({ data })
    const client = makeFakeClient()
    client.provider.list = ok({
      all: [
        {
          id: "anthropic",
          name: "Anthropic",
          models: { "claude-x": { id: "claude-x", name: "Claude X" } },
        },
      ],
      default: { anthropic: "claude-x" },
      connected: ["anthropic"],
    })
    client.app.agents = ok([{ id: "build", name: "Build", description: "Builder" }])
    client.command.list = ok([{ name: "/test", description: "run tests" }])
    client.tool.list = ok([{ name: "bash", description: "run", inputSchema: {} }])
    return client
  }

  it("discovers providers/agents/commands/tools and builds config options", async () => {
    const client = richClient()
    mockCreateOpencodeClient.mockReturnValue(client)
    const a = new OpenCodeClientAdapter()
    await a.connect(buildConfig({ network: { endpoint: "http://x" } }))

    expect(a.getAvailableAgents()).toHaveLength(1)
    expect(a.getAvailableCommands()[0].name).toBe("/test")
    expect(a.getProviders()?.connected).toEqual(["anthropic"])
    expect(a.getAuthMethods()[0].id).toBe("anthropic")
    expect(client.tool.list).toHaveBeenCalled()

    const session = await a.createSession()
    const options = a.getConfigOptions(session.id) ?? []
    expect(options.some((o) => o.category === "model")).toBe(true)
    expect(options.some((o) => o.category === "_agent")).toBe(true)
    expect(a.getSessionModels(session.id)).toBeDefined()

    // Model config is session-scoped and must not mutate the server default.
    client.config.update.mockClear()
    await a.setConfigOption(session.id, "model", "anthropic/claude-x")
    expect(client.config.update).not.toHaveBeenCalled()
    expect(a.getSessionModels(session.id)?.currentModelId).toBe("anthropic/claude-x")
    // No "mode" category exists → setSessionMode is a no-op.
    await expect(a.setSessionMode(session.id, "default")).resolves.toBeUndefined()
  })

  it("passes a context model override through to promptAsync", async () => {
    const client = makeFakeClient()
    client.event.subscribe = jest.fn().mockResolvedValue(streamOf([]))
    mockCreateOpencodeClient.mockReturnValue(client)
    const a = new OpenCodeClientAdapter()
    await a.connect(buildConfig({ network: { endpoint: "http://x" } }))
    const session = await a.createSession({ systemPrompt: "be brief" })
    await collect(
      a.prompt(session.id, textMessage("hi"), {
        context: { custom: { model: { providerID: "p", modelID: "m" } } },
      } as never)
    )
    expect(client.session.promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          model: { providerID: "p", modelID: "m" },
          system: "be brief",
        }),
      })
    )
  })

  it("resolves a model from metadata (provider/model string)", async () => {
    const client = makeFakeClient()
    client.event.subscribe = jest.fn().mockResolvedValue(streamOf([]))
    mockCreateOpencodeClient.mockReturnValue(client)
    const a = new OpenCodeClientAdapter()
    await a.connect(
      buildConfig({ network: { endpoint: "http://x" }, metadata: { model: "anthropic/claude-x" } })
    )
    const session = await a.createSession()
    await collect(a.prompt(session.id, textMessage("hi")))
    expect(client.session.promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ model: { providerID: "anthropic", modelID: "claude-x" } }),
      })
    )
  })

  it("keeps setSessionModel scoped to the session instead of mutating global config", async () => {
    const client = richClient()
    client.event.subscribe = jest.fn().mockResolvedValue(streamOf([]))
    mockCreateOpencodeClient.mockReturnValue(client)
    const a = new OpenCodeClientAdapter()
    await a.connect(buildConfig({ network: { endpoint: "http://x" } }))
    const session = await a.createSession()
    client.config.update.mockClear()

    await a.setSessionModel(session.id, "anthropic/claude-x")
    await collect(a.prompt(session.id, textMessage("hi")))

    expect(client.config.update).not.toHaveBeenCalled()
    expect(a.getSessionModels(session.id)?.currentModelId).toBe("anthropic/claude-x")
    expect(client.session.promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          model: { providerID: "anthropic", modelID: "claude-x" },
        }),
      })
    )
  })

  it("falls back to a synchronous prompt and emits events from the message", async () => {
    const client = makeFakeClient()
    client.event.subscribe = jest.fn().mockResolvedValue(streamOf([]))
    client.session.promptAsync = jest.fn().mockRejectedValue(new Error("async not supported"))
    client.session.prompt = jest.fn().mockResolvedValue({
      data: {
        info: { id: "m1" },
        parts: [
          { type: "text", text: "answer" },
          { type: "reasoning", text: "thinking" },
          { type: "tool", callID: "c1", tool: "bash", state: { status: "completed", output: "o" } },
          { type: "tool", callID: "c2", tool: "ls", state: { status: "error", error: "boom" } },
        ],
      },
    })
    mockCreateOpencodeClient.mockReturnValue(client)
    const a = new OpenCodeClientAdapter()
    await a.connect(buildConfig({ network: { endpoint: "http://x" } }))
    const session = await a.createSession()
    const out = await collect(a.prompt(session.id, textMessage("hi")))
    const types = out.map((e) => e.type)
    expect(types).toEqual(
      expect.arrayContaining([
        "message_start",
        "message_delta",
        "thinking",
        "tool_use_start",
        "tool_result",
        "message_end",
        "done",
      ])
    )
    expect(client.session.prompt).toHaveBeenCalled()
  })

  it("does not resubmit an accepted async prompt when the event stream fails", async () => {
    const client = makeFakeClient()
    client.event.subscribe = jest.fn().mockResolvedValue(failingStream(new Error("stream lost")))
    mockCreateOpencodeClient.mockReturnValue(client)
    const a = new OpenCodeClientAdapter()
    await a.connect(buildConfig({ network: { endpoint: "http://x" } }))
    const session = await a.createSession()

    const out = await collect(a.prompt(session.id, textMessage("hi")))

    expect(client.session.promptAsync).toHaveBeenCalledTimes(1)
    expect(client.session.prompt).not.toHaveBeenCalled()
    expect(out).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "error", error: "stream lost" }),
        expect.objectContaining({ type: "done", success: false }),
      ])
    )
  })

  it("blocks PII-bearing prompts before either OpenCode prompt endpoint is called", async () => {
    const client = makeFakeClient()
    mockCreateOpencodeClient.mockReturnValue(client)
    const a = new OpenCodeClientAdapter()
    await a.connect(buildConfig({ network: { endpoint: "http://x" } }))
    const session = await a.createSession()

    await expect(
      collect(a.prompt(session.id, textMessage("email alice@example.com")))
    ).rejects.toThrow(/PII gate/i)
    expect(client.session.promptAsync).not.toHaveBeenCalled()
    expect(client.session.prompt).not.toHaveBeenCalled()
  })

  it.each([
    { encoding: "utf-8" as const, content: "alice@example.com" },
    {
      encoding: "base64" as const,
      content: Buffer.from("alice@example.com", "utf-8").toString("base64"),
    },
  ])(
    "blocks PII in $encoding text-file attachments before sending",
    async ({ encoding, content }) => {
      const client = makeFakeClient()
      mockCreateOpencodeClient.mockReturnValue(client)
      const a = new OpenCodeClientAdapter()
      await a.connect(buildConfig({ network: { endpoint: "http://x" } }))
      const session = await a.createSession()
      const message = textMessage("inspect the attachment")
      message.content.push({
        type: "file",
        path: "/tmp/contacts.txt",
        mimeType: "text/plain",
        encoding,
        content,
      })

      await expect(collect(a.prompt(session.id, message))).rejects.toThrow(/PII gate/i)
      expect(client.session.promptAsync).not.toHaveBeenCalled()
      expect(client.session.prompt).not.toHaveBeenCalled()
    }
  )

  it("emits an error event when both async and sync prompts fail", async () => {
    const client = makeFakeClient()
    client.event.subscribe = jest.fn().mockResolvedValue(streamOf([]))
    client.session.promptAsync = jest.fn().mockRejectedValue(new Error("async fail"))
    client.session.prompt = jest.fn().mockRejectedValue(new Error("sync fail"))
    mockCreateOpencodeClient.mockReturnValue(client)
    const a = new OpenCodeClientAdapter()
    await a.connect(buildConfig({ network: { endpoint: "http://x" } }))
    const session = await a.createSession()
    const out = await collect(a.prompt(session.id, textMessage("hi")))
    const err = out.find((e) => e.type === "error") as { error: string }
    expect(err.error).toContain("sync fail")
  })

  it("translateSdkEvent maps session.error to a recoverable error", () => {
    const a = new OpenCodeClientAdapter()
    const events = a.translateSdkEvent("s1", {
      type: "session.error",
      properties: { sessionID: "s1", error: { data: { message: "boom" } } },
    } as never)
    expect(events[0]).toMatchObject({ type: "error", recoverable: true, error: "boom" })
  })

  it("translateSdkEvent covers text-without-delta, pending tool, and unknown events", () => {
    const a = new OpenCodeClientAdapter()
    // Full text (no incremental delta) falls back to part.text.
    expect(
      a.translateSdkEvent("s1", {
        type: "message.part.updated",
        properties: { part: { type: "text", sessionID: "s1", text: "full" } },
      } as never)[0]
    ).toMatchObject({ type: "message_delta", delta: { text: "full" } })
    // Pending tool with no callID falls back to the part id.
    expect(
      a.translateSdkEvent("s1", {
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            id: "p1",
            sessionID: "s1",
            tool: "read",
            state: { status: "running", input: { filePath: "a.ts" }, title: "Reading a.ts" },
          },
        },
      } as never)[0]
    ).toMatchObject({
      type: "tool_use_start",
      toolUseId: "p1",
      toolName: "read",
      title: "Reading a.ts",
    })

    expect(
      a.translateSdkEvent("s1", {
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            id: "p1",
            sessionID: "s1",
            tool: "read",
            state: {
              status: "completed",
              input: { filePath: "a.ts" },
              output: "contents",
              title: "Read a.ts",
            },
          },
        },
      } as never)[0]
    ).toMatchObject({ type: "tool_result", toolUseId: "p1", title: "Read a.ts" })
    // Lifecycle / unknown events translate to nothing.
    expect(
      a.translateSdkEvent("s1", { type: "server.connected", properties: {} } as never)
    ).toEqual([])
    expect(
      a.translateSdkEvent("s1", { type: "installation.updated", properties: {} } as never)
    ).toEqual([])
  })

  it("unwrap throws a descriptive error when the SDK returns { error }", async () => {
    const client = makeFakeClient()
    client.vcs.get = jest.fn().mockResolvedValue({ error: { message: "vcs blew up" } })
    mockCreateOpencodeClient.mockReturnValue(client)
    const a = new OpenCodeClientAdapter()
    await a.connect(buildConfig({ network: { endpoint: "http://x" } }))
    await expect(a.getVcsInfo()).rejects.toThrow(/vcs blew up/)
  })

  it("waitForReady surfaces an SDK { error } during connect", async () => {
    const client = makeFakeClient({
      config: { get: jest.fn().mockResolvedValue({ error: { message: "not ready" } }) },
    })
    mockCreateOpencodeClient.mockReturnValue(client)
    const a = new OpenCodeClientAdapter()
    await expect(a.connect(buildConfig({ network: { endpoint: "http://x" } }))).rejects.toThrow(
      /not ready/
    )
  })
})
