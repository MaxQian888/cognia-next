// Mock heavyweight adapter modules so requiring manager.ts does not pull in
// the real ACP/OpenCode adapters.
let mockProcessExitCb: ((event: { agentId: string; code: number }) => void) | undefined
const mockGatewayMint = jest.fn()
const mockGatewayRevoke = jest.fn().mockResolvedValue(true)
jest.mock("./runtimes/dsh/dsh-managed-launch", () => ({
  prepareDshManagedLaunch: async (config: unknown) => config,
}))
jest.mock("@/lib/gateway/mint-session-ticket", () => ({
  prepareExternalAgentGatewayRoute: (...args: unknown[]) => mockGatewayMint(...args),
}))
jest.mock("@/lib/tauri/gateway", () => ({
  gatewayRevokeRouteTicket: (...args: unknown[]) => mockGatewayRevoke(...args),
}))
jest.mock("@/stores/settings", () => ({
  useSettingsStore: {
    getState: () => ({ settings: { providerSettings: {}, customProviders: [] } }),
  },
}))
const appendCanonicalEnvelopesMock = jest.fn(
  async (_runId: string, _envelopes: Array<{ event: { kind: string } }>) => 1
)

jest.mock("@/lib/ai/agent/recovery/canonical-log", () => ({
  appendCanonicalEnvelopes: (...args: unknown[]) =>
    appendCanonicalEnvelopesMock(...(args as [string, Array<{ event: { kind: string } }>])),
}))

jest.mock("./runtimes/acp/acp-client", () => ({
  AcpClientAdapter: class {
    readonly protocol = "acp"
  },
}))
jest.mock("./runtimes/opencode/opencode-client", () => ({
  OpenCodeClientAdapter: class {
    readonly protocol = "opencode"
  },
}))
jest.mock("./runtimes/opencode/opencode-v2-client", () => ({
  OpenCodeV2ClientAdapter: class {
    readonly protocol = "opencode-v2"
  },
}))
jest.mock("@/lib/native/external-agent", () => ({
  checkExternalAgentCommandExists: jest.fn().mockResolvedValue(true),
  onExternalAgentExit: jest.fn(async (cb: (event: { agentId: string; code: number }) => void) => {
    mockProcessExitCb = cb
    return () => {
      mockProcessExitCb = undefined
    }
  }),
  acpTerminalCreate: jest.fn(),
  acpTerminalKill: jest.fn(),
  acpTerminalOutput: jest.fn(),
  acpTerminalRelease: jest.fn(),
  acpTerminalWaitForExit: jest.fn(),
}))
jest.mock("./config/installed-runtimes", () => ({
  detectInstalledRuntimes: jest.fn(),
}))
jest.mock("@/lib/utils", () => ({
  ...jest.requireActual("@/lib/utils"),
  isTauri: jest.fn(() => true),
}))
jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(() => true),
}))

import {
  ExternalAgentManager,
  createConfiguredProtocolAdapter,
  getExternalAgentManager,
  checkExternalAgentDelegation,
  executeOnExternalAgent,
  shouldReconcileExitToDisconnected,
  type ExternalAgentLifecycleEvent,
} from "./manager"
import { protocolAdapterRegistry, type SessionCreateOptions } from "./protocol-adapter"
import { PiRpcClientAdapter } from "./runtimes/pi/pi-rpc-client"
import { AcpClientAdapter } from "./runtimes/acp/acp-client"
import { DevinAcpAdapter } from "./runtimes/acp/devin-acp-adapter"
import {
  __setModelSurfaceDepsForTests,
  cachedAgentModelSurface,
  forgetAgentModelSurface,
  loadAgentModelSurface,
} from "./capability/model-surface-cache"
import { checkExternalAgentCommandExists } from "@/lib/native/external-agent"
import { detectInstalledRuntimes } from "./config/installed-runtimes"
import { __setProcessPlaneDepsForTests } from "./capability/process-plane"
import { EMPTY_THINKING_SURFACE } from "./session/session-models"
import { parseGatewaySessionId } from "./config/gateway-task"
import {
  __resetRunEnvironmentForTests,
  recordRunEnvironmentOutcome,
} from "@/lib/sandbox/run-environment"
import type {
  ExternalAgentConfig,
  ExternalAgentEvent,
  ExternalAgentSession,
  ExternalAgentMessage,
  ExternalAgentResult,
  ExternalAgentExecutionOptions,
  AcpPermissionResponse,
} from "@/types/agent/external-agent"

class MockAdapter {
  readonly protocol = "mock"
  protected _connectionStatus: "connected" | "disconnected" | "connecting" | "error" =
    "disconnected"
  capabilities = { mock: true } as never
  tools = [
    { id: "t1", name: "echo", description: "echo input", parameters: { type: "object" } },
  ] as never
  sessions = new Map<string, ExternalAgentSession>()
  events: ExternalAgentEvent[] = []
  executeImpl: jest.Mock<Promise<ExternalAgentResult>, []> | null = null
  connectImpl: jest.Mock<Promise<void>, []> = jest.fn(async () => {
    this._connectionStatus = "connected"
  })
  failConnect = false
  cancelImpl: jest.Mock<Promise<void>, [string]> = jest.fn(async (_id: string) => {})
  listSessionsImpl?: jest.Mock<Promise<unknown>, [unknown?]>
  forkSessionImpl?: jest.Mock<Promise<ExternalAgentSession>, [string, SessionCreateOptions?]>
  resumeSessionImpl?: jest.Mock<Promise<ExternalAgentSession>, [string]>
  setSessionModeImpl: jest.Mock = jest.fn(async () => {})
  setSessionModelImpl: jest.Mock = jest.fn(async () => {})
  setConfigOptionImpl: jest.Mock = jest.fn(async () => [])
  getSessionModelsImpl?: jest.Mock<unknown, [string]>
  getConfigOptionsImpl?: jest.Mock<unknown, [string]>
  authMethods?: { id: string; name: string }[]
  authRequired = false
  acpInit?: () => Record<string, unknown>
  extensionSupport?: () => Record<string, unknown>
  logoutImpl?: jest.Mock<Promise<void>, []>
  deleteSessionImpl?: jest.Mock<Promise<void>, [string]>
  respondToElicitationImpl: jest.Mock<Promise<void>, [unknown]> = jest.fn(
    async (_response: unknown) => {}
  )
  cancelRequestImpl: jest.Mock<Promise<void>, [number | string]> = jest.fn(
    async (_requestId: number | string) => {}
  )

  get connectionStatus() {
    return this._connectionStatus
  }
  isConnected() {
    return this._connectionStatus === "connected"
  }
  async connect(_config: ExternalAgentConfig) {
    if (this.failConnect) {
      this._connectionStatus = "error"
      throw new Error("connection refused")
    }
    await this.connectImpl()
  }
  async disconnect() {
    this._connectionStatus = "disconnected"
  }
  async healthCheck() {
    return this._connectionStatus === "connected"
  }
  /** The SessionCreateOptions of the most recent createSession call. */
  lastSessionOptions?: Record<string, unknown>
  async createSession(opts?: unknown): Promise<ExternalAgentSession> {
    const id = `s_${this.sessions.size + 1}`
    this.lastSessionOptions = opts as Record<string, unknown> | undefined
    const session: ExternalAgentSession = {
      id,
      agentId: "mock-agent",
      status: "active",
      createdAt: new Date(),
      lastActivityAt: new Date(),
      messages: [],
      permissionMode: "default",
      // Mirror the real adapters: a session carries the metadata BAG it was
      // created with (see the Codex client's buildSessionMetadata), not the
      // whole SessionCreateOptions. Recording the options as metadata made
      // `session.metadata.selectedModel` permanently undefined, which would
      // hide a model that failed to reach the session. Options are captured
      // separately above.
      metadata: (opts as { metadata?: Record<string, unknown> } | undefined)?.metadata,
    }
    this.sessions.set(id, session)
    return session
  }
  async closeSession(id: string) {
    this.sessions.delete(id)
  }
  get logout() {
    return this.logoutImpl
  }
  get deleteSession() {
    return this.deleteSessionImpl
  }
  getSession(id: string) {
    return this.sessions.get(id)
  }
  getSessions() {
    return Array.from(this.sessions.values())
  }
  forgetSessions() {
    this.sessions.clear()
  }
  async *prompt(
    _sessionId: string,
    _message: ExternalAgentMessage,
    _options?: ExternalAgentExecutionOptions
  ): AsyncIterable<ExternalAgentEvent> {
    for (const event of this.events) {
      yield event
    }
  }
  async execute(
    sessionId: string,
    _message: ExternalAgentMessage,
    _options?: ExternalAgentExecutionOptions
  ): Promise<ExternalAgentResult> {
    if (this.executeImpl) return this.executeImpl()
    return {
      success: true,
      sessionId,
      finalResponse: "ok",
      messages: [],
      steps: [],
      toolCalls: [],
      duration: 1,
      tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    }
  }
  async respondToPermission(_sid: string, _r: AcpPermissionResponse) {}
  async respondToElicitation(response: unknown) {
    return this.respondToElicitationImpl(response)
  }
  async cancelRequest(requestId: number | string) {
    return this.cancelRequestImpl(requestId)
  }
  async cancel(sid: string) {
    return this.cancelImpl(sid)
  }
  setSessionMode(_sid: string, _mode: unknown) {
    return this.setSessionModeImpl(_sid, _mode)
  }
  setSessionModel(_sid: string, _mid: string) {
    return this.setSessionModelImpl(_sid, _mid)
  }
  setConfigOption(_sid: string, _id: string, _v: string | boolean) {
    return this.setConfigOptionImpl(_sid, _id, _v)
  }
  getConfigOptions(sid: string) {
    const result = this.getConfigOptionsImpl?.(sid) as
      { status: "ok"; data: unknown } | { status: "unsupported" } | unknown[] | undefined
    if (Array.isArray(result)) return result
    return result && typeof result === "object" && "status" in result && result.status === "ok"
      ? result.data
      : undefined
  }
  getSessionModels(sid: string) {
    const result = this.getSessionModelsImpl?.(sid) as
      { status: "ok"; data: unknown } | { status: "unsupported" } | unknown | undefined
    if (!result || typeof result !== "object" || !("status" in result)) return result
    return result.status === "ok" && "data" in result ? result.data : undefined
  }
  listSessions(options?: unknown) {
    if (!this.listSessionsImpl) return undefined
    return this.listSessionsImpl(options)
  }
  forkSession(sid: string, options?: SessionCreateOptions) {
    if (!this.forkSessionImpl) return undefined
    return this.forkSessionImpl(sid, options)
  }
  resumeSession(sid: string, _opts?: unknown) {
    if (!this.resumeSessionImpl) return undefined
    return this.resumeSessionImpl(sid)
  }
  getAuthMethods() {
    return this.authMethods ?? []
  }
  isAuthenticationRequired() {
    return this.authRequired
  }
  async authenticate() {}
  getTerminalAuthState() {
    return { methodId: "terminal", status: "running" as const }
  }
  async cancelTerminalAuthentication() {}
  getAcpInitializationMetadata() {
    return this.acpInit?.() ?? {}
  }
  getSessionExtensionSupport() {
    return (
      this.extensionSupport?.() ?? {
        "session/list": { state: "unknown" },
        "session/fork": { state: "unknown" },
        "session/resume": { state: "unknown" },
      }
    )
  }
  clearSessionExtensionSupportCache() {}
}

let currentMock: MockAdapter

function buildBaseConfig(overrides: Partial<ExternalAgentConfig> = {}): ExternalAgentConfig {
  return {
    id: "agent-1",
    name: "Test",
    protocol: "acp",
    transport: "http",
    enabled: true,
    defaultPermissionMode: "default",
    timeout: 100,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    retryConfig: {
      maxRetries: 0,
      retryDelay: 0,
      exponentialBackoff: false,
      maxRetryDelay: 0,
      retryOnErrors: [],
    },
    ...overrides,
  }
}

function freshManager(): ExternalAgentManager {
  const m = ExternalAgentManager.getInstance({ healthCheckInterval: 0 })
  // The manager constructor (called from getInstance) re-registers default
  // adapters on the global registry. Override the `acp` slot AFTER the
  // manager exists so our mock wins for subsequent addAgent calls.
  protocolAdapterRegistry.register("acp", () => currentMock as never)
  return m
}

beforeEach(() => {
  ExternalAgentManager.resetInstance()
  // The model/thinking surface cache is a module singleton and outlives the
  // manager, and the thinking-level path now reads it rather than paying for a
  // round trip per turn. Without this, one test's published ladder answers the
  // next test's question.
  forgetAgentModelSurface()
  mockProcessExitCb = undefined
  currentMock = new MockAdapter()
  mockGatewayMint.mockReset()
  mockGatewayRevoke.mockClear()
})

afterEach(async () => {
  await ExternalAgentManager.getInstance({ healthCheckInterval: 0 }).dispose()
  ExternalAgentManager.resetInstance()
})

describe("paired-web runtime readiness", () => {
  it("registers Pi from the Host inventory without calling Tauri invoke", async () => {
    const restorePlane = __setProcessPlaneDepsForTests({
      isRemoteHostActive: () => false,
      hasLocalProcessTable: () => false,
      getRuntimeSnapshot: () => ({
        target: { id: "headless-1", kind: "companion", hostKind: "cloud", platform: "web" },
        vaultState: "unlocked",
        connectionState: "online",
        host: {
          compatible: true,
          operations: ["spawn_external_agent", "external_agent_detect_runtimes"],
          grants: ["process.spawn"],
        },
      }),
    })
    const localCheck = jest.mocked(checkExternalAgentCommandExists)
    localCheck.mockRejectedValueOnce(
      new TypeError("Cannot read properties of undefined (reading 'invoke')")
    )
    jest.mocked(detectInstalledRuntimes).mockResolvedValueOnce([
      {
        runtimeId: "pi",
        command: "pi",
        resolution: "installed",
        executablePath: "/usr/local/bin/pi",
        version: "0.84.1",
        detail: null,
      },
    ])

    try {
      const manager = freshManager()
      await expect(
        manager.addAgent(
          buildBaseConfig({
            protocol: "pi-rpc",
            transport: "stdio",
            process: { command: "pi", args: ["--mode", "rpc"] },
            metadata: { preset: "pi-rpc" },
          }),
          { connect: false }
        )
      ).resolves.toMatchObject({ config: { protocol: "pi-rpc" } })
      expect(detectInstalledRuntimes).toHaveBeenCalledTimes(1)
      expect(localCheck).not.toHaveBeenCalled()
    } finally {
      restorePlane()
    }
  })
})

