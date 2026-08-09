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

describe("BaseProtocolAdapter — basic accessors", () => {
  it("does not opt every subclass into provider commands implicitly", () => {
    expect(BaseProtocolAdapter.prototype).not.toHaveProperty("getCompactionCapability")
    expect(BaseProtocolAdapter.prototype).not.toHaveProperty("compactSession")
    expect(BaseProtocolAdapter.prototype).not.toHaveProperty("getProviderUndoCapability")
    expect(BaseProtocolAdapter.prototype).not.toHaveProperty("undoLastProviderChange")
  })

  it("starts in disconnected state and reports it", () => {
    const a = new TestAdapter()
    expect(a.connectionStatus).toBe("disconnected")
    expect(a.isConnected()).toBe(false)
    expect(a.capabilities).toBeUndefined()
    expect(a.tools).toBeUndefined()
  })

  it("connects and reports connected", async () => {
    const a = new TestAdapter()
    await a.connect({ id: "x" } as ExternalAgentConfig)
    expect(a.isConnected()).toBe(true)
    expect(a.connectionStatus).toBe("connected")
  })

  it("healthCheck reflects connection status", async () => {
    const a = new TestAdapter()
    expect(await a.healthCheck()).toBe(false)
    await a.connect({ id: "x" } as ExternalAgentConfig)
    expect(await a.healthCheck()).toBe(true)
  })

  it("createSession registers the session and getSession/getSessions return it", async () => {
    const a = new TestAdapter()
    const s = await a.createSession()
    expect(a.getSession(s.id)?.id).toBe(s.id)
    expect(a.getSessions()).toHaveLength(1)
  })

  it("closeSession removes the session", async () => {
    const a = new TestAdapter()
    const s = await a.createSession()
    await a.closeSession(s.id)
    expect(a.getSession(s.id)).toBeUndefined()
  })

  it("generateSessionId / generateMessageId produce unique-ish ids", () => {
    const a = new TestAdapter()
    const m1 = a.publicGenerateMessageId()
    const m2 = a.publicGenerateMessageId()
    expect(m1).not.toBe(m2)
    expect(m1).toMatch(/^msg_/)
  })

  it("updateSession patches the session map and returns the merged value", async () => {
    const a = new TestAdapter()
    const s = await a.createSession()
    const updated = a.publicUpdateSession(s.id, { permissionMode: "plan" })
    expect(updated?.permissionMode).toBe("plan")
    expect(a.getSession(s.id)?.permissionMode).toBe("plan")
  })

  it("updateSession returns undefined for a missing session", async () => {
    const a = new TestAdapter()
    expect(a.publicUpdateSession("missing", { permissionMode: "plan" })).toBeUndefined()
  })
})

describe("BaseProtocolAdapter session commands", () => {
  it("executes an advertised compact command and preserves optional focus", async () => {
    const adapter = new TestAdapter()
    const session = await adapter.createSession()
    adapter.publicUpdateSession(session.id, {
      metadata: {
        availableCommands: [
          {
            name: "/compress",
            description: "Compress context",
            input: { hint: "focus" },
          },
        ],
      },
    })
    adapter.events = [{ type: "done", success: true, timestamp: new Date() }]

    expect(await adapter.getCompactionCapability(session.id)).toEqual({
      status: "supported",
      routes: [{ kind: "command", command: "compress", supportsFocus: true }],
    })
    await adapter.compactSession(session.id, { focus: "preserve API decisions" })

    expect(adapter.promptRecords.at(-1)?.content).toEqual([
      { type: "text", text: "/compress preserve API decisions" },
    ])
  })

  it("executes provider undo only when the command is advertised", async () => {
    const adapter = new TestAdapter()
    const session = await adapter.createSession()
    adapter.publicUpdateSession(session.id, {
      metadata: {
        availableCommands: [{ name: "undo", description: "Undo last change" }],
      },
    })
    adapter.events = [{ type: "done", success: true, timestamp: new Date() }]

    expect(await adapter.getProviderUndoCapability(session.id)).toEqual({
      status: "supported",
      command: "undo",
    })
    await adapter.undoLastProviderChange(session.id)

    expect(adapter.promptRecords.at(-1)?.content).toEqual([{ type: "text", text: "/undo" }])
  })
})

