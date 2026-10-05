import {
  BaseProtocolAdapter,
  ProtocolAdapterRegistry,
  protocolAdapterRegistry,
  registerPluginProtocolAdapter,
  unregisterPluginProtocolAdaptersByPlugin,
  getPluginProtocolAdapterOwner,
  getPluginProtocolAdapterProtocols,
  listPluginProtocolAdapters,
  onProtocolAdapterRegistryChange,
  __resetPluginProtocolAdaptersForTesting,
  type ProtocolAdapter,
  type ProtocolAdapterRegistryChange,
  type SessionCreateOptions,
} from "./protocol-adapter"
import type {
  ExternalAgentConfig,
  ExternalAgentSession,
  ExternalAgentMessage,
  ExternalAgentEvent,
  ExternalAgentExecutionOptions,
  AcpPermissionResponse,
} from "@/types/agent/external-agent"

class TestAdapter extends BaseProtocolAdapter {
  readonly protocol = "test"

  events: ExternalAgentEvent[] = []
  permissionRecords: AcpPermissionResponse[] = []
  cancelled: string[] = []
  promptRecords: ExternalAgentMessage[] = []
  shouldThrowInPrompt = false

  async connect(_config: ExternalAgentConfig): Promise<void> {
    this._connectionStatus = "connected"
  }
  async disconnect(): Promise<void> {
    this._connectionStatus = "disconnected"
  }
  async createSession(_options?: SessionCreateOptions): Promise<ExternalAgentSession> {
    const session: ExternalAgentSession = {
      id: this.generateSessionId(),
      agentId: "agent",
      status: "active",
      createdAt: new Date(),
      lastActivityAt: new Date(),
      messages: [],
      permissionMode: "default",
    }
    this._sessions.set(session.id, session)
    return session
  }
  async closeSession(sessionId: string): Promise<void> {
    this._sessions.delete(sessionId)
  }
  async *prompt(
    _sessionId: string,
    message: ExternalAgentMessage,
    _options?: ExternalAgentExecutionOptions
  ): AsyncIterable<ExternalAgentEvent> {
    this.promptRecords.push(message)
    if (this.shouldThrowInPrompt) {
      throw new Error("stream broken")
    }
    for (const event of this.events) {
      yield event
    }
  }
  async respondToPermission(_sessionId: string, response: AcpPermissionResponse): Promise<void> {
    this.permissionRecords.push(response)
  }
  async cancel(sessionId: string): Promise<void> {
    this.cancelled.push(sessionId)
  }
  getCompactionCapability(sessionId: string) {
    return this.getAdvertisedCommandCompactionCapability(sessionId)
  }
  compactSession(sessionId: string, options?: { focus?: string }) {
    return this.compactWithAdvertisedCommand(sessionId, options)
  }
  getProviderUndoCapability(sessionId: string) {
    return this.getAdvertisedProviderUndoCapability(sessionId)
  }
  undoLastProviderChange(sessionId: string) {
    return this.undoWithAdvertisedCommand(sessionId)
  }

  // Expose protected helpers for testing
  publicUpdateSession(sessionId: string, updates: Partial<ExternalAgentSession>) {
    return this.updateSession(sessionId, updates)
  }
  publicGenerateMessageId() {
    return this.generateMessageId()
  }
}
describe("ProtocolAdapterRegistry", () => {
  it("registers, looks up, and unregisters factories", () => {
    const reg = new ProtocolAdapterRegistry()
    reg.register("test", () => new TestAdapter())
    expect(reg.has("test")).toBe(true)
    expect(reg.create("test")).toBeInstanceOf(TestAdapter)
    expect(reg.getProtocols()).toEqual(["test"])
    reg.unregister("test")
    expect(reg.has("test")).toBe(false)
    expect(reg.create("test")).toBeUndefined()
  })

  it("returns undefined for protocols never registered", () => {
    const reg = new ProtocolAdapterRegistry()
    expect(reg.create("missing")).toBeUndefined()
  })

  it("exposes a global registry instance", () => {
    expect(protocolAdapterRegistry).toBeInstanceOf(ProtocolAdapterRegistry)
  })
})