describe("the session a model surface should describe", () => {
  it("has nothing to describe before the agent opens one", () => {
    // Connected with no session is ordinary right after connecting. Answering
    // with some other agent's session, or with an id that does not exist, is
    // how a picker ends up writing a model onto the wrong conversation.
    const manager = freshManager()
    expect(manager.resolveLiveSessionId("nobody")).toBeNull()
    expect(manager.liveSessions("nobody")).toEqual([])
  })

  it("prefers the executing session over the most recent one", () => {
    const manager = freshManager()
    const sessions = [
      { id: "old", status: "idle" },
      { id: "running", status: "executing" },
      { id: "newest", status: "idle" },
    ]
    jest
      .spyOn(manager, "liveSessions")
      .mockReturnValue(sessions as unknown as ReturnType<typeof manager.liveSessions>)
    expect(manager.resolveLiveSessionId("a")).toBe("running")
  })

  it("falls back to the most recent when nothing is running", () => {
    const manager = freshManager()
    jest.spyOn(manager, "liveSessions").mockReturnValue([
      { id: "old", status: "idle" },
      { id: "newest", status: "idle" },
    ] as unknown as ReturnType<typeof manager.liveSessions>)
    expect(manager.resolveLiveSessionId("a")).toBe("newest")
  })

  it("resolves the session owned by one Cognia conversation, from the adapter", async () => {
    // The adapter is the store that includes a session it opened itself, on a
    // resume or a fork. Reading `instance.sessions` here disagreed with the
    // reuse lookup in `execute`, which already read the adapter, so one could
    // find the session while the other reported the agent had nothing open.
    const manager = freshManager()
    await manager.addAgent(buildBaseConfig(), { connect: false })
    currentMock.sessions.set("external-a", {
      id: "external-a",
      status: "idle",
      metadata: { cogniaSessionId: "chat-a" },
    } as never)
    currentMock.sessions.set("external-b", {
      id: "external-b",
      status: "executing",
      metadata: { cogniaSessionId: "chat-b" },
    } as never)
    expect(manager.resolveConversationSessionId("agent-1", "chat-a")).toBe("external-a")
    expect(manager.resolveConversationSessionId("agent-1", "chat-missing")).toBeNull()

    // A session the manager never put in `instance.sessions` still resolves.
    expect(manager.getAgent("agent-1")?.sessions.has("external-a")).toBe(false)
  })

  it("forgets sessions from a process that died, rather than reusing their ids", async () => {
    // The ids name state inside an agent process. After it exits, a reconnect
    // gets a fresh process, and handing one of the old ids back as a session
    // to resume prompts an id the new process has never heard of.
    const manager = freshManager()
    await manager.addAgent(buildBaseConfig(), { connect: false })
    currentMock.sessions.set("external-a", {
      id: "external-a",
      status: "idle",
      metadata: { cogniaSessionId: "chat-a" },
    } as never)
    currentMock.forgetSessions()
    expect(manager.resolveConversationSessionId("agent-1", "chat-a")).toBeNull()
    expect(manager.liveSessions("agent-1")).toEqual([])
  })
})

describe("fetchSessionModelSurface (the async twin the sync capabilities could not be)", () => {
  it("discovers session-scoped models before a prompt and closes the discovery session", async () => {
    const manager = freshManager()
    const config = buildBaseConfig()
    await manager.addAgent(config)
    currentMock.getSessionModelsImpl = jest.fn().mockReturnValue({
      currentModelId: "m1",
      availableModels: [{ modelId: "m1", name: "Model One" }],
    })
    const close = jest.spyOn(currentMock, "closeSession")
    const result = await manager.fetchAgentModelCatalog(config.id)
    expect(result).toMatchObject({
      status: "ok",
      data: {
        models: {
          choices: [{ modelId: "m1", name: "Model One" }],
          write: { kind: "session-seed" },
        },
      },
    })
    expect(close).toHaveBeenCalledTimes(1)
    expect(currentMock.sessions.size).toBe(0)
    expect(manager.getAgent(config.id)?.sessions.size).toBe(0)
  })

  it("cleans up discovery sessions when model discovery fails", async () => {
    const manager = freshManager()
    const config = buildBaseConfig()
    await manager.addAgent(config)
    currentMock.getSessionModelsImpl = jest.fn().mockRejectedValue(new Error("catalog offline"))
    const result = await manager.fetchAgentModelCatalog(config.id)
    expect(result.status).toBe("error")
    expect(currentMock.sessions.size).toBe(0)
  })
  it("reports an agent with neither model source as unsupported", async () => {
    const manager = freshManager()
    await expect(manager.fetchSessionModelSurface("missing", "s")).resolves.toEqual({
      status: "unsupported",
    })
  })

  describe("the Pi catalog reads what a Pi session will read", () => {
    /**
     * A real `PiRpcClientAdapter`, because the branch under test is selected
     * by `instanceof`. Everything that would touch a process is overridden.
     */
    class FakePi extends PiRpcClientAdapter {
      viaRpc: jest.Mock = jest.fn(async () => null)
      viaCli: jest.Mock = jest.fn(async () => ({ status: "unreadable" }))
      isConnected() {
        return true
      }
      listAgentModelsViaRpc() {
        return this.viaRpc() as ReturnType<PiRpcClientAdapter["listAgentModelsViaRpc"]>
      }
      listAgentModels() {
        return this.viaCli() as ReturnType<PiRpcClientAdapter["listAgentModels"]>
      }
    }

    let pi: FakePi

    async function piManager(): Promise<ExternalAgentManager> {
      const manager = freshManager()
      pi = new FakePi()
      protocolAdapterRegistry.register("pi-rpc", () => pi as never)
      await manager.addAgent(buildBaseConfig({ id: "pi-1", protocol: "pi-rpc" }), {
        connect: false,
      })
      return manager
    }

    afterEach(() => {
      protocolAdapterRegistry.unregister("pi-rpc")
    })

    it("projects the RPC answer, with Pi's own names and order", async () => {
      // The CLI table has no display-name column, so a catalog built from it
      // labels every row `provider/id` and sorts by provider. The session
      // labels them with Pi's `name` in Pi's order, and the picker therefore
      // changed shape the moment the first turn opened a session.
      const manager = await piManager()
      pi.viaRpc.mockResolvedValueOnce({
        currentModelId: "",
        availableModels: [
          { modelId: "zeta/z-model", name: "Zeta Model" },
          { modelId: "commandcode/claude-opus-5", name: "Claude Opus 5 (CC)" },
        ],
      })
      const result = await manager.fetchAgentModelCatalog("pi-1")
      expect(result).toMatchObject({
        status: "ok",
        data: {
          models: {
            choices: [
              { modelId: "zeta/z-model", name: "Zeta Model" },
              { modelId: "commandcode/claude-opus-5", name: "Claude Opus 5 (CC)" },
            ],
            // No session yet, so the picker highlights the conversation's own
            // stored choice rather than an agent default nobody picked.
            currentModelId: null,
            write: { kind: "session-seed" },
          },
        },
      })
      expect(pi.viaCli).not.toHaveBeenCalled()
    })

    it("falls back to the CLI listing when no discovery process can be started", async () => {
      // Same models, worse labels. Offering them beats telling the user this
      // agent has none, and it only happens in a state where a real session
      // would fare no better.
      const manager = await piManager()
      pi.viaRpc.mockResolvedValueOnce(null)
      pi.viaCli.mockResolvedValueOnce({
        status: "ok",
        models: [{ provider: "commandcode", id: "claude-opus-5" }],
      })
      await expect(manager.fetchAgentModelCatalog("pi-1")).resolves.toMatchObject({
        status: "ok",
        data: {
          models: {
            choices: [{ modelId: "commandcode/claude-opus-5", name: "commandcode/claude-opus-5" }],
            write: { kind: "session-seed" },
          },
        },
      })
    })

    it("reports an error rather than an empty catalog when both reads fail", async () => {
      const manager = await piManager()
      pi.viaRpc.mockResolvedValueOnce(null)
      pi.viaCli.mockResolvedValueOnce({ status: "unreadable" })
      await expect(manager.fetchAgentModelCatalog("pi-1")).resolves.toMatchObject({
        status: "error",
      })
    })
  })
})

describe("the cached model surface follows the writes that change it", () => {
  // The cache is a module singleton shared with the composer's chip and the
  // session panel's config rows. Both write paths land in this class, so both
  // have to drop it, or one surface keeps naming a model that is no longer set.
  let restoreSurfaceDeps: (() => void) | undefined

  beforeEach(() => {
    // Stubbed so a load does not re-enter the manager under test.
    restoreSurfaceDeps = __setModelSurfaceDepsForTests({
      fetchSurface: async () => ({
        status: "ok" as const,
        data: {
          models: { choices: [], currentModelId: "m", write: { kind: "none" as const } },
          thinking: EMPTY_THINKING_SURFACE,
        },
      }),
    })
  })

  afterEach(() => {
    restoreSurfaceDeps?.()
    restoreSurfaceDeps = undefined
    forgetAgentModelSurface()
  })

  it("drops the agent's surface when it disconnects", async () => {
    const manager = freshManager()
    await loadAgentModelSurface("gone", "s")
    expect(cachedAgentModelSurface("gone", "s")).not.toBeNull()

    await manager.disconnect("gone")

    // Not just stale: the next connect rebuilds the session with empty
    // metadata, so an entry answering from cache means nothing ever re-reads
    // `metadata.configOptions` and the panel renders no rows at all.
    expect(cachedAgentModelSurface("gone", "s")).toBeNull()
  })

  it("drops it when the settings panel writes a config option", async () => {
    const manager = freshManager()
    const setConfigOption = jest.fn(async () => [])
    ;(manager as unknown as { adapters: Map<string, unknown> }).adapters.set("cfg", {
      setConfigOption,
    })
    await loadAgentModelSurface("cfg", "s")
    expect(cachedAgentModelSurface("cfg", "s")).not.toBeNull()

    await manager.setConfigOption("cfg", "s", "model", "openai/gpt-5")

    expect(setConfigOption).toHaveBeenCalledWith("s", "model", "openai/gpt-5")
    expect(cachedAgentModelSurface("cfg", "s")).toBeNull()
  })
})

describe("shouldReconcileExitToDisconnected (process-exit → instance sync)", () => {
  it("reconciles only an established connection whose adapter is gone", () => {
    expect(shouldReconcileExitToDisconnected("connected", false)).toBe(true)
  })

  it("leaves a still-connected adapter (self-healed / reconnected) alone", () => {
    expect(shouldReconcileExitToDisconnected("connected", true)).toBe(false)
  })

  it("ignores in-flight connects and non-live states (no reconnect flicker)", () => {
    for (const status of ["connecting", "reconnecting", "disconnected", "error"] as const) {
      expect(shouldReconcileExitToDisconnected(status, false)).toBe(false)
      expect(shouldReconcileExitToDisconnected(status, true)).toBe(false)
    }
  })
})

describe("ExternalAgentManager — singleton + getInstance", () => {
  it("returns the same instance on repeated calls", () => {
    const a = freshManager()
    const b = ExternalAgentManager.getInstance()
    expect(a).toBe(b)
    expect(getExternalAgentManager()).toBe(a)
  })
})

