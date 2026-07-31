import type {
  ExternalAgentConfig,
  ExternalAgentEvent,
  ExternalAgentMessage,
  ExternalAgentResult,
} from "@/types/agent/external-agent"

const createOpencodeClientMock = jest.fn()
jest.mock(
  "@opencode-ai/sdk/v2/client",
  () => ({
    createOpencodeClient: (...args: unknown[]) => createOpencodeClientMock(...args),
  }),
  { virtual: true }
)

const discoverMock = jest.fn()
jest.mock("@/lib/claude/feature-call", () => ({
  discoverOpenCodeV2ViaSidecar: (...args: unknown[]) => discoverMock(...args),
}))

import { OpenCodeV2ClientAdapter } from "./opencode-v2-client"

function streamOf(items: unknown[]) {
  return {
    stream: (async function* () {
      for (const item of items) yield item
    })(),
  }
}

function response(data: unknown) {
  return Promise.resolve({ data })
}

function sessionInfo(id = "s1") {
  return {
    id,
    projectID: "project",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 2 },
    title: "Preview session",
    location: { directory: "/workspace" },
    model: { providerID: "anthropic", id: "claude" },
  }
}

function fakeClient() {
  return {
    v2: {
      health: { get: jest.fn(() => response({ healthy: true })) },
      session: {
        list: jest.fn(() => response({ data: [sessionInfo()], cursor: {} })),
        create: jest.fn(() => response({ data: sessionInfo() })),
        get: jest.fn(() => response({ data: sessionInfo() })),
        prompt: jest.fn(() =>
          response({
            data: {
              admittedSeq: 1,
              id: "u1",
              sessionID: "s1",
              prompt: { text: "hello" },
              delivery: "queue",
              timeCreated: 1,
            },
          })
        ),
        events: jest.fn(() =>
          Promise.resolve(
            streamOf([
              {
                type: "session.next.text.delta",
                properties: {
                  timestamp: 1,
                  sessionID: "s1",
                  assistantMessageID: "a1",
                  textID: "t1",
                  delta: "hello",
                },
              },
              {
                type: "session.next.step.ended",
                properties: {
                  timestamp: 2,
                  sessionID: "s1",
                  assistantMessageID: "a1",
                  finish: "stop",
                  cost: 0,
                  tokens: {
                    input: 2,
                    output: 1,
                    reasoning: 0,
                    cache: { read: 0, write: 0 },
                  },
                },
              },
            ])
          )
        ),
        compact: jest.fn(() => response(undefined)),
        wait: jest.fn(() => response(undefined)),
        interrupt: jest.fn(() => response(undefined)),
        switchModel: jest.fn(() => response(undefined)),
        permission: {
          reply: jest.fn(() => response(undefined)),
        },
      },
      model: {
        list: jest.fn(() =>
          response({
            location: { directory: "/workspace", project: { id: "p", directory: "/workspace" } },
            data: [
              {
                id: "claude",
                providerID: "anthropic",
                name: "Claude",
                enabled: true,
                status: "active",
              },
            ],
          })
        ),
      },
      command: {
        list: jest.fn(() =>
          response({
            location: { directory: "/workspace", project: { id: "p", directory: "/workspace" } },
            data: [{ name: "compact", template: "$ARGUMENTS", description: "Compact" }],
          })
        ),
      },
    },
  }
}

function config(): ExternalAgentConfig {
  return {
    id: "opencode-v2",
    name: "OpenCode V2 Preview",
    protocol: "opencode-v2",
    transport: "sse",
    enabled: true,
    defaultPermissionMode: "default",
    timeout: 30_000,
    metadata: { preview: true },
    createdAt: new Date(),
    updatedAt: new Date(),
  }
}

function userMessage(): ExternalAgentMessage {
  return {
    id: "u1",
    role: "user",
    content: [{ type: "text", text: "hello" }],
    timestamp: new Date(),
  }
}