describe("plugin-contributed protocol adapter overlay", () => {
  afterEach(() => {
    __resetPluginProtocolAdaptersForTesting()
  })

  it("registers a plugin adapter into the global registry and tracks the owner", () => {
    const ok = registerPluginProtocolAdapter("p1:demo", () => new TestAdapter(), { pluginId: "p1" })
    expect(ok).toBe(true)
    expect(protocolAdapterRegistry.has("p1:demo")).toBe(true)
    // Created through the core-completing wrapper, under the registered protocol.
    const created = protocolAdapterRegistry.create("p1:demo")
    expect(created?.protocol).toBe("p1:demo")
    expect(created?.isConnected()).toBe(false)
    expect(getPluginProtocolAdapterOwner("p1:demo")).toBe("p1")
    expect(listPluginProtocolAdapters()).toEqual([{ protocol: "p1:demo", pluginId: "p1" }])
  })

  it("re-registering the SAME plugin's protocol replaces it (idempotent re-enable)", () => {
    expect(
      registerPluginProtocolAdapter("p1:demo", () => new TestAdapter(), { pluginId: "p1" })
    ).toBe(true)
    expect(
      registerPluginProtocolAdapter("p1:demo", () => new TestAdapter(), { pluginId: "p1" })
    ).toBe(true)
    expect(listPluginProtocolAdapters()).toHaveLength(1)
  })

  it("refuses to overwrite a built-in or another plugin's protocol", () => {
    // Simulate a host built-in occupying the slot.
    protocolAdapterRegistry.register("acp", () => new TestAdapter())
    expect(registerPluginProtocolAdapter("acp", () => new TestAdapter(), { pluginId: "p1" })).toBe(
      false
    )
    expect(getPluginProtocolAdapterOwner("acp")).toBeUndefined()
    protocolAdapterRegistry.unregister("acp")

    // Another plugin already owns it.
    registerPluginProtocolAdapter("shared:x", () => new TestAdapter(), { pluginId: "p1" })
    expect(
      registerPluginProtocolAdapter("shared:x", () => new TestAdapter(), { pluginId: "p2" })
    ).toBe(false)
    expect(getPluginProtocolAdapterOwner("shared:x")).toBe("p1")
  })

  it("unregisterPluginProtocolAdaptersByPlugin drops exactly that plugin's adapters", () => {
    registerPluginProtocolAdapter("p1:a", () => new TestAdapter(), { pluginId: "p1" })
    registerPluginProtocolAdapter("p1:b", () => new TestAdapter(), { pluginId: "p1" })
    registerPluginProtocolAdapter("p2:c", () => new TestAdapter(), { pluginId: "p2" })

    expect(unregisterPluginProtocolAdaptersByPlugin("p1")).toBe(2)
    expect(protocolAdapterRegistry.has("p1:a")).toBe(false)
    expect(protocolAdapterRegistry.has("p1:b")).toBe(false)
    expect(protocolAdapterRegistry.has("p2:c")).toBe(true)

    __resetPluginProtocolAdaptersForTesting()
    expect(protocolAdapterRegistry.has("p2:c")).toBe(false)
  })
})

describe("plugin overlay — per-plugin protocols + change events", () => {
  afterEach(() => {
    __resetPluginProtocolAdaptersForTesting()
  })

  it("getPluginProtocolAdapterProtocols returns only that plugin's protocols", () => {
    registerPluginProtocolAdapter("p1:a", () => new TestAdapter(), { pluginId: "p1" })
    registerPluginProtocolAdapter("p1:b", () => new TestAdapter(), { pluginId: "p1" })
    registerPluginProtocolAdapter("p2:c", () => new TestAdapter(), { pluginId: "p2" })

    expect(getPluginProtocolAdapterProtocols("p1").sort()).toEqual(["p1:a", "p1:b"])
    expect(getPluginProtocolAdapterProtocols("p2")).toEqual(["p2:c"])
    expect(getPluginProtocolAdapterProtocols("missing")).toEqual([])
  })

  it("emits register/unregister change events with protocols + pluginId", () => {
    const changes: ProtocolAdapterRegistryChange[] = []
    const unsubscribe = onProtocolAdapterRegistryChange((change) => changes.push(change))

    registerPluginProtocolAdapter("p1:a", () => new TestAdapter(), { pluginId: "p1" })
    registerPluginProtocolAdapter("p1:b", () => new TestAdapter(), { pluginId: "p1" })
    expect(changes).toEqual([
      { kind: "register", protocols: ["p1:a"], pluginId: "p1" },
      { kind: "register", protocols: ["p1:b"], pluginId: "p1" },
    ])

    changes.length = 0
    unregisterPluginProtocolAdaptersByPlugin("p1")
    expect(changes).toEqual([{ kind: "unregister", protocols: ["p1:a", "p1:b"], pluginId: "p1" }])

    changes.length = 0
    unsubscribe()
    registerPluginProtocolAdapter("p2:c", () => new TestAdapter(), { pluginId: "p2" })
    expect(changes).toHaveLength(0)
  })

  it("does not emit an empty unregister event when the plugin owns nothing", () => {
    const changes: ProtocolAdapterRegistryChange[] = []
    onProtocolAdapterRegistryChange((change) => changes.push(change))
    expect(unregisterPluginProtocolAdaptersByPlugin("nobody")).toBe(0)
    expect(changes).toHaveLength(0)
  })

  it("a throwing listener never breaks the register/unregister flow", () => {
    const unsubscribe = onProtocolAdapterRegistryChange(() => {
      throw new Error("boom")
    })
    expect(() =>
      registerPluginProtocolAdapter("p1:a", () => new TestAdapter(), { pluginId: "p1" })
    ).not.toThrow()
    expect(protocolAdapterRegistry.has("p1:a")).toBe(true)
    unsubscribe()
  })
})

describe("plugin adapters are read against the adapter core", () => {
  afterEach(() => {
    __resetPluginProtocolAdaptersForTesting()
  })

  it("fails creation when a plugin adapter lacks a member the host cannot supply", () => {
    registerPluginProtocolAdapter(
      "p1:broken",
      () => ({ connect: async () => {} }) as unknown as ProtocolAdapter,
      { pluginId: "p1" }
    )
    expect(() => protocolAdapterRegistry.create("p1:broken")).toThrow(/does not implement/)
  })

  it("supplies the session registry a Python-style proxy does not forward", async () => {
    registerPluginProtocolAdapter(
      "p1:py",
      () =>
        ({
          connect: async () => {},
          disconnect: async () => {},
          createSession: async () => ({ id: "s1", agentId: "a", status: "ready" }),
          closeSession: async () => {},
          prompt: async function* () {},
        }) as unknown as ProtocolAdapter,
      { pluginId: "p1" }
    )
    const adapter = protocolAdapterRegistry.create("p1:py")!
    await adapter.createSession()
    expect(adapter.getSessions().map((session) => session.id)).toEqual(["s1"])
    await expect(adapter.cancel("s1")).rejects.toThrow(/does not support cancel/)
  })
})