describe("addAgent / removeAgent / connect", () => {
  describe("Codex connection storm protection", () => {
    it.each([
      "401 Unauthorized: connection rejected",
      "403 Forbidden: network access rejected",
      "429 Too many requests",
    ])("does not retry a native connection rejected with %s", async (message) => {
      const manager = freshManager()
      protocolAdapterRegistry.register("codex-app-server", () => currentMock as never)
      await manager.addAgent(
        buildBaseConfig({
          protocol: "codex-app-server",
          retryConfig: {
            maxRetries: 3,
            retryDelay: 0,
            exponentialBackoff: false,
            maxRetryDelay: 0,
            retryOnErrors: ["connection", "requests"],
          },
        }),
        { connect: false }
      )
      currentMock.connectImpl.mockRejectedValue(new Error(message))
      await expect(manager.connect("agent-1")).rejects.toThrow(message)
      expect(currentMock.connectImpl).toHaveBeenCalledTimes(1)
    })

    it("shares simultaneous native connection requests", async () => {
      const manager = freshManager()
      protocolAdapterRegistry.register("codex-app-server", () => currentMock as never)
      await manager.addAgent(buildBaseConfig({ protocol: "codex-app-server" }), { connect: false })
      let release!: () => void
      const pending = new Promise<void>((resolve) => {
        release = resolve
      })
      currentMock.connectImpl.mockImplementation(async () => {
        await pending
      })
      const requests = [
        manager.connect("agent-1"),
        manager.connect("agent-1"),
        manager.connect("agent-1"),
      ]
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      release()
      await Promise.all(requests)
      expect(currentMock.connectImpl).toHaveBeenCalledTimes(1)
    })

    it("finishes an in-flight native connect before disconnecting it", async () => {
      const manager = freshManager()
      protocolAdapterRegistry.register("codex-app-server", () => currentMock as never)
      await manager.addAgent(buildBaseConfig({ protocol: "codex-app-server" }), { connect: false })
      let release!: () => void
      const pending = new Promise<void>((resolve) => {
        release = resolve
      })
      currentMock.connectImpl.mockImplementation(async () => {
        await pending
      })
      const disconnect = jest.spyOn(currentMock, "disconnect")
      const connecting = manager.connect("agent-1")
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      const stopping = manager.disconnect("agent-1")
      const stoppedEarly = disconnect.mock.calls.length
      release()
      await Promise.all([connecting, stopping])
      expect(stoppedEarly).toBe(0)
      expect(disconnect).toHaveBeenCalledTimes(1)
      expect(manager.getAgent("agent-1")?.connectionStatus).toBe("disconnected")
    })

    it("waits for native teardown before a fresh connection", async () => {
      const manager = freshManager()
      protocolAdapterRegistry.register("codex-app-server", () => currentMock as never)
      await manager.addAgent(buildBaseConfig({ protocol: "codex-app-server" }))
      let release!: () => void
      const pending = new Promise<void>((resolve) => {
        release = resolve
      })
      const originalDisconnect = currentMock.disconnect.bind(currentMock)
      jest.spyOn(currentMock, "disconnect").mockImplementationOnce(async () => {
        await pending
        await originalDisconnect()
      })
      const stopping = manager.disconnect("agent-1")
      const connecting = manager.connect("agent-1")
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      const connectsBeforeTeardown = currentMock.connectImpl.mock.calls.length
      release()
      await Promise.all([stopping, connecting])
      expect(connectsBeforeTeardown).toBe(1)
      expect(currentMock.connectImpl).toHaveBeenCalledTimes(2)
      expect(manager.getAgent("agent-1")?.connectionStatus).toBe("connected")
    })

    it("does not launch another retry when disconnect was requested during a handshake", async () => {
      const manager = freshManager()
      protocolAdapterRegistry.register("codex-app-server", () => currentMock as never)
      await manager.addAgent(
        buildBaseConfig({
          protocol: "codex-app-server",
          retryConfig: {
            maxRetries: 3,
            retryDelay: 0,
            exponentialBackoff: false,
            maxRetryDelay: 0,
            retryOnErrors: [],
          },
        }),
        { connect: false }
      )
      let fail!: (error: Error) => void
      const pending = new Promise<void>((_resolve, reject) => {
        fail = reject
      })
      currentMock.connectImpl.mockImplementation(() => pending)
      const connecting = manager.connect("agent-1").catch(() => undefined)
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      const stopping = manager.disconnect("agent-1")
      fail(new Error("connection refused"))
      await Promise.all([connecting, stopping])
      expect(currentMock.connectImpl).toHaveBeenCalledTimes(1)
      expect(manager.getAgent("agent-1")?.connectionStatus).toBe("disconnected")
    })

    it("lets the native handshake own its timeout instead of starting an overlapping retry", async () => {
      const manager = freshManager()
      protocolAdapterRegistry.register("codex-app-server", () => currentMock as never)
      await manager.addAgent(buildBaseConfig({ protocol: "codex-app-server", timeout: 5 }), {
        connect: false,
      })
      let release!: () => void
      const pending = new Promise<void>((resolve) => {
        release = resolve
      })
      currentMock.connectImpl.mockImplementation(() => pending)
      let settled = false
      const connecting = manager.connect("agent-1").then(
        () => {
          settled = true
          return "connected"
        },
        () => {
          settled = true
          return "failed"
        }
      )
      await new Promise<void>((resolve) => setTimeout(resolve, 15))
      const settledBeforeNative = settled
      release()
      expect(await connecting).toBe("connected")
      expect(settledBeforeNative).toBe(false)
      expect(currentMock.connectImpl).toHaveBeenCalledTimes(1)
    })

    it("waits for native connection ownership before removing the agent", async () => {
      const manager = freshManager()
      protocolAdapterRegistry.register("codex-app-server", () => currentMock as never)
      await manager.addAgent(buildBaseConfig({ protocol: "codex-app-server" }), { connect: false })
      let release!: () => void
      const pending = new Promise<void>((resolve) => {
        release = resolve
      })
      currentMock.connectImpl.mockImplementation(() => pending)
      const disconnect = jest.spyOn(currentMock, "disconnect")
      const connecting = manager.connect("agent-1")
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      const removing = manager.removeAgent("agent-1")
      const stoppedEarly = disconnect.mock.calls.length
      release()
      await Promise.all([connecting, removing])
      expect(stoppedEarly).toBe(0)
      expect(disconnect).toHaveBeenCalledTimes(1)
      expect(manager.getAgent("agent-1")).toBeUndefined()
    })
  })

  it("adds an agent and connects when enabled", async () => {
    const m = freshManager()
    const config = buildBaseConfig()
    const instance = await m.addAgent(config)
    expect(instance.connectionStatus).toBe("connected")
    expect(m.getAgent("agent-1")).toBeDefined()
    expect(m.getConnectedAgents().length).toBe(1)
    expect(m.hasConnectedAgents()).toBe(true)
  })

  it("registers an enabled agent without connecting when requested", async () => {
    const m = freshManager()
    const instance = await m.addAgent(buildBaseConfig(), { connect: false })

    expect(instance.connectionStatus).toBe("disconnected")
    expect(m.getAgent("agent-1")).toBeDefined()
    expect(currentMock.connectImpl).not.toHaveBeenCalled()
  })

  it("retries a connection when the managed process exits during startup", async () => {
    const m = freshManager()
    currentMock.connectImpl
      .mockRejectedValueOnce(new Error("Codex app-server process exited with code 9"))
      .mockResolvedValueOnce(undefined)

    const instance = await m.addAgent(
      buildBaseConfig({
        retryConfig: {
          maxRetries: 1,
          retryDelay: 0,
          exponentialBackoff: false,
          maxRetryDelay: 0,
          retryOnErrors: [],
        },
      })
    )

    expect(currentMock.connectImpl).toHaveBeenCalledTimes(2)
    expect(instance.connectionStatus).toBe("connected")
  })

  it("auto-reconnects an established agent after an unexpected managed-process exit", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    ;(currentMock as unknown as { _connectionStatus: string })._connectionStatus = "disconnected"

    expect(mockProcessExitCb).toBeDefined()
    mockProcessExitCb?.({ agentId: "agent-1", code: 9 })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(currentMock.connectImpl).toHaveBeenCalledTimes(2)
    expect(m.getAgent("agent-1")?.connectionStatus).toBe("connected")
  })

  it("does not auto-reconnect an exit emitted by an intentional disconnect", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    currentMock.disconnect = jest.fn(async () => {
      ;(currentMock as unknown as { _connectionStatus: string })._connectionStatus = "disconnected"
      mockProcessExitCb?.({ agentId: "agent-1", code: 0 })
      await Promise.resolve()
    })

    await m.disconnect("agent-1")
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(currentMock.connectImpl).toHaveBeenCalledTimes(1)
    expect(m.getAgent("agent-1")?.connectionStatus).toBe("disconnected")
  })

  it("rejects adding the same agent twice", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    await expect(m.addAgent(buildBaseConfig())).rejects.toThrow(/already exists/)
  })

  it("rejects when maxConnections is reached", async () => {
    ExternalAgentManager.resetInstance()
    const m = ExternalAgentManager.getInstance({ healthCheckInterval: 0, maxConnections: 1 })
    protocolAdapterRegistry.register("acp", () => currentMock as never)
    await m.addAgent(buildBaseConfig())
    await expect(m.addAgent(buildBaseConfig({ id: "agent-2" }))).rejects.toThrow(
      /Maximum connections reached/
    )
  })

  it("rejects unknown protocols", async () => {
    const m = freshManager()
    // Unregister the http protocol if any, then attempt to add with one that
    // the registry won't resolve. Use 'a2a' which is not registered by
    // `registerDefaultAdapters` (only acp and opencode are).
    await expect(m.addAgent(buildBaseConfig({ protocol: "a2a" as never }))).rejects.toThrow()
  })

  it("removeAgent disconnects and forgets the agent", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    await m.removeAgent("agent-1")
    expect(m.getAgent("agent-1")).toBeUndefined()
  })

  it("disconnect followed by reconnect re-establishes connection", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    await m.disconnect("agent-1")
    expect(m.getAgent("agent-1")?.connectionStatus).toBe("disconnected")
    await m.reconnect("agent-1")
    expect(m.getAgent("agent-1")?.connectionStatus).toBe("connected")
  })

  it("connect throws for missing agents", async () => {
    const m = freshManager()
    await expect(m.connect("ghost")).rejects.toThrow(/not found/)
  })

  it("connect surfaces a block reason for disabled agents", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig({ enabled: false }))
    await expect(m.connect("agent-1")).rejects.toThrow(/disabled/i)
  })

  // ADR-0182. A refused runtime environment is terminal: the project asked for
  // something the deployment cannot give, and connecting anyway would start
  // the agent on the ordinary unsandboxed path — exactly what the refusal
  // said must not happen. It must also not be retried, or every attempt is
  // spent re-deriving the same answer and the reason is buried under
  // "connection failed".
  describe("a refused runtime environment", () => {
    afterEach(() => {
      __resetRunEnvironmentForTests()
    })

    it("stops the connect before the adapter is asked, once, with sandbox_unavailable", async () => {
      const m = freshManager()
      protocolAdapterRegistry.register("codex-app-server", () => currentMock as never)
      await m.addAgent(
        buildBaseConfig({
          protocol: "codex-app-server",
          retryConfig: {
            maxRetries: 3,
            retryDelay: 0,
            exponentialBackoff: false,
            maxRetryDelay: 0,
            retryOnErrors: ["connection", "sandbox", "environment"],
          },
        }),
        { connect: false }
      )
      recordRunEnvironmentOutcome("agent-1", {
        kind: "refused",
        code: "catalog_entry_unavailable",
        detail: { catalogEntryId: "gone" },
        notices: [],
      })

      await expect(m.connect("agent-1")).rejects.toMatchObject({
        name: "RunEnvironmentRefusedError",
        code: "catalog_entry_unavailable",
      })
      expect(currentMock.connectImpl).not.toHaveBeenCalled()
      expect(m.getAgent("agent-1")?.validity?.blockingReasonCode).toBe("sandbox_unavailable")
    })

    it.each([
      ["off", { kind: "off" as const }],
      [
        "a fallback",
        {
          kind: "fallback" as const,
          code: "sandbox_fallback_pool_disabled" as const,
          notices: [],
        },
      ],
    ])("lets %s through, because both mean run on the existing path", async (_label, outcome) => {
      const m = freshManager()
      await m.addAgent(buildBaseConfig(), { connect: false })
      recordRunEnvironmentOutcome("agent-1", outcome)
      await m.connect("agent-1")
      expect(m.getAgent("agent-1")?.connectionStatus).toBe("connected")
    })
  })
})

describe("Capability helpers (unsupported / ok / error)", () => {
  it("getSessionModels reports unsupported when adapter lacks the method", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    currentMock.getSessionModelsImpl = undefined
    const result = m.getSessionModels("agent-1", "s_1")
    expect(result.status).toBe("unsupported")
  })

  it("getSessionModels returns ok with data when present", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    currentMock.getSessionModelsImpl = jest.fn((_id: string) => ({ models: [] }))
    const result = m.getSessionModels("agent-1", "s_1")
    expect(result.status).toBe("ok")
  })

  it("getSessionModels returns error wrapper when adapter throws", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    currentMock.getSessionModelsImpl = jest.fn((_id: string) => {
      throw new Error("boom")
    })
    const result = m.getSessionModels("agent-1", "s_1")
    expect(result.status).toBe("error")
  })

  it("setSessionMode/setSessionModel error when adapter doesn't support", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    // override methods to undefined (delete doesn't work on prototype methods)
    ;(currentMock as unknown as { setSessionMode: undefined }).setSessionMode = undefined
    ;(currentMock as unknown as { setSessionModel: undefined }).setSessionModel = undefined
    await expect(m.setSessionMode("agent-1", "s_1", "default")).rejects.toThrow()
    await expect(m.setSessionModel("agent-1", "s_1", "claude")).rejects.toThrow()
  })

  it("setConfigOption / getConfigOptions reflect adapter support", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    currentMock.getConfigOptionsImpl = jest.fn((_id: string) => [{ id: "x", value: "y" }])
    expect(m.getConfigOptions("agent-1", "s_1").status).toBe("ok")
    ;(currentMock as unknown as { setConfigOption: undefined }).setConfigOption = undefined
    await expect(m.setConfigOption("agent-1", "s_1", "k", "v")).rejects.toThrow()
  })

  it("elicitation responses and request cancellation delegate to the active adapter", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    const response = { requestId: "elicit-1", action: "cancel" } as const

    await m.respondToElicitation("agent-1", response)
    await m.cancelRequest("agent-1", 17)

    expect(currentMock.respondToElicitationImpl).toHaveBeenCalledWith(response)
    expect(currentMock.cancelRequestImpl).toHaveBeenCalledWith(17)
  })

  it("getAuthMethods returns ok by default; isAuthenticationRequired/authenticate error if missing", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    expect(m.getAuthMethods("agent-1").status).toBe("ok")
    expect(m.isAuthenticationRequired("agent-1")).toBe(false)
    ;(currentMock as unknown as { authenticate: undefined }).authenticate = undefined
    await expect(m.authenticate("agent-1", "id")).rejects.toThrow()
  })

  it("projects and cancels terminal authentication through the adapter", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    expect(m.getTerminalAuthState("agent-1")).toEqual({
      methodId: "terminal",
      status: "running",
    })
    await expect(m.cancelTerminalAuthentication("agent-1")).resolves.toBeUndefined()
    expect(m.getTerminalAuthState("ghost")).toBeUndefined()
  })

  it("requires explicit confirmation before provider credentials can leave Cognia", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    await expect(
      m.setProvider("agent-1", {
        providerId: "private",
        apiType: "openai_compatible",
        baseUrl: "https://provider.example/v1",
        headers: { Authorization: "Bearer secret" },
      } as never)
    ).rejects.toThrow(/Explicit confirmation/)
  })

  it("routes Project Editor document lifecycle only to active NES sessions", async () => {
    const startNes = jest.fn(async () => ({ sessionId: "nes-1" }))
    const closeNes = jest.fn(async () => ({}))
    const didOpenDocument = jest.fn()
    const didChangeDocument = jest.fn()
    const didSaveDocument = jest.fn()
    const didFocusDocument = jest.fn()
    const didCloseDocument = jest.fn()
    Object.assign(currentMock, {
      startNes,
      closeNes,
      didOpenDocument,
      didChangeDocument,
      didSaveDocument,
      didFocusDocument,
      didCloseDocument,
    })
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    await m.startNes("agent-1", { workspaceUri: "file:///repo" })

    m.publishDidOpenDocument({
      uri: "file:///repo/a.ts",
      languageId: "typescript",
      version: 1,
      text: "x",
    })
    m.publishDidChangeDocument({
      uri: "file:///repo/a.ts",
      version: 2,
      contentChanges: [{ text: "y" }],
    })
    m.publishDidSaveDocument({ uri: "file:///repo/a.ts" })
    m.publishDidFocusDocument({
      uri: "file:///repo/a.ts",
      version: 2,
      position: { line: 0, character: 0 },
      visibleRange: {
        start: { line: 0, character: 0 },
        end: { line: 1, character: 0 },
      },
    })
    m.publishDidCloseDocument({ uri: "file:///repo/a.ts" })

    expect(didOpenDocument).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "nes-1" }))
    expect(didChangeDocument).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "nes-1", version: 2 })
    )
    expect(didSaveDocument).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "nes-1" }))
    expect(didFocusDocument).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "nes-1" }))
    expect(didCloseDocument).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "nes-1" }))

    await m.closeNes("agent-1", { sessionId: "nes-1" } as never)
    didOpenDocument.mockClear()
    m.publishDidOpenDocument({
      uri: "file:///repo/b.ts",
      languageId: "typescript",
      version: 1,
      text: "z",
    })
    expect(didOpenDocument).not.toHaveBeenCalled()
  })

  it("respondToPermission throws when agent missing", async () => {
    const m = freshManager()
    await expect(
      m.respondToPermission("ghost", "s_1", { requestId: "r", outcome: "cancelled" } as never)
    ).rejects.toThrow(/not found/)
  })

  it("logout delegates to the adapter when supported and no-ops otherwise", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    currentMock.logoutImpl = jest.fn(async () => {})
    await m.logout("agent-1")
    expect(currentMock.logoutImpl).toHaveBeenCalledTimes(1)
    // Unknown agent / unsupported adapter: no throw.
    await expect(m.logout("ghost")).resolves.toBeUndefined()
  })

  it("deleteSession uses adapter.deleteSession when present, else falls back to closeSession", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    currentMock.deleteSessionImpl = jest.fn(async (_id: string) => {})
    await m.deleteSession("agent-1", "s_1")
    expect(currentMock.deleteSessionImpl).toHaveBeenCalledWith("s_1")

    // Without deleteSession the manager falls back to closeSession.
    currentMock.deleteSessionImpl = undefined
    const closeSpy = jest.spyOn(currentMock, "closeSession")
    await m.deleteSession("agent-1", "s_2")
    expect(closeSpy).toHaveBeenCalledWith("s_2")
  })
})

