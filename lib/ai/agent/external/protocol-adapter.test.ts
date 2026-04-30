import {
  BaseProtocolAdapter,
  ProtocolAdapterRegistry,
  protocolAdapterRegistry,
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
    _message: ExternalAgentMessage,
    _options?: ExternalAgentExecutionOptions
  ): AsyncIterable<ExternalAgentEvent> {
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

  // Expose protected helpers for testing
  publicUpdateSession(sessionId: string, updates: Partial<ExternalAgentSession>) {
    return this.updateSession(sessionId, updates)
  }
  publicGenerateMessageId() {
    return this.generateMessageId()
  }
}

describe("BaseProtocolAdapter — basic accessors", () => {
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