describe("BaseProtocolAdapter.execute", () => {
  it("collects message_delta into finalResponse and emits onEvent callbacks", async () => {
    const a = new TestAdapter()
    await a.connect({ id: "x" } as ExternalAgentConfig)
    const s = await a.createSession()
    a.events = [
      { type: "message_start", messageId: "m1", timestamp: new Date() },
      {
        type: "message_delta",
        messageId: "m1",
        delta: { type: "text", text: "Hello " },
        timestamp: new Date(),
      },
      {
        type: "message_delta",
        messageId: "m1",
        delta: { type: "thinking", text: "T" },
        timestamp: new Date(),
      },
      {
        type: "message_delta",
        messageId: "m1",
        delta: { type: "text", text: "world" },
        timestamp: new Date(),
      },
      { type: "message_end", messageId: "m1", timestamp: new Date() },
      { type: "done", success: true, timestamp: new Date() },
    ] as ExternalAgentEvent[]
    const onEvent = jest.fn()
    const result = await a.execute(
      s.id,
      { id: "msg-1", role: "user", content: [{ type: "text", text: "hi" }], timestamp: new Date() },
      { onEvent }
    )
    expect(result.success).toBe(true)
    expect(result.finalResponse).toBe("Hello world")
    expect(onEvent).toHaveBeenCalled()
    // Final assistant message gets pushed (text + thinking)
    expect(result.messages.length).toBe(2)
    const reply = result.messages[1]
    expect(reply.content.find((c) => c.type === "text")).toMatchObject({ text: "Hello world" })
    expect(reply.content.find((c) => c.type === "thinking")).toMatchObject({ thinking: "T" })
  })

  it("handles tool_use_start/tool_use_end/tool_result chains, including isError", async () => {
    const a = new TestAdapter()
    a.events = [
      {
        type: "tool_use_start",
        toolUseId: "tu1",
        toolName: "tool",
        timestamp: new Date(),
      },
      {
        type: "tool_use_end",
        toolUseId: "tu1",
        input: { a: 1 },
        timestamp: new Date(),
      },
      {
        type: "tool_result",
        toolUseId: "tu1",
        result: { ok: true },
        isError: false,
        timestamp: new Date(),
      },
      {
        type: "tool_use_start",
        toolUseId: "tu2",
        toolName: "fail",
        timestamp: new Date(),
      },
      {
        type: "tool_result",
        toolUseId: "tu2",
        result: "boom",
        isError: true,
        timestamp: new Date(),
      },
      // tool_use_end / tool_result for unknown ids — should be ignored
      {
        type: "tool_use_end",
        toolUseId: "ghost",
        input: {},
        timestamp: new Date(),
      },
      {
        type: "tool_result",
        toolUseId: "ghost",
        result: "n/a",
        timestamp: new Date(),
      },
      { type: "done", success: true, timestamp: new Date() },
    ] as ExternalAgentEvent[]
    const s = await a.createSession()
    const result = await a.execute(s.id, {
      id: "m",
      role: "user",
      content: [{ type: "text", text: "x" }],
      timestamp: new Date(),
    })
    expect(result.toolCalls).toHaveLength(2)
    expect(result.toolCalls[0].status).toBe("completed")
    expect(result.toolCalls[1].status).toBe("error")
    expect(result.toolCalls[1].error).toBe("boom")
  })

  it("invokes onPermissionRequest and forwards the response", async () => {
    const a = new TestAdapter()
    a.events = [
      {
        type: "permission_request",
        request: {
          requestId: "r",
          sessionId: "s",
          toolInfo: { id: "t", name: "delete" },
        },
        timestamp: new Date(),
      },
      { type: "done", success: true, timestamp: new Date() },
    ] as ExternalAgentEvent[]
    const s = await a.createSession()
    const onPermissionRequest = jest
      .fn()
      .mockResolvedValue({ requestId: "r", outcome: "selected", optionId: "allow" })
    await a.execute(
      s.id,
      { id: "m", role: "user", content: [{ type: "text", text: "x" }], timestamp: new Date() },
      { onPermissionRequest }
    )
    expect(onPermissionRequest).toHaveBeenCalled()
    expect(a.permissionRecords[0].requestId).toBe("r")
  })

  it("invokes onElicitationRequest and forwards the typed response", async () => {
    const a = new TestAdapter()
    a.events = [
      {
        type: "elicitation_request",
        request: {
          id: "e1",
          mode: "form",
          message: "Choose",
          requestedSchema: { type: "object", properties: {} },
          raw: {},
        },
        timestamp: new Date(),
      },
      { type: "done", success: true, timestamp: new Date() },
    ] as ExternalAgentEvent[]
    const forwarded: unknown[] = []
    a.respondToElicitation = async (response) => {
      forwarded.push(response)
    }
    const s = await a.createSession()
    const onElicitationRequest = jest.fn().mockResolvedValue({
      requestId: "e1",
      action: "accept",
      content: {},
    })

    await a.execute(
      s.id,
      { id: "m", role: "user", content: [{ type: "text", text: "x" }], timestamp: new Date() },
      { onElicitationRequest }
    )

    expect(onElicitationRequest).toHaveBeenCalledWith(expect.objectContaining({ id: "e1" }))
    expect(forwarded).toEqual([{ requestId: "e1", action: "accept", content: {} }])
  })

  it("forwards plan_update and progress events to onProgress", async () => {
    const a = new TestAdapter()
    a.events = [
      { type: "plan_update", progress: 0.25, timestamp: new Date() },
      {
        type: "progress",
        progress: 0.5,
        message: "halfway",
        timestamp: new Date(),
      },
      { type: "done", success: true, timestamp: new Date() },
    ] as ExternalAgentEvent[]
    const s = await a.createSession()
    const onProgress = jest.fn()
    await a.execute(
      s.id,
      { id: "m", role: "user", content: [{ type: "text", text: "x" }], timestamp: new Date() },
      { onProgress }
    )
    expect(onProgress).toHaveBeenNthCalledWith(1, 0.25)
    expect(onProgress).toHaveBeenNthCalledWith(2, 0.5, "halfway")
  })

  it("captures error events and 'done' success=false", async () => {
    const a = new TestAdapter()
    a.events = [
      { type: "error", error: "broken", timestamp: new Date() },
      { type: "done", success: false, timestamp: new Date() },
    ] as ExternalAgentEvent[]
    const s = await a.createSession()
    const result = await a.execute(s.id, {
      id: "m",
      role: "user",
      content: [{ type: "text", text: "x" }],
      timestamp: new Date(),
    })
    expect(result.success).toBe(false)
    expect(result.error).toBe("broken")
  })

  it("captures tokenUsage from the done event", async () => {
    const a = new TestAdapter()
    a.events = [
      {
        type: "done",
        success: true,
        tokenUsage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
        timestamp: new Date(),
      },
    ] as ExternalAgentEvent[]
    const s = await a.createSession()
    const result = await a.execute(s.id, {
      id: "m",
      role: "user",
      content: [{ type: "text", text: "x" }],
      timestamp: new Date(),
    })
    expect(result.tokenUsage?.totalTokens).toBe(3)
  })

  it("returns a failure result when the prompt iterator throws", async () => {
    const a = new TestAdapter()
    a.shouldThrowInPrompt = true
    const s = await a.createSession()
    const result = await a.execute(s.id, {
      id: "m",
      role: "user",
      content: [{ type: "text", text: "x" }],
      timestamp: new Date(),
    })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/stream broken/i)
  })

  it("stringifies non-Error throws in catch branch", async () => {
    class StringThrower extends BaseProtocolAdapter {
      readonly protocol = "throws"
      async connect() {}
      async disconnect() {}
      async createSession(): Promise<ExternalAgentSession> {
        const s = {
          id: this.generateSessionId(),
          agentId: "a",
          status: "active",
          createdAt: new Date(),
          lastActivityAt: new Date(),
          messages: [],
          permissionMode: "default",
        } as ExternalAgentSession
        this._sessions.set(s.id, s)
        return s
      }
      async closeSession() {}
      async *prompt(): AsyncIterable<ExternalAgentEvent> {
        throw "string-error"
      }
      async respondToPermission() {}
      async cancel() {}
    }
    const a = new StringThrower()
    const s = await a.createSession()
    const result = await a.execute(s.id, {
      id: "m",
      role: "user",
      content: [{ type: "text", text: "x" }],
      timestamp: new Date(),
    })
    expect(result.success).toBe(false)
    expect(result.error).toBe("string-error")
  })

  it("does not push a response message when no text or thinking accumulated", async () => {
    const a = new TestAdapter()
    a.events = [{ type: "done", success: true, timestamp: new Date() }] as ExternalAgentEvent[]
    const s = await a.createSession()
    const result = await a.execute(s.id, {
      id: "m",
      role: "user",
      content: [{ type: "text", text: "x" }],
      timestamp: new Date(),
    })
    expect(result.messages).toHaveLength(1) // only original
  })
})

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
    expect(protocolAdapterRegistry.create("p1:demo")).toBeInstanceOf(TestAdapter)
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