describe("capability profile (ADR-0090 external SSOT)", () => {
  it("has no profile before the agent connects", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig({ enabled: false }))
    // Absence is the point: "we have not asked" and "we asked and the answer
    // is no" must not render identically.
    expect(m.getAgentCapabilityProfile("agent-1")).toBeUndefined()
  })

  it("builds a NEGOTIATED profile once the handshake completes", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    const profile = m.getAgentCapabilityProfile("agent-1")
    expect(profile?.negotiated).toBe(true)
    expect(profile?.protocol).toBe("acp")
    expect(profile?.digest).toMatch(/^eacp1-/)
  })

  it("does not project a local tool bridge into an unrelated OpenCode endpoint", async () => {
    const m = freshManager()
    protocolAdapterRegistry.register("opencode-v2", () => currentMock as never)
    await m.addAgent(
      buildBaseConfig({
        protocol: "opencode-v2",
        network: { endpoint: "https://remote.example.test" },
      })
    )
    expect(m.getAgentCapabilityProfile("agent-1")?.effective.mcp.level).toBe("unsupported")
    expect(m.getAgentCapabilityProfile("agent-1")?.effective["tools.ordinary"].level).toBe("native")
  })

  it("scopes running tool-host evidence to its owning chat and clears it on pause", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    m.setSessionHostFacts("agent-1", "chat-a", {
      toolHostRunning: true,
      subagentDispatchProjected: true,
      hookRuntimeAvailable: true,
    })
    expect(
      m.getAgentCapabilityProfile("agent-1", "chat-a")?.effective["subagents.model-selection"].level
    ).toBe("equivalent")
    expect(
      m.getAgentCapabilityProfile("agent-1", "chat-b")?.effective["subagents.model-selection"].level
    ).toBe("unsupported")
    expect(
      m.getAgentCapabilityProfile("agent-1")?.effective["subagents.model-selection"].level
    ).toBe("unsupported")
    m.setSessionHostFacts("agent-1", "chat-a", null)
    expect(
      m.getAgentCapabilityProfile("agent-1", "chat-a")?.effective["subagents.model-selection"].level
    ).toBe("unsupported")
  })

  it("resolves adapter-method capabilities from the live instance", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    const profile = m.getAgentCapabilityProfile("agent-1")
    // MockAdapter implements setSessionMode/setSessionModel but no steerTurn,
    // which is exactly what `supportsSteering` reports for it.
    expect(profile?.effective["permissions.set-mode"].level).toBe("native")
    expect(profile?.effective["set-model"].level).toBe("native")
    expect(profile?.effective.steer.level).toBe("unsupported")
    expect(m.supportsSteering("agent-1")).toBe(false)
  })

  it("reports the renderer's hook runtime as a HOST capability", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    // No external protocol models Cognia's lifecycle hooks, so the manifest row
    // is `unknown`; the renderer wraps every external turn, so the host layer
    // answers it.
    expect(m.getAgentCapabilityProfile("agent-1")?.effective["hooks.lifecycle"]).toMatchObject({
      level: "equivalent",
    })
  })

  it("re-answers compaction when the agent advertises /compact mid-session", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    // ACP's only compaction route is a `/compact` the agent chose to advertise,
    // so before any command list arrives nothing has measured it. `unknown`,
    // not `unsupported` — the distinction is what lets it flip below.
    expect(m.getAgentCapabilityProfile("agent-1")?.effective.compaction.level).toBe("unknown")

    const session = await m.createSession("agent-1")
    session.metadata = { availableCommands: [{ name: "compact", description: "" }] }

    expect(m.getAgentCapabilityProfile("agent-1")?.effective.compaction).toMatchObject({
      level: "equivalent",
      evidence: "handshake",
    })

    // The recompute lands ON the instance, which is what every renderer surface
    // reads (`manager.tsx`, `useExternalAgentById`). If it only ever returned a
    // fresh copy, those surfaces would keep showing the connect-time answer.
    const instance = m.getAllAgents().find((a) => a.config.id === "agent-1")
    expect(instance?.capabilityProfile?.effective.compaction.level).toBe("equivalent")
  })

  it("drops the profile when the contributing plugin is disabled", async () => {
    const m = freshManager()
    protocolAdapterRegistry.register("wire:demo", () => currentMock as never)
    await m.addAgent(buildBaseConfig({ id: "p-agent", protocol: "wire:demo" as never }))
    expect(m.getAgentCapabilityProfile("p-agent")).toBeDefined()

    await m.teardownAgentsByProtocols(["wire:demo"])
    // The adapter is gone; a surface must not keep answering "this agent can
    // steer" about an agent with no adapter at all.
    expect(m.getAgentCapabilityProfile("p-agent")).toBeUndefined()
    protocolAdapterRegistry.unregister("wire:demo")
  })
})

describe("Session extensions: list/fork/resume", () => {
  it("listSessions throws unsupported error when adapter lacks listSessions", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    ;(currentMock as unknown as { listSessions: undefined }).listSessions = undefined
    await expect(m.listSessions("agent-1")).rejects.toThrow(/listing/i)
  })

  it("listSessions resolves when adapter returns data", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    currentMock.listSessionsImpl = jest.fn(async () => [{ sessionId: "s_1", title: "t" }])
    const out = await m.listSessions("agent-1")
    expect(out).toHaveLength(1)
  })

  it("listSessions retries a persisted `unsupported` once the adapter has the method", async () => {
    // The verdict is hydrated from the stored validity snapshot. An adapter
    // that gained `listSessions` after the snapshot was written (Pi) must not
    // stay blocked on a verdict about code that no longer runs.
    const m = freshManager()
    await m.addAgent(
      buildBaseConfig({
        validitySnapshot: {
          executable: true,
          checkedAt: new Date(),
          source: "execution",
          sessionExtensions: {
            "session/list": {
              state: "unsupported",
              reasonCode: "extension_unsupported",
              reason: "Agent does not support session listing",
            },
            "session/fork": { state: "unknown" },
            "session/resume": { state: "unknown" },
          },
        },
      } as never)
    )
    currentMock.listSessionsImpl = jest.fn(async () => [{ sessionId: "s_1" }])
    await expect(m.listSessions("agent-1")).resolves.toHaveLength(1)
    expect(m.getAgent("agent-1")?.validity?.sessionExtensions["session/list"].state).toBe(
      "supported"
    )
  })

  it("listSessions forwards an ACP cwd filter and preserves workspace roots", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    currentMock.listSessionsImpl = jest.fn(async () => [
      { sessionId: "s_1", cwd: "/work", additionalDirectories: ["/shared"] },
    ])

    const out = await m.listSessions("agent-1", { cwd: "/work" })

    expect(currentMock.listSessionsImpl).toHaveBeenCalledWith({ cwd: "/work" })
    expect(out).toEqual([{ sessionId: "s_1", cwd: "/work", additionalDirectories: ["/shared"] }])
  })

  it("forkSession throws unsupported when adapter lacks forkSession", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    ;(currentMock as unknown as { forkSession: undefined }).forkSession = undefined
    await expect(m.forkSession("agent-1", "s_1")).rejects.toThrow(/forking/i)
  })

  it("forkSession adds the forked session to the instance map", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    const forked = {
      id: "s_forked",
      agentId: "agent-1",
      status: "active" as const,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      messages: [],
      permissionMode: "default" as const,
    }
    currentMock.forkSessionImpl = jest.fn(async (_id: string) => forked)
    const out = await m.forkSession("agent-1", "s_1")
    expect(out.id).toBe("s_forked")
  })

  it("forkSession forwards workspace options to the adapter", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    const forked = {
      id: "s_forked",
      agentId: "agent-1",
      status: "active" as const,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      messages: [],
      permissionMode: "default" as const,
    }
    currentMock.forkSessionImpl = jest.fn(
      async (_sessionId: string, _options?: SessionCreateOptions) => forked
    )

    await m.forkSession("agent-1", "s_1", {
      cwd: "/work",
      additionalDirectories: ["/shared"],
    })

    expect(currentMock.forkSessionImpl).toHaveBeenCalledWith("s_1", {
      cwd: "/work",
      additionalDirectories: ["/shared"],
    })
  })

  it("resumeSession throws unsupported when adapter lacks resumeSession", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    ;(currentMock as unknown as { resumeSession: undefined }).resumeSession = undefined
    await expect(m.resumeSession("agent-1", "s_1")).rejects.toThrow(/resume/i)
  })

  it("resumeSession returns the resumed session and tracks it", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    const resumed = {
      id: "s_resumed",
      agentId: "agent-1",
      status: "active" as const,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      messages: [],
      permissionMode: "default" as const,
    }
    currentMock.resumeSessionImpl = jest.fn(async (_id: string) => resumed)
    const out = await m.resumeSession("agent-1", "s_1")
    expect(out.id).toBe("s_resumed")
  })
})