function mapEvent(
  adapter: OpenCodeV2ClientAdapter,
  event: Record<string, unknown>
): ExternalAgentEvent[] {
  return (
    adapter as unknown as {
      mapEvent(sessionId: string, raw: unknown): ExternalAgentEvent[]
    }
  ).mapEvent("s1", event)
}

function successfulExecution(): ExternalAgentResult {
  return {
    success: true,
    sessionId: "s1",
    finalResponse: "",
    messages: [],
    steps: [],
    toolCalls: [],
    duration: 0,
  }
}

describe("OpenCodeV2ClientAdapter", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    discoverMock.mockResolvedValue({
      endpoint: "http://127.0.0.1:4096",
      version: "2.0.0-beta.1",
      headers: { authorization: "Bearer ephemeral" },
    })
    createOpencodeClientMock.mockReturnValue(fakeClient())
  })

  it("discovers ephemeral auth and probes both health and the V2 session contract", async () => {
    const client = fakeClient()
    createOpencodeClientMock.mockReturnValue(client)
    const adapter = new OpenCodeV2ClientAdapter()

    client.v2.health.get.mockResolvedValueOnce(await response({ version: "2.0.0-beta.1", pid: 42 }))
    await adapter.connect(config())

    expect(createOpencodeClientMock).toHaveBeenCalledWith({
      baseUrl: "http://127.0.0.1:4096",
      headers: { authorization: "Bearer ephemeral" },
    })
    expect(client.v2.health.get).toHaveBeenCalled()
    expect(client.v2.session.list).toHaveBeenCalledWith({ limit: 1 })
    expect(adapter.connectionStatus).toBe("connected")
    expect(adapter.capabilities).toEqual(
      expect.objectContaining({
        fileOperations: false,
        mcpTools: false,
        custom: expect.objectContaining({
          surfaceSupport: {
            pty: "unsupported",
            tui: "unsupported",
            mcp: "unsupported",
            file: "unsupported",
            find: "unsupported",
            providerManagement: "unsupported",
          },
        }),
      })
    )
    expect(adapter.getAvailableCommands()).toEqual([
      expect.objectContaining({ name: "compact", input: { hint: "$ARGUMENTS" } }),
    ])
  })

  it("rejects incompatible versions and unhealthy services", async () => {
    discoverMock.mockResolvedValueOnce({
      endpoint: "http://127.0.0.1:4096",
      version: "1.18.4",
      headers: {},
    })
    await expect(new OpenCodeV2ClientAdapter().connect(config())).rejects.toThrow(
      /incompatible OpenCode V2 service/i
    )

    const client = fakeClient()
    client.v2.health.get.mockResolvedValueOnce({ data: { healthy: false } })
    createOpencodeClientMock.mockReturnValue(client)
    await expect(new OpenCodeV2ClientAdapter().connect(config())).rejects.toThrow(/health/i)
  })

  it("maps V2 session events and waits for asynchronous compaction completion", async () => {
    const client = fakeClient()
    createOpencodeClientMock.mockReturnValue(client)
    const adapter = new OpenCodeV2ClientAdapter()
    await adapter.connect(config())
    const session = await adapter.createSession({ cwd: "/workspace" })
    expect(client.v2.session.create).toHaveBeenCalledWith({
      location: { directory: "/workspace" },
    })

    const events = []
    for await (const event of adapter.prompt(session.id, userMessage())) events.push(event)
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "message_delta", messageId: "a1" }),
        expect.objectContaining({ type: "done", success: true }),
      ])
    )

    await adapter.compactSession(session.id)
    expect(client.v2.session.compact).toHaveBeenCalledWith({ sessionID: session.id })
    expect(client.v2.session.wait).toHaveBeenCalledWith({ sessionID: session.id })
  })

  it("supports the core session, permission, model, cancellation, and disconnect lifecycle", async () => {
    const client = fakeClient()
    createOpencodeClientMock.mockReturnValue(client)
    const adapter = new OpenCodeV2ClientAdapter()
    await adapter.connect(config())

    expect(await adapter.healthCheck()).toBe(true)
    const created = await adapter.createSession({ metadata: { directory: "/workspace" } })
    expect(client.v2.session.create).toHaveBeenCalledWith({
      location: { directory: "/workspace" },
    })
    expect(adapter.getSessionModels(created.id)).toEqual({
      availableModels: [{ modelId: "anthropic/claude", name: "Claude" }],
      currentModelId: "anthropic/claude",
    })

    await adapter.setSessionModel(created.id, "openai/gpt-5")
    expect(client.v2.session.switchModel).toHaveBeenCalledWith({
      sessionID: created.id,
      model: { providerID: "openai", id: "gpt-5" },
    })
    expect(adapter.getSessionModels(created.id)?.currentModelId).toBe("openai/gpt-5")
    await expect(adapter.setSessionModel(created.id, "missing-provider")).rejects.toThrow(
      /provider\/model/
    )

    await adapter.respondToPermission(created.id, {
      requestId: "permission-1",
      granted: true,
      scope: "always",
      reason: "trusted",
    })
    await adapter.respondToPermission(created.id, {
      requestId: "permission-2",
      granted: false,
    })
    expect(client.v2.session.permission.reply).toHaveBeenNthCalledWith(1, {
      sessionID: created.id,
      requestID: "permission-1",
      reply: "always",
      message: "trusted",
    })
    expect(client.v2.session.permission.reply).toHaveBeenNthCalledWith(2, {
      sessionID: created.id,
      requestID: "permission-2",
      reply: "reject",
      message: undefined,
    })

    const listed = await adapter.listSessions()
    expect(listed[0]).toEqual(
      expect.objectContaining({
        sessionId: "s1",
        title: "Preview session",
        createdAt: new Date(1000).toISOString(),
      })
    )
    expect((await adapter.resumeSession("s1")).id).toBe("s1")
    await adapter.closeSession(created.id)
    expect(client.v2.session.interrupt).toHaveBeenCalledWith({ sessionID: created.id })
    expect(adapter.getSession(created.id)).toBeUndefined()

    await adapter.disconnect()
    expect(adapter.connectionStatus).toBe("disconnected")
    expect(await adapter.healthCheck()).toBe(false)
    await expect(adapter.createSession()).rejects.toThrow(/not connected/i)
  })

  it("handles health request errors and rejects an invalid V2 session probe", async () => {
    const healthFailure = fakeClient()
    healthFailure.v2.health.get.mockResolvedValueOnce({
      error: { message: "authentication failed", code: "AUTH" },
      response: { status: 401 },
    } as never)
    createOpencodeClientMock.mockReturnValueOnce(healthFailure)
    await expect(new OpenCodeV2ClientAdapter().connect(config())).rejects.toMatchObject({
      message: "authentication failed",
      status: 401,
      code: "AUTH",
    })

    const invalidContract = fakeClient()
    invalidContract.v2.session.list.mockResolvedValueOnce({ data: { data: "not-an-array" } })
    createOpencodeClientMock.mockReturnValueOnce(invalidContract)
    await expect(new OpenCodeV2ClientAdapter().connect(config())).rejects.toThrow(
      /expected V2 session contract/
    )

    const adapter = new OpenCodeV2ClientAdapter()
    const client = fakeClient()
    createOpencodeClientMock.mockReturnValueOnce(client)
    await adapter.connect(config())
    client.v2.health.get.mockResolvedValueOnce({ error: "offline" } as never)
    expect(await adapter.healthCheck()).toBe(false)
  })

  it("normalizes command/model discovery and maps the complete V2 event lifecycle", async () => {
    const client = fakeClient()
    client.v2.command.list.mockResolvedValueOnce(
      await response({
        data: [
          { name: "", template: "", description: "ignored" },
          { name: "/compress", template: "no args", description: 42 },
        ],
      })
    )
    client.v2.model.list.mockResolvedValueOnce(
      await response({
        data: [
          { providerID: "anthropic", id: "claude", name: "Claude", enabled: true },
          { providerID: "openai", id: "disabled", enabled: false },
          { providerID: "", id: "invalid", enabled: true },
        ],
      })
    )
    createOpencodeClientMock.mockReturnValue(client)
    const adapter = new OpenCodeV2ClientAdapter()
    await adapter.connect(config())
    expect(adapter.getAvailableCommands()).toEqual([
      { name: "/compress", description: "", input: null },
    ])

    const common = { timestamp: 1, sessionID: "s1", assistantMessageID: "a1" }
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ type: "session.next.text.started", properties: common }, "message_start"],
      [
        {
          type: "session.next.text.delta",
          properties: { ...common, delta: "text" },
        },
        "message_delta",
      ],
      [{ type: "session.next.text.ended", properties: common }, "message_end"],
      [
        {
          type: "session.next.reasoning.delta",
          properties: { ...common, delta: "thought" },
        },
        "thinking",
      ],
      [
        {
          type: "session.next.tool.called",
          properties: { ...common, callID: "call", tool: "read", input: { path: "a" } },
        },
        "tool_use_start",
      ],
      [
        {
          type: "session.next.tool.success",
          properties: { ...common, callID: "call", content: [{ text: "done" }] },
        },
        "tool_result",
      ],
      [
        {
          type: "permission.v2.asked",
          properties: { ...common, id: "p1", action: "write", resources: ["a"] },
        },
        "permission_request",
      ],
      [{ type: "session.next.compaction.started", properties: common }, "progress"],
      [{ type: "session.next.compaction.ended", properties: common }, "progress"],
      [
        {
          type: "session.next.step.ended",
          properties: {
            ...common,
            tokens: { input: 2, output: 3, reasoning: 1, cache: { read: 4, write: 5 } },
          },
        },
        "done",
      ],
    ]
    for (const [event, expectedType] of cases) {
      expect(mapEvent(adapter, event)[0]?.type).toBe(expectedType)
    }

    const failedTool = mapEvent(adapter, {
      type: "session.next.tool.failed",
      properties: {
        ...common,
        callID: "call",
        error: { message: "tool failed" },
      },
    })[0]
    expect(failedTool).toEqual(
      expect.objectContaining({ type: "tool_result", result: "tool failed", isError: true })
    )

    const failedStep = mapEvent(adapter, {
      type: "session.next.step.failed",
      properties: { ...common, error: { message: "step failed" } },
    })
    expect(failedStep).toEqual([
      expect.objectContaining({ type: "error", error: "step failed" }),
      expect.objectContaining({ type: "done", success: false }),
    ])
    expect(mapEvent(adapter, { type: "unknown", properties: common })).toEqual([])
    expect(
      mapEvent(adapter, { type: "session.next.text.delta", data: { delta: "legacy" } })
    ).toEqual([expect.objectContaining({ type: "message_delta" })])
  })

  it("uses command focus and only falls back from native compaction on explicit unsupported errors", async () => {
    const client = fakeClient()
    createOpencodeClientMock.mockReturnValue(client)
    const adapter = new OpenCodeV2ClientAdapter()
    expect(await adapter.getCompactionCapability("s1")).toEqual({
      status: "unknown",
      routes: [],
      reason: "not_connected",
    })
    await adapter.connect(config())
    const session = await adapter.createSession()
    const execute = jest.spyOn(adapter, "execute").mockResolvedValue(successfulExecution())

    await adapter.compactSession(session.id, { focus: "preserve API decisions" })
    expect(execute.mock.calls[0]?.[1].content).toEqual([
      { type: "text", text: "/compact preserve API decisions" },
    ])

    client.v2.session.compact.mockResolvedValueOnce({
      error: { message: "unsupported endpoint" },
      response: { status: 501 },
    } as never)
    await adapter.compactSession(session.id)
    expect(execute).toHaveBeenCalledTimes(2)
    expect((await adapter.getCompactionCapability(session.id)).routes).toEqual([
      expect.objectContaining({ kind: "command" }),
    ])

    const authClient = fakeClient()
    createOpencodeClientMock.mockReturnValueOnce(authClient)
    const authAdapter = new OpenCodeV2ClientAdapter()
    await authAdapter.connect(config())
    const authSession = await authAdapter.createSession()
    const authExecute = jest.spyOn(authAdapter, "execute").mockResolvedValue(successfulExecution())
    authClient.v2.session.compact.mockResolvedValueOnce({
      error: { message: "authentication failed" },
      response: { status: 401 },
    } as never)
    await expect(authAdapter.compactSession(authSession.id)).rejects.toThrow(
      /authentication failed/
    )
    expect(authExecute).not.toHaveBeenCalled()
  })

  it("handles defensive session, discovery, prompt, and permission fallbacks", async () => {
    const client = fakeClient()
    client.v2.command.list.mockResolvedValueOnce(
      await response({
        data: "not-an-array",
      })
    )
    client.v2.model.list.mockResolvedValueOnce(
      await response({
        data: [
          { providerID: "anthropic", id: "claude", enabled: true },
          { providerID: "openai", id: "", enabled: true },
          { providerID: "openai", id: "disabled", enabled: false },
        ],
      })
    )
    client.v2.session.create.mockResolvedValueOnce(
      await response({
        data: {
          id: "minimal",
          projectID: "project",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          title: "Minimal",
        },
      })
    )
    createOpencodeClientMock.mockReturnValue(client)

    const adapter = new OpenCodeV2ClientAdapter()
    await adapter.connect({
      ...config(),
      id: "",
      defaultPermissionMode: undefined,
    } as ExternalAgentConfig)
    const session = await adapter.createSession()

    expect(session).toEqual(
      expect.objectContaining({
        agentId: "",
        permissionMode: "default",
        createdAt: expect.any(Date),
        lastActivityAt: expect.any(Date),
      })
    )
    expect(adapter.getAvailableCommands()).toEqual([])
    expect(adapter.getSessionModels(session.id)).toEqual({
      availableModels: [{ modelId: "anthropic/claude", name: "claude" }],
      currentModelId: "anthropic/claude",
    })

    client.v2.session.list.mockResolvedValueOnce(await response({ data: "not-an-array" }))
    expect(await adapter.listSessions()).toEqual([])
    await adapter.respondToPermission(session.id, {
      requestId: "permission-once",
      granted: true,
    })
    expect(client.v2.session.permission.reply).toHaveBeenLastCalledWith({
      sessionID: session.id,
      requestID: "permission-once",
      reply: "once",
      message: undefined,
    })

    await expect(
      adapter.prompt("missing", userMessage())[Symbol.asyncIterator]().next()
    ).rejects.toThrow(/Session not found/)
    const controller = new AbortController()
    client.v2.session.prompt.mockImplementationOnce(() => {
      controller.abort()
      return response({
        data: {
          admittedSeq: 1,
          id: "u1",
          sessionID: session.id,
          prompt: { text: "first\nsecond" },
          delivery: "queue",
          timeCreated: 1,
        },
      })
    })
    const message: ExternalAgentMessage = {
      ...userMessage(),
      content: [
        { type: "text", text: "first" },
        {
          type: "image",
          source: { type: "base64", data: "AA==", mediaType: "image/png" },
        },
        { type: "text", text: "second" },
      ],
    }
    const events = adapter.prompt(session.id, message, { signal: controller.signal })
    for await (const event of events) {
      if (event.type === "done") break
    }
    expect(client.v2.session.prompt).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: { text: "first\nsecond" } }),
      { signal: controller.signal }
    )
    expect(client.v2.session.interrupt).toHaveBeenCalledWith({ sessionID: session.id })

    await adapter.disconnect()
    await expect(adapter.cancel(session.id)).resolves.toBeUndefined()
  })

  it("maps missing and malformed event fields without leaking provider payload errors", async () => {
    const adapter = new OpenCodeV2ClientAdapter()
    const circular: unknown[] = []
    circular.push(circular)

    expect(
      mapEvent(adapter, {
        type: "session.next.text.started",
        properties: { timestamp: 10_000_000_001 },
      })
    ).toEqual([
      expect.objectContaining({
        type: "message_start",
        messageId: "assistant",
        timestamp: new Date(10_000_000_001),
      }),
    ])
    expect(
      mapEvent(adapter, {
        type: "session.next.text.delta",
        properties: {},
      })
    ).toEqual([
      expect.objectContaining({
        type: "message_delta",
        delta: { type: "text", text: "" },
      }),
    ])
    expect(
      mapEvent(adapter, {
        type: "session.next.reasoning.delta",
        properties: {},
      })
    ).toEqual([expect.objectContaining({ type: "thinking", thinking: "" })])
    expect(
      mapEvent(adapter, {
        type: "session.next.tool.called",
        properties: {},
      })
    ).toEqual([
      expect.objectContaining({
        toolUseId: "tool",
        toolName: "unknown",
        rawInput: {},
      }),
    ])

    const toolValues: Array<[unknown, string | Record<string, unknown>]> = [
      [{ ok: true }, { ok: true }],
      [undefined, ""],
      [null, ""],
      [[1, 2], "[1,2]"],
      [circular, String(circular)],
    ]
    for (const [result, expected] of toolValues) {
      expect(
        mapEvent(adapter, {
          type: "session.next.tool.success",
          properties: { result },
        })
      ).toEqual([expect.objectContaining({ type: "tool_result", result: expected })])
    }

    expect(
      mapEvent(adapter, {
        type: "permission.v2.asked",
        properties: {},
      })
    ).toEqual([
      expect.objectContaining({
        request: expect.objectContaining({
          id: "permission",
          requestId: "permission",
          title: "Permission requested",
          toolInfo: { id: "unknown", name: "unknown" },
        }),
      }),
    ])
    expect(
      mapEvent(adapter, {
        type: "session.next.step.failed",
        properties: {},
      })
    ).toEqual([
      expect.objectContaining({
        type: "error",
        error: "OpenCode V2 session step failed",
      }),
      expect.objectContaining({ type: "done", success: false }),
    ])
    expect(
      mapEvent(adapter, {
        type: "session.next.step.ended",
        properties: { tokens: { cache: { read: "bad", write: "bad" } } },
      })
    ).toEqual([
      expect.objectContaining({
        type: "done",
        tokenUsage: {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
      }),
    ])
    expect(mapEvent(adapter, null as unknown as Record<string, unknown>)).toEqual([])
  })

  it("preserves SDK error tags and default messages", async () => {
    const taggedClient = fakeClient()
    taggedClient.v2.health.get.mockResolvedValueOnce({
      error: { _tag: "HealthUnavailable", code: "TEMPORARY" },
      response: {},
    } as never)
    createOpencodeClientMock.mockReturnValueOnce(taggedClient)
    await expect(new OpenCodeV2ClientAdapter().connect(config())).rejects.toMatchObject({
      message: "HealthUnavailable",
      code: "TEMPORARY",
    })

    const unknownClient = fakeClient()
    unknownClient.v2.health.get.mockResolvedValueOnce({ error: {}, response: {} } as never)
    createOpencodeClientMock.mockReturnValueOnce(unknownClient)
    await expect(new OpenCodeV2ClientAdapter().connect(config())).rejects.toThrow(
      "OpenCode V2 request failed"
    )
  })
})
