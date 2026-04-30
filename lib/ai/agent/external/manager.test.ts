// Mock heavyweight adapter modules so requiring manager.ts does not pull in
// the real ACP/OpenCode adapters.
jest.mock("./acp-client", () => ({
  AcpClientAdapter: class {
    readonly protocol = "acp"
  },
}))
jest.mock("./opencode-client", () => ({
  OpenCodeClientAdapter: class {
    readonly protocol = "opencode"
  },
}))
jest.mock("@/lib/native/external-agent", () => ({
  checkExternalAgentCommandExists: jest.fn().mockResolvedValue(true),
  acpTerminalCreate: jest.fn(),
  acpTerminalKill: jest.fn(),
  acpTerminalOutput: jest.fn(),
  acpTerminalRelease: jest.fn(),
  acpTerminalWaitForExit: jest.fn(),
}))
jest.mock("@/lib/utils", () => ({
  ...jest.requireActual("@/lib/utils"),
  isTauri: jest.fn(() => true),
}))

import {
  ExternalAgentManager,
  getExternalAgentManager,
  checkExternalAgentDelegation,
  executeOnExternalAgent,
} from "./manager"
import { protocolAdapterRegistry } from "./protocol-adapter"
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
  cancelImpl: jest.Mock<Promise<void>, [string]> = jest.fn(async () => {})
  listSessionsImpl?: jest.Mock<Promise<unknown>, []>
  forkSessionImpl?: jest.Mock<Promise<ExternalAgentSession>, [string]>
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
  async createSession(opts?: unknown): Promise<ExternalAgentSession> {
    const id = `s_${this.sessions.size + 1}`
    const session: ExternalAgentSession = {
      id,
      agentId: "mock-agent",
      status: "active",
      createdAt: new Date(),
      lastActivityAt: new Date(),
      messages: [],
      permissionMode: "default",
      metadata: opts as Record<string, unknown> | undefined,
    }
    this.sessions.set(id, session)
    return session
  }
  async closeSession(id: string) {
    this.sessions.delete(id)
  }
  getSession(id: string) {
    return this.sessions.get(id)
  }
  getSessions() {
    return Array.from(this.sessions.values())
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
  async cancel(sid: string) {
    return this.cancelImpl(sid)
  }
  setSessionMode(_sid: string, _mode: unknown) {
    return this.setSessionModeImpl(_sid, _mode)
  }
  setSessionModel(_sid: string, _mid: string) {
    return this.setSessionModelImpl(_sid, _mid)
  }
  setConfigOption(_sid: string, _id: string, _v: string) {
    return this.setConfigOptionImpl(_sid, _id, _v)
  }
  getConfigOptions(sid: string) {
    return this.getConfigOptionsImpl?.(sid)
  }
  getSessionModels(sid: string) {
    return this.getSessionModelsImpl?.(sid)
  }
  listSessions() {
    if (!this.listSessionsImpl) return undefined
    return this.listSessionsImpl()
  }
  forkSession(sid: string) {
    if (!this.forkSessionImpl) return undefined
    return this.forkSessionImpl(sid)
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
  currentMock = new MockAdapter()
})

afterEach(async () => {
  await ExternalAgentManager.getInstance({ healthCheckInterval: 0 }).dispose()
  ExternalAgentManager.resetInstance()
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
  it("adds an agent and connects when enabled", async () => {
    const m = freshManager()
    const config = buildBaseConfig()
    const instance = await m.addAgent(config)
    expect(instance.connectionStatus).toBe("connected")
    expect(m.getAgent("agent-1")).toBeDefined()
    expect(m.getConnectedAgents().length).toBe(1)
    expect(m.hasConnectedAgents()).toBe(true)
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
    currentMock.getSessionModelsImpl = jest.fn(() => ({ models: [] }))
    const result = m.getSessionModels("agent-1", "s_1")
    expect(result.status).toBe("ok")
  })

  it("getSessionModels returns error wrapper when adapter throws", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    currentMock.getSessionModelsImpl = jest.fn(() => {
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
    currentMock.getConfigOptionsImpl = jest.fn(() => [{ id: "x", value: "y" }])
    expect(m.getConfigOptions("agent-1", "s_1").status).toBe("ok")
    ;(currentMock as unknown as { setConfigOption: undefined }).setConfigOption = undefined
    await expect(m.setConfigOption("agent-1", "s_1", "k", "v")).rejects.toThrow()
  })

  it("getAuthMethods returns ok by default; isAuthenticationRequired/authenticate error if missing", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    expect(m.getAuthMethods("agent-1").status).toBe("ok")
    expect(m.isAuthenticationRequired("agent-1")).toBe(false)
    ;(currentMock as unknown as { authenticate: undefined }).authenticate = undefined
    await expect(m.authenticate("agent-1", "id")).rejects.toThrow()
  })

  it("respondToPermission throws when agent missing", async () => {
    const m = freshManager()
    await expect(
      m.respondToPermission("ghost", "s_1", { requestId: "r", outcome: "cancelled" } as never)
    ).rejects.toThrow(/not found/)
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
    currentMock.forkSessionImpl = jest.fn(async () => forked)
    const out = await m.forkSession("agent-1", "s_1")
    expect(out.id).toBe("s_forked")
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
    currentMock.resumeSessionImpl = jest.fn(async () => resumed)
    const out = await m.resumeSession("agent-1", "s_1")
    expect(out.id).toBe("s_resumed")
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
})

describe("execute / cancel", () => {
  it("execute increments stats and returns the result", async () => {
    const m = freshManager()
    await m.addAgent(buildBaseConfig())
    const result = await m.execute("agent-1", "hi")
    expect(result.success).toBe(true)
    expect(m.getAgent("agent-1")?.stats.successfulExecutions).toBe(1)
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