describe("execute — model selection", () => {
  // Regression: `ExternalAgentExecutionOptions` had no `model`, so callers that
  // passed one (the plugin subagent dispatcher did) were silently dropped —
  // spread properties bypass TypeScript's excess-property check, so it type-
  // checked while doing nothing. The only channel adapters actually read is
  // `metadata.selectedModel`, which `buildSessionOptions` never populated; its
  // sole writer was the interactive picker, which nothing called.
  async function connectedManager() {
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    await m.connect("agent-1")
    return m
  }

  it("bridges the requested model to the adapter as metadata.selectedModel", async () => {
    const m = await connectedManager()
    const createSession = jest.spyOn(currentMock, "createSession")

    await m.execute("agent-1", "hi", { model: "gpt-5.6-sol" })

    const opts = createSession.mock.calls[0]?.[0] as { metadata?: Record<string, unknown> }
    expect(opts.metadata?.selectedModel).toBe("gpt-5.6-sol")
  })

  it("applies a requested model through ACP config options on a new session", async () => {
    const m = await connectedManager()
    currentMock.getConfigOptionsImpl = jest.fn((_sessionId: string) => ({
      status: "ok",
      data: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "claude-sonnet-4-5",
          options: [
            { value: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
            { value: "claude-opus-4-1", name: "Claude Opus 4.1" },
          ],
        },
      ],
    }))
    await m.execute("agent-1", "hi", { model: "claude-opus-4-1" })

    expect(currentMock.setConfigOptionImpl).toHaveBeenCalledWith("s_1", "model", "claude-opus-4-1")
    expect(currentMock.setSessionModelImpl).not.toHaveBeenCalled()
  })

  it("omits selectedModel entirely when no model is requested", async () => {
    // So the agent keeps whatever its own configuration selects.
    const m = await connectedManager()
    const createSession = jest.spyOn(currentMock, "createSession")

    await m.execute("agent-1", "hi")

    const opts = createSession.mock.calls[0]?.[0] as { metadata?: Record<string, unknown> }
    expect(opts.metadata?.selectedModel).toBeUndefined()
  })

  it("bridges the requested thinking level as metadata.reasoningEffort", async () => {
    // Same class of regression as `model` above: the composer's thinking level
    // reached only the built-in runtime, so on an external agent the control
    // was silently inert.
    const m = await connectedManager()
    const createSession = jest.spyOn(currentMock, "createSession")

    await m.execute("agent-1", "hi", { reasoningEffort: "xhigh" })

    const opts = createSession.mock.calls[0]?.[0] as { metadata?: Record<string, unknown> }
    expect(opts.metadata?.reasoningEffort).toBe("xhigh")
  })

  it("omits reasoningEffort entirely when none is requested", async () => {
    // Absent — not null — so the Codex client's `defaultReasoningEffort`
    // fallback (which only fires on `undefined`) still applies.
    const m = await connectedManager()
    const createSession = jest.spyOn(currentMock, "createSession")

    await m.execute("agent-1", "hi")

    const opts = createSession.mock.calls[0]?.[0] as { metadata?: Record<string, unknown> }
    expect(opts.metadata?.reasoningEffort).toBeUndefined()
  })

  it("applies a requested thinking level through the thought_level option", async () => {
    // The `metadata.reasoningEffort` bridge above is read by the Codex client
    // and by nothing else. Every other adapter takes depth the way it takes a
    // model — as a config option — so on Pi the composer's chip was inert.
    const m = await connectedManager()
    currentMock.getConfigOptionsImpl = jest.fn((_sessionId: string) => ({
      status: "ok",
      data: [
        {
          id: "thinking",
          name: "Thinking",
          category: "thought_level",
          type: "select",
          currentValue: "medium",
          options: [
            { value: "off", name: "Off" },
            { value: "low", name: "Low" },
            { value: "medium", name: "Medium" },
            { value: "high", name: "High" },
            { value: "xhigh", name: "Extra high" },
            { value: "max", name: "Max" },
          ],
        },
      ],
    }))

    await m.execute("agent-1", "hi", { reasoningEffort: "max" })

    expect(currentMock.setConfigOptionImpl).toHaveBeenCalledWith("s_1", "thinking", "max")
  })

  it("reads the published ladder once per change, not once per turn", async () => {
    // The composer's chips already hold this reply per (agent, session). Asking
    // the agent again on every turn was a second round trip to a real process
    // for an answer nothing had invalidated.
    //
    // A thinking WRITE is the one turn that DOES move something — on Devin it
    // lands as a model-variant switch, which invalidates the shared surface —
    // so the turn after a write pays one refetch, and reads stop again once the
    // landed level reads back equal to the request.
    const m = await connectedManager()
    let current = "low"
    const optionsFor = () => [
      {
        id: "thinking",
        name: "Thinking",
        category: "thought_level",
        type: "select",
        currentValue: current,
        options: [
          { value: "low", name: "Low" },
          { value: "high", name: "High" },
        ],
      },
    ]
    currentMock.getConfigOptionsImpl = jest.fn((_sessionId: string) => ({
      status: "ok",
      data: optionsFor(),
    }))
    currentMock.setConfigOptionImpl = jest.fn(
      async (_sessionId: string, _configId: string, value: string | boolean) => {
        current = String(value)
        return optionsFor()
      }
    )

    const first = await m.execute("agent-1", "one", { reasoningEffort: "high" })
    const afterFirst = currentMock.getConfigOptionsImpl.mock.calls.length
    expect(afterFirst).toBeGreaterThan(0)

    // Turn one wrote low → high: the next turn re-reads once (the write may
    // have moved the model and with it the ladder), sees the landed level, and
    // writes nothing. The turn after that reads nothing again.
    await m.execute("agent-1", "two", { sessionId: first.sessionId, reasoningEffort: "high" })
    const afterSecond = currentMock.getConfigOptionsImpl.mock.calls.length
    expect(afterSecond).toBeGreaterThan(afterFirst)
    await m.execute("agent-1", "two-b", { sessionId: first.sessionId, reasoningEffort: "high" })
    expect(currentMock.getConfigOptionsImpl.mock.calls.length).toBe(afterSecond)

    // A model write DOES move the ladder, so that turn pays for a fresh read.
    await m.execute("agent-1", "three", {
      sessionId: first.sessionId,
      reasoningEffort: "high",
      model: "gpt-5.6-codex",
    })
    expect(currentMock.getConfigOptionsImpl.mock.calls.length).toBeGreaterThan(afterSecond)
  })

  it("books the landed model variant when a thinking write moves the model", async () => {
    // Devin encodes effort in the model id, so a thought_level write answers
    // with the model option already moved (swe-2-max → swe-2-high). If the
    // session kept bookkeeping the pre-write id, the next turn's applyModel
    // would pin the stale variant and undo the pick. The observable proof:
    // asking for the LANDED model next turn falls to the `selectedModel`
    // metadata check and writes nothing — without the write-back it would
    // issue a setSessionModel the adapter does not even offer here.
    const m = await connectedManager()
    let level = "max"
    // No `model` category option on the read path (e.g. an adapter that only
    // surfaces the thinking axis) — so applyModel can only consult the
    // session's own selectedModel bookkeeping.
    currentMock.getConfigOptionsImpl = jest.fn((_sessionId: string) => ({
      status: "ok",
      data: [
        {
          id: "devin.thought_level",
          name: "Thinking",
          category: "thought_level",
          type: "select",
          currentValue: level,
          options: [
            { value: "medium", name: "medium" },
            { value: "high", name: "high" },
            { value: "max", name: "max" },
          ],
        },
      ],
    }))
    currentMock.setConfigOptionImpl = jest.fn(
      async (_sessionId: string, configId: string, value: string | boolean) => {
        expect(configId).toBe("devin.thought_level")
        expect(value).toBe("high")
        level = String(value)
        // …but the WRITE answers with the full wire list — including the model
        // option already moved to the high variant, the way Devin reports it.
        return [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "swe-2-high",
            options: [
              { value: "swe-2-max", name: "SWE-2 max" },
              { value: "swe-2-high", name: "SWE-2 high" },
            ],
          },
        ]
      }
    )

    const first = await m.execute("agent-1", "one", { reasoningEffort: "high" })
    expect(currentMock.setConfigOptionImpl).toHaveBeenCalledWith(
      "s_1",
      "devin.thought_level",
      "high"
    )

    // The session now books swe-2-high: a next turn that asks for exactly that
    // model short-circuits instead of writing it again.
    await m.execute("agent-1", "two", {
      sessionId: first.sessionId,
      model: "swe-2-high",
      reasoningEffort: "high",
    })
    expect(currentMock.setSessionModelImpl).not.toHaveBeenCalled()
    expect(currentMock.setConfigOptionImpl).toHaveBeenCalledTimes(1)
  })

  it("folds a requested level DOWN onto the ladder the agent published", async () => {
    // Pi accepts an unsupported level, answers success, and silently clamps to
    // `off` — so forwarding `max` at a model that stops at `high` turns "think
    // hard" into "don't think" with no error anywhere. Stepping down rather
    // than up, because overspending a reasoning budget is the worse mistake.
    const m = await connectedManager()
    currentMock.getConfigOptionsImpl = jest.fn((_sessionId: string) => ({
      status: "ok",
      data: [
        {
          id: "thinking",
          name: "Thinking",
          category: "thought_level",
          type: "select",
          currentValue: "low",
          options: [
            { value: "low", name: "Low" },
            { value: "high", name: "High" },
          ],
        },
      ],
    }))

    await m.execute("agent-1", "hi", { reasoningEffort: "max" })

    expect(currentMock.setConfigOptionImpl).toHaveBeenCalledWith("s_1", "thinking", "high")
  })

  it("writes nothing when the agent already sits at the requested level", async () => {
    const m = await connectedManager()
    currentMock.getConfigOptionsImpl = jest.fn((_sessionId: string) => ({
      status: "ok",
      data: [
        {
          id: "thinking",
          name: "Thinking",
          category: "thought_level",
          type: "select",
          currentValue: "high",
          options: [
            { value: "low", name: "Low" },
            { value: "high", name: "High" },
          ],
        },
      ],
    }))

    await m.execute("agent-1", "hi", { reasoningEffort: "high" })

    expect(currentMock.setConfigOptionImpl).not.toHaveBeenCalled()
  })

  it("leaves an agent with no thought_level option alone", async () => {
    // Absent, not broken. Writing the app's own vocabulary at an agent that
    // never published one is the silent-clamp bug the fold exists to prevent.
    const m = await connectedManager()
    currentMock.getConfigOptionsImpl = jest.fn((_sessionId: string) => ({
      status: "ok",
      data: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "sonnet",
          options: [{ value: "sonnet", name: "Sonnet" }],
        },
      ],
    }))

    await m.execute("agent-1", "hi", { reasoningEffort: "max" })

    // No model was requested either, so nothing at all should be written.
    expect(currentMock.setConfigOptionImpl).not.toHaveBeenCalled()
  })

  it("still runs the turn when the agent refuses the level", async () => {
    // Best-effort, like the model path: a rejected depth must not kill a turn
    // that runs fine at the session's current one.
    const m = await connectedManager()
    currentMock.getConfigOptionsImpl = jest.fn((_sessionId: string) => ({
      status: "ok",
      data: [
        {
          id: "thinking",
          name: "Thinking",
          category: "thought_level",
          type: "select",
          currentValue: "low",
          options: [{ value: "max", name: "Max" }],
        },
      ],
    }))
    currentMock.setConfigOptionImpl = jest.fn(async () => {
      throw new Error("that model cannot think that hard")
    })

    await expect(m.execute("agent-1", "hi", { reasoningEffort: "max" })).resolves.toBeDefined()
  })

  it("switches a reused session onto a newly requested model", async () => {
    // A cached session never sees sessionOptions, so its model can only change
    // through setSessionModel.
    const m = await connectedManager()
    const first = await m.execute("agent-1", "one", { model: "gpt-5.6-sol" })
    currentMock.setSessionModelImpl.mockClear()

    await m.execute("agent-1", "two", { sessionId: first.sessionId, model: "gpt-5.6-codex" })

    expect(currentMock.setSessionModelImpl).toHaveBeenCalledWith(first.sessionId, "gpt-5.6-codex")
  })

  it("does not re-set the model when a reused session already runs it", async () => {
    const m = await connectedManager()
    const first = await m.execute("agent-1", "one", { model: "gpt-5.6-sol" })
    currentMock.setSessionModelImpl.mockClear()

    await m.execute("agent-1", "two", { sessionId: first.sessionId, model: "gpt-5.6-sol" })

    expect(currentMock.setSessionModelImpl).not.toHaveBeenCalled()
  })

  it("leaves a reused session alone when no model is requested", async () => {
    const m = await connectedManager()
    const first = await m.execute("agent-1", "one", { model: "gpt-5.6-sol" })
    currentMock.setSessionModelImpl.mockClear()

    await m.execute("agent-1", "two", { sessionId: first.sessionId })

    expect(currentMock.setSessionModelImpl).not.toHaveBeenCalled()
  })

  it("tells the agent to stop when the caller aborts mid-turn", async () => {
    // The signal used to be read once per attempt and never again, so pressing
    // Esc stopped the local turn while the agent ran on: it finished its work
    // and its tools, answering into a conversation the user had already ended.
    const m = await connectedManager()
    const controller = new AbortController()
    let release: (() => void) | undefined
    currentMock.executeImpl = jest.fn(
      () =>
        new Promise<ExternalAgentResult>((resolve) => {
          release = () =>
            resolve({
              success: true,
              sessionId: "s_1",
              finalResponse: "",
              messages: [],
              steps: [],
              toolCalls: [],
              duration: 1,
            })
        })
    )
    const running = m.execute("agent-1", "one", { signal: controller.signal })
    // Wait for the turn to actually be in flight: the abort listener is armed
    // around the adapter call, which several awaits (readiness, session
    // resolution, trace bridge) precede.
    while (!release) await new Promise((resolve) => setTimeout(resolve, 1))
    expect(currentMock.cancelImpl).not.toHaveBeenCalled()

    controller.abort()
    await new Promise((resolve) => setTimeout(resolve, 1))
    expect(currentMock.cancelImpl).toHaveBeenCalledWith("s_1")

    release()
    await running
  })

  it("fails the turn when the adapter refuses the requested model", async () => {
    // This used to be swallowed as best-effort, and the turn then ran on
    // whatever model the session was already on while every surface named the
    // one the user picked. Pi made it concrete: an extension-contributed model
    // is not in an isolated session's catalog, `set_model` answered "Model not
    // found", and the answer (and the bill) came from another provider under
    // the chosen model's name.
    const m = await connectedManager()
    const first = await m.execute("agent-1", "one", { model: "gpt-5.6-sol" })
    currentMock.setSessionModelImpl.mockRejectedValueOnce(new Error("unknown model"))

    await expect(
      m.execute("agent-1", "two", { sessionId: first.sessionId, model: "bogus-model" })
    ).rejects.toThrow(/refused the model "bogus-model" \(unknown model\)/)
  })

  it("fails the turn when the adapter accepts the model and stays on another", async () => {
    // The other half of a refusal, and the quiet one. Pi accepts an
    // unsupported thinking level, answers success and silently clamps, so an
    // agent doing the same on its model axis would run the whole turn on a
    // model nobody chose. `setConfigOption` answers with the list as it stands
    // after the write, which is what makes the write checkable at all.
    const m = await connectedManager()
    currentMock.getConfigOptionsImpl = jest.fn((_sid: string) => [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "deepseek/deepseek-v4-pro",
        options: [
          { value: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro" },
          { value: "commandcode/claude-opus-5", name: "Claude Opus 5" },
        ],
      },
    ])
    currentMock.setConfigOptionImpl.mockResolvedValueOnce([
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        // Accepted, and nothing moved.
        currentValue: "deepseek/deepseek-v4-pro",
        options: [],
      },
    ])

    await expect(
      m.execute("agent-1", "one", { model: "commandcode/claude-opus-5" })
    ).rejects.toThrow(/stayed on "deepseek\/deepseek-v4-pro"/)
  })

  it("does not fail a turn over an answer it cannot read", async () => {
    // Only a positively contradictory read refuses. An adapter that answers
    // with no model option has told us nothing, and grounding a working agent
    // over an unreadable reply is worse than the silence this guard replaced.
    const m = await connectedManager()
    currentMock.getConfigOptionsImpl = jest.fn((_sid: string) => [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "deepseek/deepseek-v4-pro",
        options: [{ value: "commandcode/claude-opus-5", name: "Claude Opus 5" }],
      },
    ])
    currentMock.setConfigOptionImpl.mockResolvedValueOnce([])
    await expect(
      m.execute("agent-1", "one", { model: "commandcode/claude-opus-5" })
    ).resolves.toMatchObject({ success: true })
  })

  it("books a turn that died while being prepared as a failed run", async () => {
    // The failure bookkeeping used to live entirely below session resolution,
    // so a throw from it left the agent reading `executing` with nothing
    // running and no `lastError` to explain the empty screen.
    const m = await connectedManager()
    const first = await m.execute("agent-1", "one", { model: "gpt-5.6-sol" })
    currentMock.setSessionModelImpl.mockRejectedValueOnce(new Error("unknown model"))

    await expect(
      m.execute("agent-1", "two", { sessionId: first.sessionId, model: "bogus-model" })
    ).rejects.toThrow()

    const agent = m.getAgent("agent-1")
    expect(agent?.status).toBe("failed")
    expect(agent?.lastError).toMatch(/refused the model/)
    expect(agent?.stats.failedExecutions).toBe(1)
  })
})

describe("Session lifecycle (createSession / closeSession / getSession)", () => {
  it("createSession works only when the adapter is connected", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    const s = await m.createSession("agent-1")
    expect(s.id).toBe("s_1")
    expect(m.getSession("agent-1", "s_1")).toBeDefined()
  })

  it("createSession fails when not connected", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    await m.disconnect("agent-1")
    await expect(m.createSession("agent-1")).rejects.toThrow(/not connected/)
  })

  it("createSession fails for an unknown agent", async () => {
    const m = freshManager()
    await expect(m.createSession("ghost")).rejects.toThrow(/not found/)
  })

  it("closeSession removes the session from both adapter and instance", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    const s = await m.createSession("agent-1")
    await m.closeSession("agent-1", s.id)
    expect(m.getSession("agent-1", s.id)).toBeUndefined()
  })

  it("plumbs per-agent codexOptions into the execution session options metadata", async () => {
    const m = freshManager()
    await m.addAgent(
      buildBaseConfig({
        codexOptions: { sandboxMode: "readOnly", defaultReasoningEffort: "high" },
      })
    )
    await m.execute("agent-1", "hello")
    const session = currentMock.getSessions()[0]
    const metadata = session.metadata as { codexOptions?: Record<string, unknown> }
    expect(metadata.codexOptions).toEqual({
      sandboxMode: "readOnly",
      defaultReasoningEffort: "high",
    })
  })
})

describe("steerSession / supportsSteering", () => {
  it("reports no steering support and throws when the adapter lacks steerTurn", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    expect(m.supportsSteering("agent-1")).toBe(false)
    await expect(m.steerSession("agent-1", "s_1", "hint")).rejects.toThrow(
      /does not support steering/i
    )
  })

  it("delegates to the adapter's steerTurn with an explicit session id", async () => {
    const steerTurn = jest.fn(async () => {})
    ;(currentMock as unknown as { steerTurn: unknown }).steerTurn = steerTurn
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    expect(m.supportsSteering("agent-1")).toBe(true)
    await m.steerSession("agent-1", "s_explicit", "focus on tests")
    expect(steerTurn).toHaveBeenCalledWith("s_explicit", "focus on tests")
  })

  it("resolves the executing session when no session id is given", async () => {
    const steerTurn = jest.fn(async () => {})
    ;(currentMock as unknown as { steerTurn: unknown }).steerTurn = steerTurn
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    const session = await m.createSession("agent-1")
    currentMock.getSession(session.id)!.status = "executing"
    await m.steerSession("agent-1", undefined, "look here")
    expect(steerTurn).toHaveBeenCalledWith(session.id, "look here")
  })

  it("throws when no session is executing and none was specified", async () => {
    const steerTurn = jest.fn(async () => {})
    ;(currentMock as unknown as { steerTurn: unknown }).steerTurn = steerTurn
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    await m.createSession("agent-1")
    await expect(m.steerSession("agent-1", undefined, "hint")).rejects.toThrow(
      /no executing session/i
    )
  })
})

describe("session compaction and provider undo routing", () => {
  it("reports unsupported when the adapter does not implement the capability contract", async () => {
    const manager = freshManager()
    await manager.addAgent(buildBaseConfig())
    await expect(manager.getCompactionCapability("agent-1", "s_1")).resolves.toEqual({
      status: "unsupported",
      routes: [],
      reason: "adapter_unsupported",
    })
    await expect(manager.getProviderUndoCapability("agent-1", "s_1")).resolves.toEqual({
      status: "unsupported",
      reason: "adapter_unsupported",
    })
  })

  it("delegates compaction options and provider undo to the live adapter", async () => {
    const getCompactionCapability = jest.fn(async () => ({
      status: "supported" as const,
      routes: [{ kind: "native" as const, supportsFocus: false as const }],
    }))
    const compactSession = jest.fn(async () => {})
    const getProviderUndoCapability = jest.fn(async () => ({
      status: "supported" as const,
      command: "undo" as const,
    }))
    const undoLastProviderChange = jest.fn(async () => {})
    Object.assign(currentMock, {
      getCompactionCapability,
      compactSession,
      getProviderUndoCapability,
      undoLastProviderChange,
    })

    const manager = freshManager()
    await manager.addAgent(buildBaseConfig())
    await expect(manager.getCompactionCapability("agent-1", "s_1")).resolves.toMatchObject({
      status: "supported",
    })
    await manager.compactSession("agent-1", "s_1", { focus: "Keep decisions" })
    await manager.undoLastProviderChange("agent-1", "s_1")
    expect(compactSession).toHaveBeenCalledWith("s_1", { focus: "Keep decisions" })
    expect(undoLastProviderChange).toHaveBeenCalledWith("s_1")
  })
})

describe("execute / cancel", () => {
  describe("external account and tool replay protection", () => {
    const retryConfig = {
      maxRetries: 2,
      retryDelay: 0,
      exponentialBackoff: false,
      maxRetryDelay: 0,
      retryOnErrors: ["network", "quota", "authentication", "requests"],
    }

    it.each([
      new Error("401 Unauthorized: connection rejected"),
      new Error("403 Forbidden: network access rejected"),
      new Error("429 Too many requests"),
      new Error("temporary insufficient_quota"),
      new Error("authentication_error: network login required"),
      Object.assign(new Error("network request rejected"), { statusCode: 429 }),
      Object.assign(new Error("network request rejected"), { status: 403 }),
      Object.assign(new Error("network request rejected"), { code: "rate_limit_exceeded" }),
    ])("does not replay external account failure %s", async (error) => {
      const manager = freshManager()
      await manager.addAgent(buildBaseConfig({ retryConfig }))
      currentMock.executeImpl = jest.fn(async () => {
        throw error
      })
      await expect(manager.execute("agent-1", "perform work")).rejects.toThrow(error.message)
      expect(currentMock.executeImpl).toHaveBeenCalledTimes(1)
    })

    it("does not let a generic result code hide a quota refusal", async () => {
      const manager = freshManager()
      await manager.addAgent(buildBaseConfig({ retryConfig }))
      const result: ExternalAgentResult = {
        success: false,
        sessionId: "s_1",
        finalResponse: "",
        messages: [],
        steps: [],
        toolCalls: [],
        duration: 1,
        errorCode: "network_error",
        error: "usage limit exceeded",
      }
      currentMock.executeImpl = jest.fn(async () => result)
      expect(await manager.execute("agent-1", "perform work")).toMatchObject(result)
      expect(currentMock.executeImpl).toHaveBeenCalledTimes(1)
    })

    it("does not replay a transient failure result containing completed tools", async () => {
      const manager = freshManager()
      await manager.addAgent(buildBaseConfig({ retryConfig }))
      const result: ExternalAgentResult = {
        success: false,
        sessionId: "s_1",
        finalResponse: "",
        messages: [],
        steps: [],
        duration: 1,
        toolCalls: [
          { id: "edit-1", name: "edit", input: { path: "/work/a" }, status: "completed" },
        ],
        error: "network connection reset after tool execution",
      }
      currentMock.executeImpl = jest.fn(async () => result)
      expect(await manager.execute("agent-1", "perform work")).toMatchObject(result)
      expect(currentMock.executeImpl).toHaveBeenCalledTimes(1)
    })

    it("does not replay after a tool was admitted before the transport failed", async () => {
      const manager = freshManager()
      await manager.addAgent(buildBaseConfig({ retryConfig }))
      const execute = jest
        .spyOn(currentMock, "execute")
        .mockImplementation(async (sessionId, _message, options) => {
          options?.onEvent?.({
            type: "tool_use_start",
            sessionId,
            timestamp: new Date(),
            toolUseId: "edit-1",
            toolName: "edit",
          })
          throw new Error("network connection reset")
        })
      await expect(manager.execute("agent-1", "perform work")).rejects.toThrow(
        "network connection reset"
      )
      expect(execute).toHaveBeenCalledTimes(1)
    })

    it("does not retry other adapter connections after an account refusal", async () => {
      const manager = freshManager()
      await manager.addAgent(buildBaseConfig({ retryConfig }), { connect: false })
      currentMock.connectImpl.mockRejectedValue(new Error("429 Too many requests"))
      await expect(manager.connect("agent-1")).rejects.toThrow("429")
      expect(currentMock.connectImpl).toHaveBeenCalledTimes(1)
    })

    it.each<ExternalAgentEvent>([
      { type: "message_start", timestamp: new Date(), role: "assistant" },
      {
        type: "message_delta",
        timestamp: new Date(),
        delta: { type: "text", text: "Partial answer" },
      },
      { type: "thinking", timestamp: new Date(), thinking: "Working on the answer" },
      { type: "commentary_delta", timestamp: new Date(), text: "Inspecting the file" },
      {
        type: "done",
        timestamp: new Date(),
        success: false,
        tokenUsage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
      },
    ])("does not replay after $type proves generation started", async (event) => {
      const manager = freshManager()
      await manager.addAgent(buildBaseConfig({ retryConfig }))
      const execute = jest
        .spyOn(currentMock, "execute")
        .mockImplementation(async (sessionId, _message, options) => {
          options?.onEvent?.({ ...event, sessionId })
          throw new Error("network connection reset")
        })
      await expect(manager.execute("agent-1", "perform work")).rejects.toThrow(
        "network connection reset"
      )
      expect(execute).toHaveBeenCalledTimes(1)
    })

    it.each<Partial<ExternalAgentResult>>([
      { finalResponse: "Partial answer" },
      {
        messages: [
          {
            id: "answer",
            role: "assistant",
            timestamp: new Date(),
            content: [{ type: "text", text: "Partial answer" }],
          },
        ],
      },
      { output: { partial: true } },
      { tokenUsage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 } },
    ])("does not replay a failed result with output evidence %#", async (evidence) => {
      const manager = freshManager()
      await manager.addAgent(buildBaseConfig({ retryConfig }))
      const result: ExternalAgentResult = {
        success: false,
        sessionId: "s_1",
        finalResponse: "",
        messages: [],
        steps: [],
        toolCalls: [],
        duration: 1,
        error: "network connection reset",
        ...evidence,
      }
      currentMock.executeImpl = jest.fn(async () => result)
      expect(await manager.execute("agent-1", "perform work")).toMatchObject(result)
      expect(currentMock.executeImpl).toHaveBeenCalledTimes(1)
    })
  })

  describe("Codex native turn replay protection", () => {
    const retryConfig = {
      maxRetries: 3,
      retryDelay: 0,
      exponentialBackoff: false,
      maxRetryDelay: 0,
      retryOnErrors: ["cancelled"],
    }

    it.each([
      "Request timeout: turn/start",
      "429 Too many requests",
      "401 Unauthorized: connection rejected",
      "403 Forbidden: network access rejected",
      "Codex app-server process exited with code 9",
      "External agent execution was cancelled",
    ])("does not replay a native turn after %s", async (message) => {
      const manager = freshManager()
      protocolAdapterRegistry.register("codex-app-server", () => currentMock as never)
      await manager.addAgent(buildBaseConfig({ protocol: "codex-app-server", retryConfig }))
      currentMock.executeImpl = jest.fn(async () => {
        throw new Error(message)
      })

      await expect(manager.execute("agent-1", "perform work")).rejects.toThrow(message)
      expect(currentMock.executeImpl).toHaveBeenCalledTimes(1)
    })

    it("does not replay a failed native result after tools have already run", async () => {
      const manager = freshManager()
      protocolAdapterRegistry.register("codex-app-server", () => currentMock as never)
      await manager.addAgent(buildBaseConfig({ protocol: "codex-app-server", retryConfig }))
      const failed: ExternalAgentResult = {
        success: false,
        sessionId: "s_1",
        finalResponse: "",
        error: "Connection reset after tool execution",
        errorCode: "http_connection_failed",
        messages: [],
        steps: [],
        toolCalls: [
          { id: "edit-1", name: "edit", input: { path: "/work/a" }, status: "completed" },
        ],
        duration: 1,
      }
      currentMock.executeImpl = jest.fn(async () => failed)

      expect(await manager.execute("agent-1", "perform work")).toMatchObject(failed)
      expect(currentMock.executeImpl).toHaveBeenCalledTimes(1)
    })

    it("preserves the configured retry behavior for other adapters", async () => {
      const manager = freshManager()
      await manager.addAgent(buildBaseConfig({ retryConfig }))
      currentMock.executeImpl = jest.fn(async () => ({
        success: true,
        sessionId: "s_1",
        finalResponse: "ok",
        messages: [],
        steps: [],
        toolCalls: [],
        duration: 1,
      }))
      currentMock.executeImpl.mockRejectedValueOnce(new Error("temporary network error"))

      expect(await manager.execute("agent-1", "perform work")).toMatchObject({ success: true })
      expect(currentMock.executeImpl).toHaveBeenCalledTimes(2)
    })
  })

  it("execute increments stats and returns the result", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    const result = await m.execute("agent-1", "hi")
    expect(result.success).toBe(true)
    expect(m.getAgent("agent-1")?.stats.successfulExecutions).toBe(1)
  })

  it("adapts the requested permission mode to what the backend can enforce", async () => {
    const m = freshManager()
    protocolAdapterRegistry.register("codex-app-server", () => currentMock as never)
    await m.addAgent(buildBaseConfig({ protocol: "codex-app-server" }))
    // Codex has no `dontAsk`; the manager clamps it down to `plan` before
    // forwarding to the adapter so the session runs under an enforceable mode.
    await m.execute("agent-1", "hi", { permissionMode: "dontAsk" })
    expect(currentMock.setSessionModeImpl).toHaveBeenCalledWith("s_1", "plan")
  })

  it("passes a backend-supported permission mode through unchanged", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig({ protocol: "acp" }))
    await m.execute("agent-1", "hi", { permissionMode: "bypassPermissions" })
    expect(currentMock.setSessionModeImpl).toHaveBeenCalledWith("s_1", "bypassPermissions")
  })

  it.each(["execute", "streaming"])(
    "%s applies the configured permission default when the caller omits a mode",
    async (execution) => {
      const manager = freshManager()
      await manager.addAgent(buildBaseConfig({ defaultPermissionMode: "plan" }))
      if (execution === "streaming") {
        for await (const event of manager.executeStreaming("agent-1", "hi")) void event
      } else {
        await manager.execute("agent-1", "hi")
      }
      expect(currentMock.lastSessionOptions?.permissionMode).toBe("plan")
      expect(currentMock.setSessionModeImpl).toHaveBeenCalledWith("s_1", "plan")
    }
  )

  it("lets an explicit execution mode override the configured default", async () => {
    const manager = freshManager()
    await manager.addAgent(buildBaseConfig({ defaultPermissionMode: "plan" }))
    await manager.execute("agent-1", "hi", { permissionMode: "acceptEdits" })
    expect(currentMock.lastSessionOptions?.permissionMode).toBe("acceptEdits")
    expect(currentMock.setSessionModeImpl).toHaveBeenCalledWith("s_1", "acceptEdits")
  })

  it("applies default approval mode over an agent's native permissive initial mode", async () => {
    const manager = freshManager()
    await manager.addAgent(buildBaseConfig({ defaultPermissionMode: "default" }))
    const createSession = currentMock.createSession.bind(currentMock)
    jest.spyOn(currentMock, "createSession").mockImplementation(async (options) => {
      const session = await createSession(options)
      session.permissionMode = "acceptEdits"
      return session
    })
    await manager.execute("agent-1", "hi")
    expect(currentMock.setSessionModeImpl).toHaveBeenCalledWith("s_1", "default")
  })

  it("execute records failure and last error when result.success is false", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    currentMock.executeImpl = jest.fn(async () => ({
      success: false,
      sessionId: "s_1",
      finalResponse: "",
      messages: [],
      steps: [],
      toolCalls: [],
      duration: 5,
      error: "execution rejected",
    }))
    const result = await m.execute("agent-1", "hi")
    expect(result.success).toBe(false)
    expect(m.getAgent("agent-1")?.stats.failedExecutions).toBe(1)
  })

  it("execute throws if the agent does not exist", async () => {
    const m = freshManager()
    await expect(m.execute("ghost", "hi")).rejects.toThrow(/not found/)
  })

  it("cancel forwards to the adapter and emits a status update", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    await m.cancel("agent-1", "s_1")
    expect(currentMock.cancelImpl).toHaveBeenCalledWith("s_1")
  })

  it("cancel is a no-op for missing agents", async () => {
    const m = freshManager()
    await expect(m.cancel("ghost", "s_1")).resolves.toBeUndefined()
  })
})

describe("executeStreaming", () => {
  beforeEach(() => appendCanonicalEnvelopesMock.mockClear())

  it("persists each external event through the redacted canonical envelope log", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    currentMock.events = [
      {
        type: "message_delta",
        delta: { type: "text", text: "alice@example.com" },
        timestamp: new Date(),
      },
    ]

    for await (const _event of m.executeStreaming("agent-1", "hi")) {
      // drain
    }

    expect(appendCanonicalEnvelopesMock).toHaveBeenCalledTimes(1)
    const envelope = appendCanonicalEnvelopesMock.mock.calls[0][1][0]
    expect(envelope.event.kind).toBe("text-delta")
    expect(JSON.stringify(envelope.event)).not.toContain("alice@example.com")
  })
  it("yields events from the adapter and updates stats", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    currentMock.events = [
      {
        type: "message_delta",
        messageId: "m",
        delta: { type: "text", text: "hello" },
        timestamp: new Date(),
      },
      { type: "done", success: true, timestamp: new Date() },
    ] as ExternalAgentEvent[]

    const events: ExternalAgentEvent[] = []
    for await (const ev of m.executeStreaming("agent-1", "hi")) {
      events.push(ev)
    }
    expect(events.length).toBe(2)
    expect(m.getAgent("agent-1")?.stats.successfulExecutions).toBe(1)
  })

  it("captures error events in streaming", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    currentMock.events = [
      { type: "error", error: "boom", timestamp: new Date() },
      { type: "done", success: false, timestamp: new Date() },
    ] as ExternalAgentEvent[]
    const events: ExternalAgentEvent[] = []
    for await (const ev of m.executeStreaming("agent-1", "hi")) events.push(ev)
    expect(m.getAgent("agent-1")?.stats.failedExecutions).toBe(1)
    expect(m.getAgent("agent-1")?.lastError).toMatch(/boom/i)
  })
})

describe("Tool integration helpers", () => {
  it("getAgentTools returns prefixed external_ tools", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    const tools = m.getAgentTools("agent-1")
    expect(Object.keys(tools)[0]).toBe("external_echo")
  })

  it("getAgentTools returns empty object for unknown agents", async () => {
    const m = freshManager()
    expect(m.getAgentTools("ghost")).toEqual({})
  })

  it("getAllAgentTools prefixes by agent id", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    const all = m.getAllAgentTools()
    expect(Object.keys(all)[0]).toMatch(/^agent-1:external_echo$/)
  })
})

describe("Delegation rules", () => {
  async function setup() {
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    return m
  }

  it("checkDelegation returns no-match when rules empty", async () => {
    const m = await setup()
    const out = m.checkDelegation("anything")
    expect(out.shouldDelegate).toBe(false)
  })

  it("matches an 'always' rule", async () => {
    const m = await setup()
    m.addDelegationRule({
      id: "r1",
      name: "always",
      enabled: true,
      priority: 1,
      condition: "always",
      matcher: "",
      targetAgentId: "agent-1",
    } as never)
    expect(m.checkDelegation("anything").shouldDelegate).toBe(true)
  })

  it("matches a 'keyword' rule", async () => {
    const m = await setup()
    m.addDelegationRule({
      id: "r2",
      name: "code",
      enabled: true,
      priority: 1,
      condition: "keyword",
      matcher: "fix",
      targetAgentId: "agent-1",
    } as never)
    expect(m.checkDelegation("please fix this").shouldDelegate).toBe(true)
    expect(m.checkDelegation("review this").shouldDelegate).toBe(false)
  })

  it("matches a task-type rule", async () => {
    const m = await setup()
    m.addDelegationRule({
      id: "r3",
      name: "coding",
      enabled: true,
      priority: 1,
      condition: "task-type",
      matcher: "coding",
      targetAgentId: "agent-1",
    } as never)
    expect(m.checkDelegation("please implement a function").shouldDelegate).toBe(true)
    expect(m.checkDelegation("hello").shouldDelegate).toBe(false)
  })

  it("matches a capability rule", async () => {
    const m = await setup()
    m.addDelegationRule({
      id: "r4",
      name: "cap",
      enabled: true,
      priority: 1,
      condition: "capability",
      matcher: "mock",
      targetAgentId: "agent-1",
    } as never)
    expect(m.checkDelegation("anything").shouldDelegate).toBe(true)
  })

  it("matches a 'custom' rule via a plain-regex matcher (backward compatible)", async () => {
    const m = await setup()
    m.addDelegationRule({
      id: "rc1",
      name: "custom-regex",
      enabled: true,
      priority: 1,
      condition: "custom",
      matcher: "deploy|release",
      targetAgentId: "agent-1",
    } as never)
    expect(m.checkDelegation("time to deploy").shouldDelegate).toBe(true)
    expect(m.checkDelegation("just chatting").shouldDelegate).toBe(false)
  })

  it("matches a 'custom' rule via a structured all/any/not spec", async () => {
    const m = await setup()
    m.addDelegationRule({
      id: "rc2",
      name: "custom-structured",
      enabled: true,
      priority: 1,
      condition: "custom",
      matcher: JSON.stringify({
        all: [{ contains: ["migrate", "migration"] }, { not: { regex: "rollback" } }],
      }),
      targetAgentId: "agent-1",
    } as never)
    expect(m.checkDelegation("please migrate the schema").shouldDelegate).toBe(true)
    expect(m.checkDelegation("migrate then rollback").shouldDelegate).toBe(false)
    expect(m.checkDelegation("unrelated task").shouldDelegate).toBe(false)
  })

  it("a malformed 'custom' spec never matches (no throw)", async () => {
    const m = await setup()
    m.addDelegationRule({
      id: "rc3",
      name: "custom-bad",
      enabled: true,
      priority: 1,
      condition: "custom",
      matcher: "{ not valid json",
      targetAgentId: "agent-1",
    } as never)
    expect(() => m.checkDelegation("anything")).not.toThrow()
    expect(m.checkDelegation("anything").shouldDelegate).toBe(false)
  })

  it("matches a tool-needed rule", async () => {
    const m = await setup()
    m.addDelegationRule({
      id: "r5",
      name: "tool",
      enabled: true,
      priority: 1,
      condition: "tool-needed",
      matcher: "echo",
      targetAgentId: "agent-1",
    } as never)
    expect(m.checkDelegation("please echo hello").shouldDelegate).toBe(true)
    expect(m.checkDelegation("nothing").shouldDelegate).toBe(false)
  })

  it("matches a custom rule via regex", async () => {
    const m = await setup()
    m.addDelegationRule({
      id: "r6",
      name: "custom",
      enabled: true,
      priority: 1,
      condition: "custom",
      matcher: "review",
      targetAgentId: "agent-1",
    } as never)
    expect(m.checkDelegation("please review").shouldDelegate).toBe(true)
  })

  it("ignores disabled rules and disconnected target agents", async () => {
    const m = await setup()
    m.addDelegationRule({
      id: "r7",
      name: "disabled",
      enabled: false,
      priority: 1,
      condition: "always",
      matcher: "",
      targetAgentId: "agent-1",
    } as never)
    expect(m.checkDelegation("anything").shouldDelegate).toBe(false)
  })

  it("removeDelegationRule clears the rule", async () => {
    const m = await setup()
    m.addDelegationRule({
      id: "r8",
      name: "to-remove",
      enabled: true,
      priority: 1,
      condition: "always",
      matcher: "",
      targetAgentId: "agent-1",
    } as never)
    m.removeDelegationRule("r8")
    expect(m.checkDelegation("x").shouldDelegate).toBe(false)
  })
})

describe("Lifecycle and event listeners", () => {
  it("addLifecycleListener fires on state changes and unsubscribe stops the firing", async () => {
    const m = freshManager()
    const events: unknown[] = []
    const off = m.addLifecycleListener((e) => events.push(e))
    await m.addAgent(buildBaseConfig())
    expect(events.length).toBeGreaterThan(0)
    off()
    const sizeBefore = events.length
    await m.disconnect("agent-1")
    expect(events.length).toBe(sizeBefore)
  })

  it("addEventListener fires on stream events", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    currentMock.events = [
      { type: "done", success: true, timestamp: new Date() },
    ] as ExternalAgentEvent[]
    const events: ExternalAgentEvent[] = []
    const off = m.addEventListener("agent-1", (e) => events.push(e))
    for await (const _ of m.executeStreaming("agent-1", "hi")) {
      // drain
    }
    expect(events.length).toBeGreaterThan(0)
    off()
  })
})

describe("Health checks", () => {
  it("does not restart a reconnect budget after health recovery exhausts it", async () => {
    const manager = freshManager()
    await manager.addAgent(
      buildBaseConfig({
        retryConfig: {
          maxRetries: 1,
          retryDelay: 0,
          exponentialBackoff: false,
          maxRetryDelay: 0,
          retryOnErrors: [],
        },
      })
    )
    jest.spyOn(currentMock, "healthCheck").mockResolvedValue(false)
    currentMock.connectImpl.mockClear()
    currentMock.connectImpl.mockRejectedValue(new Error("connection refused"))
    await manager.performHealthCheck().catch(() => undefined)
    expect(currentMock.connectImpl).toHaveBeenCalledTimes(2)
  })

  it("checkAgentHealth flips healthStatus", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    expect(await m.checkAgentHealth("agent-1")).toBe(true)
  })

  it("checkAgentHealth returns false on unknown adapter", async () => {
    const m = freshManager()
    expect(await m.checkAgentHealth("ghost")).toBe(false)
  })

  it("performHealthCheck iterates all connected agents", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    await m.performHealthCheck()
    expect(m.getAgent("agent-1")?.validity?.healthStatus).toBe("healthy")
  })
})

describe("Query helpers", () => {
  it("returns all agents and filters by status", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    expect(m.getAllAgents()).toHaveLength(1)
    expect(m.getAgentsByStatus("connected")).toHaveLength(1)
    expect(m.getAgentCapabilities("agent-1")).toBeDefined()
    expect(m.getAgentToolInfo("agent-1")).toBeDefined()
  })
})

describe("Convenience functions", () => {
  it("checkExternalAgentDelegation routes through the singleton", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    m.addDelegationRule({
      id: "rfn",
      name: "always",
      enabled: true,
      priority: 1,
      condition: "always",
      matcher: "",
      targetAgentId: "agent-1",
    } as never)
    expect(checkExternalAgentDelegation("hi").shouldDelegate).toBe(true)
  })

  it("executeOnExternalAgent honors agentId", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    const result = await executeOnExternalAgent("hi", { agentId: "agent-1" })
    expect(result?.success).toBe(true)
  })

  it("executeOnExternalAgent returns null when no rules match and no agentId", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    expect(await executeOnExternalAgent("anything")).toBeNull()
  })

  it("executeOnExternalAgent invokes the matched agent", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    m.addDelegationRule({
      id: "rfn",
      name: "always",
      enabled: true,
      priority: 1,
      condition: "always",
      matcher: "",
      targetAgentId: "agent-1",
    } as never)
    const result = await executeOnExternalAgent("hi")
    expect(result?.success).toBe(true)
  })
})

describe("lastRunSnapshot recording (Workstream D)", () => {
  it("records an ok/external snapshot after a successful execute", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    await m.execute("agent-1", "hi")
    const snap = m.getAgent("agent-1")?.lastRunSnapshot
    expect(snap?.terminalOutcome).toBe("ok")
    expect(snap?.branchOutcome).toBe("external")
    expect(snap?.branchReasonCode).toBe("ok")
    expect(snap?.timestamp).toBeInstanceOf(Date)
  })

  it("records an error/fallback snapshot when execute returns success:false", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    currentMock.executeImpl = jest.fn(async () => ({
      success: false,
      sessionId: "s_1",
      finalResponse: "",
      messages: [],
      steps: [],
      toolCalls: [],
      duration: 5,
      error: "execution rejected",
    }))
    await m.execute("agent-1", "hi")
    const snap = m.getAgent("agent-1")?.lastRunSnapshot
    expect(snap?.terminalOutcome).toBe("error")
    expect(snap?.branchOutcome).toBe("fallback")
    expect(snap?.diagnosticText).toMatch(/execution rejected/)
  })

  it("records an error/fallback snapshot when execute throws (execution_failed arm)", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    currentMock.executeImpl = jest.fn(async () => {
      throw new Error("adapter exploded")
    })
    await expect(m.execute("agent-1", "hi")).rejects.toThrow(/adapter exploded/)
    const snap = m.getAgent("agent-1")?.lastRunSnapshot
    expect(snap?.terminalOutcome).toBe("error")
    expect(snap?.branchReasonCode).toBe("execution_failed")
    expect(snap?.branchOutcome).toBe("fallback")
    expect(snap?.diagnosticText).toMatch(/adapter exploded/)
  })

  it("records external_unavailable on the timeout arm of the execute catch", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    currentMock.executeImpl = jest.fn(async () => {
      throw new Error("operation timed out")
    })
    await expect(m.execute("agent-1", "hi")).rejects.toThrow(/timed out/)
    const snap = m.getAgent("agent-1")?.lastRunSnapshot
    expect(snap?.terminalOutcome).toBe("error")
    expect(snap?.branchReasonCode).toBe("external_unavailable")
  })

  it("records an ok snapshot after a successful streaming run", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    currentMock.events = [
      { type: "done", success: true, timestamp: new Date() },
    ] as ExternalAgentEvent[]
    for await (const _ev of m.executeStreaming("agent-1", "hi")) {
      void _ev
    }
    expect(m.getAgent("agent-1")?.lastRunSnapshot?.terminalOutcome).toBe("ok")
  })

  it("emits the snapshot on the lifecycle event so the store bridge can persist it", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    const withSnapshot: ExternalAgentLifecycleEvent[] = []
    const unsubscribe = m.addLifecycleListener((event) => {
      if (event.lastRunSnapshot) withSnapshot.push(event)
    })
    await m.execute("agent-1", "hi")
    unsubscribe()
    expect(withSnapshot.length).toBeGreaterThan(0)
    expect(withSnapshot.at(-1)?.lastRunSnapshot?.terminalOutcome).toBe("ok")
  })
})

describe("plugin lifecycle — teardown / restore / peekInstance", () => {
  const PLUGIN_PROTOCOL = "plug:demo"

  async function addPluginAgent(m: ExternalAgentManager) {
    protocolAdapterRegistry.register(PLUGIN_PROTOCOL, () => currentMock as never)
    await m.addAgent(buildBaseConfig({ id: "p-agent", protocol: PLUGIN_PROTOCOL as never }))
  }

  it("teardownAgentsByProtocols disconnects, drops the adapter, keeps a blocked instance", async () => {
    const m = freshManager()
    await addPluginAgent(m)
    expect(m.getAgent("p-agent")?.connectionStatus).toBe("connected")

    const affected = await m.teardownAgentsByProtocols([PLUGIN_PROTOCOL])
    expect(affected).toEqual(["p-agent"])

    const inst = m.getAgent("p-agent")
    expect(inst).toBeDefined() // instance kept for restore + UI explanation
    expect(inst?.connectionStatus).toBe("disconnected")
    expect(inst?.validity?.executable).toBe(false)
    // Adapter dropped → ACP helpers that resolve by agent now report "not found".
    await expect(
      m.respondToPermission("p-agent", "s", {} as AcpPermissionResponse)
    ).rejects.toThrow(/not found/i)
  })

  it("ignores agents on other protocols", async () => {
    const m = freshManager()
    await addPluginAgent(m)
    const affected = await m.teardownAgentsByProtocols(["other:thing"])
    expect(affected).toEqual([])
    expect(m.getAgent("p-agent")?.connectionStatus).toBe("connected")
  })

  it("restoreAgentsForProtocols recreates the adapter and clears the block", async () => {
    const m = freshManager()
    await addPluginAgent(m)
    await m.teardownAgentsByProtocols([PLUGIN_PROTOCOL])

    const restored = m.restoreAgentsForProtocols([PLUGIN_PROTOCOL])
    expect(restored).toEqual(["p-agent"])

    const inst = m.getAgent("p-agent")
    expect(inst?.validity?.executable).toBe(true)
    expect(inst?.connectionStatus).toBe("disconnected")
    // Adapter present again → the helper resolves instead of throwing not-found.
    await expect(
      m.respondToPermission("p-agent", "s", {} as AcpPermissionResponse)
    ).resolves.toBeUndefined()
  })

  it("restore skips agents whose adapter is still present", async () => {
    const m = freshManager()
    await addPluginAgent(m)
    expect(m.restoreAgentsForProtocols([PLUGIN_PROTOCOL])).toEqual([])
  })

  it("teardown and restore are no-ops for an empty protocol set", async () => {
    const m = freshManager()
    await addPluginAgent(m)
    expect(await m.teardownAgentsByProtocols([])).toEqual([])
    expect(m.restoreAgentsForProtocols([])).toEqual([])
    expect(m.getAgent("p-agent")?.connectionStatus).toBe("connected")
  })

  it("peekInstance returns null with no manager and the live instance otherwise", () => {
    ExternalAgentManager.resetInstance()
    expect(ExternalAgentManager.peekInstance()).toBeNull()
    const m = freshManager()
    expect(ExternalAgentManager.peekInstance()).toBe(m)
  })
})

describe("Cognia gateway task lifecycle", () => {
  const binding = { providerId: "provider", modelId: "model", accountId: "account-one" }
  const managedConfig = () =>
    buildBaseConfig({
      id: "managed",
      transport: "stdio",
      protocol: "acp",
      process: { command: "opencode", cwd: "/workspace" },
      metadata: { preset: "opencode-acp" },
      cogniaModel: binding,
    })
  function prepare() {
    jest.mocked(checkExternalAgentCommandExists).mockReset().mockResolvedValue(true)
    const restorePlane = __setProcessPlaneDepsForTests({ hasLocalProcessTable: () => true })
    const manager = freshManager()
    const children: MockAdapter[] = []
    protocolAdapterRegistry.register("acp", () => {
      const adapter = new MockAdapter()
      children.push(adapter)
      return adapter as never
    })
    mockGatewayMint.mockImplementation(async () => ({
      endpoint: "http://127.0.0.1:9900/v1",
      secret: "lease-secret",
      ticketId: `ticket-${mockGatewayMint.mock.calls.length}`,
      model: "model",
      binding,
      modelMetadata: { id: "model", contextLength: 128000, maxOutputTokens: 8000 },
    }))
    return { manager, children, restorePlane }
  }

  it("never connects the saved configuration, isolates a task, revokes its lease and resumes the same native session", async () => {
    const { manager, children, restorePlane } = prepare()
    try {
      await manager.addAgent(managedConfig())
      expect(children[0].connectImpl).not.toHaveBeenCalled()
      const first = await manager.execute("managed", "first", {
        context: { custom: { chatSessionId: "chat-one" } },
      })
      expect(first.success).toBe(true)
      const parsed = parseGatewaySessionId(first.sessionId)!
      expect(parsed.binding).toEqual(binding)
      expect(mockGatewayRevoke).toHaveBeenCalledWith("ticket-1")
      expect(children[1].isConnected()).toBe(false)
      expect(manager.resolveConversationSessionId("managed", "chat-one")).toBe(first.sessionId)
      const resume = new MockAdapter()
      resume.resumeSessionImpl = jest.fn(async (id) => {
        const session = await resume.createSession()
        resume.sessions.delete(session.id)
        session.id = id
        resume.sessions.set(id, session)
        return session
      })
      protocolAdapterRegistry.register("acp", () => resume as never)
      const second = await manager.execute("managed", "second", { sessionId: first.sessionId })
      expect(second.sessionId).toBe(first.sessionId)
      expect(resume.resumeSessionImpl).toHaveBeenCalledWith(parsed.nativeSessionId)
      expect(mockGatewayMint.mock.calls[1][0]).toMatchObject({
        sessionId: parsed.taskId,
        ...binding,
      })
      expect(mockGatewayRevoke).toHaveBeenCalledTimes(2)
    } finally {
      restorePlane()
    }
  })

  it.each([false, true])(
    "continues SDK gateway tasks with preserved Cognia history (stream=%s)",
    async (stream) => {
      const { manager, restorePlane } = prepare()
      const children: MockAdapter[] = []
      protocolAdapterRegistry.register("dsh-sdk", () => {
        const adapter = new MockAdapter()
        adapter.events = [
          {
            type: "message_delta",
            sessionId: "s_1",
            timestamp: new Date(),
            delta: { type: "text", text: "ok" },
          },
        ]
        children.push(adapter)
        return adapter as never
      })
      try {
        await manager.addAgent({
          ...managedConfig(),
          protocol: "dsh-sdk",
          process: { command: "", cwd: "/workspace" },
          metadata: { preset: "deepseek-harness-readonly", dshProfileId: "cognia-sdk-readonly" },
        })
        let first: { sessionId: string }
        if (stream) {
          let sessionId = ""
          for await (const event of manager.executeStreaming(
            "managed",
            "Remember the release plan"
          )) {
            if (event.sessionId) sessionId = event.sessionId
          }
          first = { sessionId }
        } else first = await manager.execute("managed", "Remember the release plan")
        const second = await manager.execute("managed", "Continue it", {
          sessionId: first.sessionId,
        })
        expect(second.success).toBe(true)
        expect(children).toHaveLength(3)
        expect(children[2].lastSessionOptions?.context).toMatchObject({
          custom: {
            conversationHistory: "User: Remember the release plan\n\nAssistant: ok",
            sessionId: undefined,
          },
        })
        expect(parseGatewaySessionId(second.sessionId)?.taskId).toBe(
          parseGatewaySessionId(first.sessionId)?.taskId
        )
        expect(mockGatewayRevoke).toHaveBeenCalledTimes(2)
        await manager.closeSession("managed", second.sessionId)
        await expect(
          manager.execute("managed", "Restore", { sessionId: second.sessionId })
        ).rejects.toThrow("preserved Cognia conversation transcript")
        await expect(
          manager.execute("managed", "Restore", {
            sessionId: second.sessionId,
            context: { custom: { conversationHistory: "Prior persisted Cognia transcript" } },
          })
        ).resolves.toMatchObject({ success: true })
      } finally {
        restorePlane()
      }
    }
  )

  it("awaits the same teardown when abort and task cleanup race", async () => {
    const { manager, children, restorePlane } = prepare()
    try {
      await manager.addAgent(managedConfig())
      const controller = new AbortController()
      const lease = await (
        manager as unknown as {
          prepareGatewayExecution(
            id: string,
            options: { signal: AbortSignal }
          ): Promise<{ release(): Promise<void> }>
        }
      ).prepareGatewayExecution("managed", { signal: controller.signal })
      let finishDisconnect!: () => void
      const disconnect = jest.spyOn(children[1], "disconnect").mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finishDisconnect = resolve
          })
      )
      controller.abort()
      let cleaned = false
      const cleanup = lease.release().then(() => {
        cleaned = true
      })
      for (let i = 0; i < 10 && !finishDisconnect; i++) await Promise.resolve()
      expect(disconnect).toHaveBeenCalledTimes(1)
      expect(cleaned).toBe(false)
      finishDisconnect()
      await cleanup
      expect(mockGatewayRevoke).toHaveBeenCalledTimes(1)
    } finally {
      restorePlane()
    }
  })

  it("retries failed teardown before allowing task deletion", async () => {
    const { manager, children, restorePlane } = prepare()
    try {
      await manager.addAgent(managedConfig())
      const lease = await (
        manager as unknown as {
          prepareGatewayExecution(id: string): Promise<{ release(): Promise<void> }>
        }
      ).prepareGatewayExecution("managed")
      const disconnect = jest
        .spyOn(children[1], "disconnect")
        .mockRejectedValueOnce(new Error("stop failed"))
      await expect(lease.release()).rejects.toThrow("stop failed")
      await lease.release()
      expect(disconnect).toHaveBeenCalledTimes(2)
    } finally {
      restorePlane()
    }
  })

  it("allows an explicit native-model opt-out for a new task", async () => {
    const { manager, children, restorePlane } = prepare()
    try {
      await manager.addAgent(managedConfig())
      await manager.execute("managed", "native", { cogniaModel: null })
      expect(children[0].connectImpl).toHaveBeenCalledTimes(1)
      expect(mockGatewayMint).not.toHaveBeenCalled()
    } finally {
      restorePlane()
    }
  })

  it("fails closed when minting or native resume fails", async () => {
    const { manager, children, restorePlane } = prepare()
    try {
      await manager.addAgent(managedConfig())
      mockGatewayMint.mockRejectedValueOnce(new Error("gateway offline"))
      await expect(manager.execute("managed", "hello")).rejects.toThrow("gateway offline")
      expect(children).toHaveLength(1)
      const first = await manager.execute("managed", "hello")
      protocolAdapterRegistry.register("acp", () => new MockAdapter() as never)
      await expect(
        manager.execute("managed", "resume", { sessionId: first.sessionId })
      ).rejects.toThrow("could not resume")
      expect(mockGatewayRevoke).toHaveBeenCalledTimes(2)
    } finally {
      restorePlane()
    }
  })

  it("reserves a resumed task before awaiting a new lease", async () => {
    const { manager, restorePlane } = prepare()
    try {
      await manager.addAgent(managedConfig())
      const first = await manager.execute("managed", "hello")
      let finish!: (value: unknown) => void
      mockGatewayMint.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          })
      )
      const resumed = manager.execute("managed", "resume", { sessionId: first.sessionId })
      await Promise.resolve()
      await expect(
        manager.execute("managed", "duplicate", { sessionId: first.sessionId })
      ).rejects.toThrow("active run")
      finish({
        endpoint: "http://127.0.0.1:9900/v1",
        secret: "new-lease",
        ticketId: "resumed",
        model: "model",
        binding,
        modelMetadata: { id: "model" },
      })
      await expect(resumed).rejects.toThrow("could not resume")
      expect(mockGatewayRevoke).toHaveBeenCalledWith("resumed")
    } finally {
      restorePlane()
    }
  })
})

describe("Devin ACP adapter selection", () => {
  it("isolates built-in native Devin while preserving custom registered adapters", () => {
    protocolAdapterRegistry.register("acp", () => new AcpClientAdapter())
    const config = buildBaseConfig({
      transport: "stdio",
      process: { command: "/usr/local/bin/devin", args: ["acp"] },
    })
    expect(createConfiguredProtocolAdapter(config)).toBeInstanceOf(DevinAcpAdapter)
    expect(createConfiguredProtocolAdapter({ ...config, transport: "http" })).toBeInstanceOf(
      AcpClientAdapter
    )
    expect(
      createConfiguredProtocolAdapter({ ...config, process: { command: "other" } })
    ).toBeInstanceOf(AcpClientAdapter)
    const custom = new MockAdapter()
    protocolAdapterRegistry.register("acp", () => custom as never)
    expect(createConfiguredProtocolAdapter(config)).toBe(custom)
  })
})

it("retires only the exited Devin process and resumes stale preferred sessions independently", async () => {
  const restorePlane = __setProcessPlaneDepsForTests({ hasLocalProcessTable: () => true })
  try {
    const manager = freshManager()
    const discovery = new MockAdapter()
    const children: MockAdapter[] = []
    const wrapper = new DevinAcpAdapter(discovery as unknown as AcpClientAdapter, () => {
      const child = new MockAdapter()
      const id = `devin-session-${children.length}`
      child.createSession = jest.fn(async () => {
        const session: ExternalAgentSession = {
          id,
          agentId: "agent-1",
          status: "active",
          createdAt: new Date(),
          lastActivityAt: new Date(),
        }
        child.sessions.set(id, session)
        return session
      })
      child.resumeSessionImpl = jest.fn(async (sessionId) => {
        const session: ExternalAgentSession = {
          id: sessionId,
          agentId: "agent-1",
          status: "active",
          createdAt: new Date(),
          lastActivityAt: new Date(),
        }
        child.sessions.set(sessionId, session)
        return session
      })
      child.disconnect = jest.fn(child.disconnect.bind(child))
      children.push(child)
      return child as unknown as AcpClientAdapter
    })
    protocolAdapterRegistry.register("acp", () => wrapper)
    const instance = await manager.addAgent(
      buildBaseConfig({ transport: "stdio", process: { command: "devin", args: ["acp"] } })
    )
    const first = await manager.createSession("agent-1")
    const second = await manager.createSession("agent-1")
    mockProcessExitCb?.({ agentId: "agent-1:devin:1", code: 9 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(instance.sessions.has(first.id)).toBe(false)
    expect(instance.sessions.has(second.id)).toBe(true)
    expect(children[1].disconnect).not.toHaveBeenCalled()
    expect(discovery.connectImpl).toHaveBeenCalledTimes(1)

    // A stale copy may still exist in a caller/cache; live adapter state wins.
    instance.sessions.set(first.id, first)
    await manager.execute("agent-1", "resume", { sessionId: first.id })
    expect(children).toHaveLength(3)
    expect(children[2].resumeSessionImpl).toHaveBeenCalledWith(first.id)
    await manager.performHealthCheck()
    expect(children[1].disconnect).not.toHaveBeenCalled()
    expect(discovery.connectImpl).toHaveBeenCalledTimes(1)
  } finally {
    restorePlane()
  }
})

describe("current OpenCode native client access", () => {
  it("returns only the connected current OpenCode adapter", () => {
    const { OpenCodeV2ClientAdapter } = jest.requireMock("./runtimes/opencode/opencode-v2-client")
    const manager = freshManager()
    const adapter = new OpenCodeV2ClientAdapter()
    const adapters = (manager as unknown as { adapters: Map<string, unknown> }).adapters
    adapters.set("current", adapter)
    adapters.set("other", { protocol: "opencode-v2" })
    expect(manager.getOpenCodeV2Adapter("current")).toBe(adapter)
    expect(manager.getOpenCodeV2Adapter("other")).toBeNull()
    expect(manager.getOpenCodeV2Adapter("missing")).toBeNull()
  })
})
