import type {
  AcpElicitationValue,
  ExternalAgentConfig,
  ExternalAgentEvent,
} from "@/types/agent/external-agent"

jest.mock("@opencode/client", () => ({ OpenCode: { make: jest.fn() } }), { virtual: true })
jest.mock("@/lib/claude/feature-call", () => ({ discoverOpenCodeV2ViaSidecar: jest.fn() }))
jest.mock("@/lib/network/platform-streaming-fetch", () => ({ platformStreamingFetch: jest.fn() }))
import { OpenCode } from "@opencode/client"
import { platformStreamingFetch } from "@/lib/network/platform-streaming-fetch"
import { discoverOpenCodeV2ViaSidecar } from "@/lib/claude/feature-call"
import { OpenCodeV2ClientAdapter } from "./opencode-v2-client"

const config = {
  id: "oc",
  protocol: "opencode-v2",
  network: { endpoint: "http://localhost:4096" },
  defaultPermissionMode: "default",
} as ExternalAgentConfig
const info = (id = "s1") => ({
  id,
  projectID: "p",
  location: { directory: "/workspace" },
  time: { created: 1000, updated: 2000 },
  model: { providerID: "vendor", id: "model" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
})
const event = (type: string, data: object = {}) => ({
  id: crypto.randomUUID(),
  created: 1234,
  type,
  data: { sessionID: "s1", ...data },
})
function fakeClient() {
  return {
    plugin: { awaitActivation: jest.fn().mockResolvedValue(undefined) },
    health: { get: jest.fn().mockResolvedValue({ healthy: true, version: "2.0.0", pid: 12 }) },
    session: {
      list: jest.fn().mockResolvedValue({ data: [info()], cursor: {} }),
      create: jest.fn().mockResolvedValue(info()),
      get: jest.fn().mockImplementation(({ sessionID }) => Promise.resolve(info(sessionID))),
      active: jest.fn().mockResolvedValue({}),
      fork: jest.fn().mockResolvedValue(info("s2")),
      remove: jest.fn().mockResolvedValue(undefined),
      prompt: jest.fn().mockResolvedValue({ id: "u1" }),
      command: jest.fn().mockResolvedValue(undefined),
      interrupt: jest.fn().mockResolvedValue({}),
      wait: jest.fn().mockResolvedValue(undefined),
      compact: jest.fn().mockResolvedValue({}),
      switchModel: jest.fn().mockResolvedValue(undefined),
      switchAgent: jest.fn().mockResolvedValue(undefined),
      instructions: { entry: { put: jest.fn().mockResolvedValue(undefined) } },
    },
    message: { list: jest.fn().mockResolvedValue({ data: [], cursor: {} }) },
    model: {
      default: jest.fn().mockResolvedValue({ data: { providerID: "vendor", id: "model" } }),
      list: jest.fn().mockResolvedValue({
        data: [
          {
            id: "model",
            providerID: "vendor",
            name: "Model",
            enabled: true,
            variants: [{ id: "deep" }],
          },
        ],
      }),
    },
    command: {
      list: jest.fn().mockResolvedValue({
        data: [{ name: "review", description: "Review", template: "$ARGUMENTS" }],
      }),
    },
    permission: {
      list: jest.fn().mockResolvedValue([]),
      rules: jest.fn().mockResolvedValue(undefined),
      reply: jest.fn().mockResolvedValue(undefined),
    },
    form: {
      list: jest.fn().mockResolvedValue([]),
      reply: jest.fn().mockResolvedValue(undefined),
      cancel: jest.fn().mockResolvedValue(undefined),
    },
    event: {
      subscribe: jest.fn((_options?: { signal?: AbortSignal }) =>
        (async function* () {
          yield event("server.connected")
          yield event("session.text.delta", {
            assistantMessageID: "a1",
            ordinal: 0,
            delta: "Hello",
          })
          yield event("session.execution.succeeded")
        })()
      ),
    },
  }
}
const message = {
  id: "u1",
  role: "user" as const,
  content: [{ type: "text" as const, text: "Hello" }],
  timestamp: new Date(),
}
async function collect(stream: AsyncIterable<ExternalAgentEvent>) {
  const result: ExternalAgentEvent[] = []
  for await (const e of stream) result.push(e)
  return result
}

function streamEvents(...events: ReturnType<typeof event>[]) {
  return (async function* () {
    for (const item of events) yield item
  })()
}
function textMessage(text: string) {
  return { ...message, content: [{ type: "text" as const, text }] }
}
function abortableStream(options?: { signal?: AbortSignal }) {
  return (async function* () {
    yield event("server.connected")
    yield event("session.text.delta", { assistantMessageID: "a1", ordinal: 0, delta: "Partial" })
    await new Promise<void>((_resolve, reject) => {
      if (options?.signal?.aborted) reject(options.signal.reason)
      else
        options?.signal?.addEventListener("abort", () => reject(options.signal!.reason), {
          once: true,
        })
    })
  })()
}

describe("current OpenCode V2 adapter", () => {
  let adapter: OpenCodeV2ClientAdapter
  let client: ReturnType<typeof fakeClient>
  beforeEach(() => {
    jest.clearAllMocks()
    client = fakeClient()
    jest.mocked(OpenCode.make).mockReturnValue(client as never)
    jest.mocked(discoverOpenCodeV2ViaSidecar).mockResolvedValue({
      endpoint: "http://localhost:1234",
      version: "2.0.0",
      headers: { Authorization: "Basic local" },
    })
    adapter = new OpenCodeV2ClientAdapter()
  })
  it("starts a gateway-owned connection without shared discovery and isolates sessions even without MCP", async () => {
    const close = jest.fn().mockResolvedValue(undefined)
    const launch = jest
      .fn()
      .mockResolvedValue({ endpoint: "http://127.0.0.1:1111", headers: {}, close })
    adapter = new OpenCodeV2ClientAdapter(launch)
    await adapter.connect({
      ...config,
      network: undefined,
      metadata: { cogniaGatewayTask: { runtime: "opencode" } },
    })
    expect(discoverOpenCodeV2ViaSidecar).not.toHaveBeenCalled()
    expect(launch).toHaveBeenCalledTimes(1)
    await adapter.createSession()
    expect(launch).toHaveBeenCalledTimes(2)
    await adapter.disconnect()
    expect(close).toHaveBeenCalledTimes(2)
  })

  it("isolates attached Cognia servers per session and routes prompts and cleanup to the owning service", async () => {
    const first = fakeClient(),
      second = fakeClient()
    first.session.create.mockResolvedValue(info("first"))
    second.session.create.mockResolvedValue(info("second"))
    first.event.subscribe.mockImplementation(() =>
      streamEvents(
        event("server.connected"),
        event("session.execution.succeeded", { sessionID: "first" })
      )
    )
    second.event.subscribe.mockImplementation(() =>
      streamEvents(
        event("server.connected"),
        event("session.execution.succeeded", { sessionID: "second" })
      )
    )
    const closeFirst = jest.fn().mockResolvedValue(undefined),
      closeSecond = jest.fn().mockResolvedValue(undefined)
    const launch = jest
      .fn()
      .mockResolvedValueOnce({
        endpoint: "http://127.0.0.1:1111",
        headers: { Authorization: "one" },
        close: closeFirst,
      })
      .mockResolvedValueOnce({
        endpoint: "http://127.0.0.1:2222",
        headers: { Authorization: "two" },
        close: closeSecond,
      })
    adapter = new OpenCodeV2ClientAdapter(launch)
    await adapter.connect(config)
    jest
      .mocked(OpenCode.make)
      .mockReturnValueOnce(first as never)
      .mockReturnValueOnce(second as never)
    const mcpServers = [
      {
        name: "cognia-tools",
        type: "http" as const,
        url: "http://127.0.0.1:9000",
        headers: [{ name: "Authorization", value: "lease-one" }],
      },
    ]
    await adapter.createSession({
      cwd: "/workspace",
      permissionMode: "plan",
      mcpServers,
      context: {
        custom: {
          mcpServers,
          chatSessionId: "private-routing",
          conversationHistory: "previous exchange",
        },
      },
    })
    await adapter.createSession({
      cwd: "/workspace",
      mcpServers: [{ ...mcpServers[0], url: "http://127.0.0.1:9001" }],
    })
    expect(first.session.create).toHaveBeenCalledWith(
      expect.objectContaining({
        permissions: expect.arrayContaining([
          { action: "*", resource: "*", effect: "deny" },
          { action: "cognia-tools_*", resource: "*", effect: "allow" },
        ]),
      })
    )
    await adapter.setSessionMode("first", "default")
    expect(first.permission.rules).toHaveBeenLastCalledWith({
      sessionID: "first",
      permissions: [
        { action: "*", resource: "*", effect: "ask" },
        { action: "cognia-tools_*", resource: "*", effect: "allow" },
      ],
    })
    expect(adapter.getSdkClient("first")).toBe(first)
    expect(adapter.getSdkClient("second")).toBe(second)
    expect(JSON.stringify(first.session.instructions.entry.put.mock.calls)).toContain(
      "previous exchange"
    )
    expect(JSON.stringify(first.session.instructions.entry.put.mock.calls)).not.toContain(
      "lease-one"
    )
    await collect(adapter.prompt("first", message, { systemPrompt: "Updated skill instructions" }))
    expect(first.session.prompt).toHaveBeenCalled()
    expect(second.session.prompt).not.toHaveBeenCalled()
    expect(first.session.instructions.entry.put).toHaveBeenLastCalledWith({
      sessionID: "first",
      key: "cognia",
      value: "Updated skill instructions",
    })
    await adapter.closeSession("first")
    expect(closeFirst).toHaveBeenCalledTimes(1)
    expect(closeSecond).not.toHaveBeenCalled()
    await adapter.disconnect()
    expect(closeSecond).toHaveBeenCalledTimes(1)
  })

  it("releases a private service when native session creation fails", async () => {
    const close = jest.fn().mockResolvedValue(undefined)
    adapter = new OpenCodeV2ClientAdapter(
      jest.fn().mockResolvedValue({ endpoint: "http://127.0.0.1:1111", headers: {}, close })
    )
    await adapter.connect(config)
    const owned = fakeClient()
    owned.session.create.mockRejectedValueOnce(new Error("failed to create"))
    jest.mocked(OpenCode.make).mockReturnValueOnce(owned as never)
    await expect(
      adapter.createSession({
        mcpServers: [{ name: "cognia-tools", type: "http", url: "http://127.0.0.1:9000" }],
      })
    ).rejects.toThrow("failed to create")
    expect(close).toHaveBeenCalledTimes(1)
    expect(adapter.getSessions()).toEqual([])
  })
  it("uses the current native client directly, with no beta envelope or sidecar for remote", async () => {
    await adapter.connect(config)
    expect(discoverOpenCodeV2ViaSidecar).not.toHaveBeenCalled()
    expect(OpenCode.make).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: config.network!.endpoint, fetch: expect.any(Function) })
    )
    expect(adapter.getSdkClient()).toBe(client)
    expect((await adapter.createSession({ cwd: "/workspace" })).id).toBe("s1")
    expect(client.session.create).toHaveBeenCalledWith(
      expect.objectContaining({ location: { directory: "/workspace" } })
    )
    const events = await collect(adapter.prompt("s1", message))
    expect(client.session.prompt).toHaveBeenCalledWith(
      { sessionID: "s1", id: "msg_u1", text: "Hello", delivery: "queue" },
      expect.any(Object)
    )
    expect(events).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "done", success: true })])
    )
  })
  it("discovers local auth and rejects legacy servers without fallback", async () => {
    await adapter.connect({ ...config, network: undefined })
    expect(discoverOpenCodeV2ViaSidecar).toHaveBeenCalledTimes(1)
    expect(OpenCode.make).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Basic local" }),
      })
    )
    await adapter.disconnect()
    client.health.get.mockResolvedValue({ healthy: true, version: "2.0.0-beta.1", pid: 12 })
    await expect(adapter.connect(config)).rejects.toThrow(/current OpenCode V2/)
    expect(adapter.connectionStatus).toBe("error")
  })
  afterEach(async () => {
    await adapter.disconnect().catch(() => undefined)
  })

  it.each(["1.18.14", "2.0.0-beta.1", "3.0.0"])(
    "rejects unsupported server version %s",
    async (version) => {
      client.health.get.mockResolvedValue({ healthy: true, version, pid: 12 })
      await expect(adapter.connect(config)).rejects.toThrow(/current OpenCode V2/)
      expect(() => adapter.getSdkClient()).toThrow(/Not connected/)
    }
  )

  it.each([
    { healthy: false, version: "2.0.0", pid: 12 },
    { healthy: true, version: "2.0.0", pid: 0 },
  ])("rejects invalid health %#", async (health) => {
    client.health.get.mockResolvedValue(health)
    await expect(adapter.connect(config)).rejects.toThrow(/current OpenCode V2/)
  })

  it("rejects incompatible endpoints and malformed session envelopes before advertising readiness", async () => {
    await expect(
      adapter.connect({ ...config, network: { endpoint: "file:///tmp/service" } })
    ).rejects.toThrow(/HTTP/)
    client.session.list.mockResolvedValueOnce({ data: null, cursor: {} } as never)
    await expect(adapter.connect(config)).rejects.toThrow(/session contract/)
    expect(adapter.isConnected()).toBe(false)
  })

  it("merges service headers and applies explicit Bearer and Basic authentication", async () => {
    await adapter.connect({
      ...config,
      network: {
        endpoint: "https://host",
        apiKey: "api-token",
        bearerToken: "bearer-token",
        headers: { "X-Workspace": "test" },
      },
    })
    expect(OpenCode.make).toHaveBeenLastCalledWith(
      expect.objectContaining({
        headers: { authorization: "Bearer bearer-token", "x-workspace": "test" },
      })
    )
    await adapter.connect({
      ...config,
      metadata: { serverPassword: "päss", serverUsername: "user" },
    })
    expect(OpenCode.make).toHaveBeenLastCalledWith(
      expect.objectContaining({
        headers: { authorization: `Basic ${Buffer.from("user:päss").toString("base64")}` },
      })
    )
  })

  it("reports health without throwing and clears session state on disconnect", async () => {
    expect(await adapter.healthCheck()).toBe(false)
    await adapter.connect(config)
    await adapter.createSession()
    expect(await adapter.healthCheck()).toBe(true)
    client.health.get.mockRejectedValueOnce(new Error("offline"))
    expect(await adapter.healthCheck()).toBe(false)
    await adapter.disconnect()
    expect(adapter.getSessions()).toEqual([])
    expect(adapter.getAvailableCommands()).toEqual([])
    expect(adapter.getSessionModels("s1")).toBeUndefined()
    expect(adapter.connectionStatus).toBe("disconnected")
  })

  it("collects every session page, deduplicates ids, and passes the workspace filter", async () => {
    await adapter.connect(config)
    client.session.list
      .mockResolvedValueOnce({ data: [info()], cursor: { next: "page-2" } })
      .mockResolvedValueOnce({ data: [info(), info("s2")], cursor: {} })
    const sessions = await adapter.listSessions({ cwd: "/workspace" })
    expect(sessions.map((session) => session.sessionId)).toEqual(["s1", "s2"])
    expect(sessions[0]).toMatchObject({ cwd: "/workspace", createdAt: "1970-01-01T00:00:01.000Z" })
    expect(client.session.list).toHaveBeenLastCalledWith({
      limit: 100,
      cursor: "page-2",
    })
  })

  it("rejects cursor cycles instead of hanging forever", async () => {
    await adapter.connect(config)
    client.session.list.mockResolvedValue({ data: [], cursor: { next: "same" } })
    await expect(adapter.listSessions()).rejects.toThrow(/repeated a cursor/)
    expect(client.session.list).toHaveBeenCalledTimes(3)
  })

  it("creates a session with its model, permission policy, and complete instruction envelope", async () => {
    await adapter.connect({ ...config, process: { command: "", cwd: "/default" } })
    await adapter.createSession({
      permissionMode: "plan",
      metadata: { model: "vendor/model#deep", agent: "reviewer" },
      systemPrompt: "System",
      briefMode: true,
      instructionEnvelope: {
        developerInstructions: "Developer",
        customInstructions: "Custom",
        skillsSummary: "Skills",
        projectContextSummary: "Project",
      } as never,
    })
    expect(client.session.create).toHaveBeenCalledWith(
      expect.objectContaining({
        location: { directory: "/default" },
        agent: "reviewer",
        model: { providerID: "vendor", id: "model", variant: "deep" },
        permissions: expect.arrayContaining([
          { action: "*", resource: "*", effect: "deny" },
          { action: "read", resource: "*", effect: "allow" },
        ]),
      })
    )
    expect(client.session.instructions.entry.put).toHaveBeenCalledWith({
      sessionID: "s1",
      key: "cognia",
      value: "System\n\nDeveloper\n\nCustom\n\nSkills\n\nProject\n\nKeep responses concise.",
    })
  })

  it.each([{ additionalDirectories: ["/extra"] }, { mcpServers: [{ name: "test" }] }])(
    "rejects unsupported session launch options %# before creating remote state",
    async (options) => {
      await adapter.connect(config)
      await expect(adapter.createSession(options as never)).rejects.toThrow(
        /unsupported|local process host/
      )
      expect(client.session.create).not.toHaveBeenCalled()
    }
  )

  it.each(["bad", "/model", "vendor/", "vendor/#deep"])(
    "rejects malformed model %s before creating a session",
    async (model) => {
      await adapter.connect(config)
      await expect(adapter.createSession({ metadata: { model } })).rejects.toThrow(
        /provider\/model/
      )
      expect(client.session.create).not.toHaveBeenCalled()
    }
  )

  it("removes remote session state when instruction initialization fails", async () => {
    await adapter.connect(config)
    client.session.instructions.entry.put.mockRejectedValueOnce(
      new Error("instructions unavailable")
    )
    await expect(adapter.createSession({ systemPrompt: "System" })).rejects.toThrow(
      "instructions unavailable"
    )
    expect(client.session.remove).toHaveBeenCalledWith({ sessionID: "s1" })
    expect(adapter.getSession("s1")).toBeUndefined()
  })

  it("resumes sessions only in their original workspace and updates server permissions", async () => {
    await adapter.connect(config)
    await expect(adapter.resumeSession("s1", { cwd: "/other" })).rejects.toThrow(
      /different working directory/
    )
    const session = await adapter.resumeSession("s1", {
      cwd: "/workspace",
      permissionMode: "acceptEdits",
    })
    expect(session.id).toBe("s1")
    expect(client.permission.rules).toHaveBeenCalledWith({
      sessionID: "s1",
      permissions: expect.arrayContaining([{ action: "edit", resource: "*", effect: "allow" }]),
    })
  })

  it("forks a session and distinguishes local close from remote delete", async () => {
    await adapter.connect(config)
    await adapter.createSession()
    const fork = await adapter.forkSession("s1")
    expect(fork.id).toBe("s2")
    expect(client.session.fork).toHaveBeenCalledWith({
      sessionID: "s1",
      boundary: { type: "through" },
    })
    await adapter.closeSession("s2")
    expect(client.session.remove).not.toHaveBeenCalled()
    expect(adapter.getSession("s2")).toBeUndefined()
    await adapter.deleteSession("s1")
    expect(client.session.remove).toHaveBeenCalledWith({ sessionID: "s1" })
    expect(adapter.getSession("s1")).toBeUndefined()
    expect(adapter.getConfigOptions("s1")).toBeUndefined()
  })

  it("changes model variants through switchModel and rejects invalid config writes", async () => {
    await adapter.connect(config)
    await adapter.createSession()
    expect(adapter.getSessionModels("s1")?.availableModels).toEqual([
      { modelId: "vendor/model", name: "Model" },
    ])
    await adapter.setSessionModel("s1", "vendor/model")
    const options = await adapter.setConfigOption("s1", "variant", "deep")
    expect(options[0].currentValue).toBe("deep")
    expect(client.session.switchModel).toHaveBeenLastCalledWith({
      sessionID: "s1",
      model: { providerID: "vendor", id: "model", variant: "deep" },
    })
    await adapter.setConfigOption("s1", "variant", "#none")
    expect(client.session.switchModel).toHaveBeenLastCalledWith({
      sessionID: "s1",
      model: { providerID: "vendor", id: "model" },
    })
    for (const [key, value] of [
      ["variant", "bad"],
      ["unknown", "deep"],
      ["variant", true],
    ] as const) {
      await expect(adapter.setConfigOption("s1", key, value)).rejects.toThrow(
        /Invalid OpenCode model variant/
      )
    }
    await expect(adapter.setSessionMode("s1", "dontAsk")).rejects.toThrow(/does not support/)
    await adapter.setSessionMode("s1", "bypassPermissions")
    expect(client.permission.rules).toHaveBeenLastCalledWith({
      sessionID: "s1",
      permissions: [{ action: "*", resource: "*", effect: "allow" }],
    })
    await expect(adapter.setSessionModel("missing", "vendor/model")).rejects.toThrow(
      /Session not found/
    )
  })

  it("routes known slash commands and leaves unknown slash text as an ordinary prompt", async () => {
    await adapter.connect(config)
    await adapter.createSession()
    await collect(adapter.prompt("s1", textMessage("/review staged files")))
    expect(client.session.command).toHaveBeenCalledWith(
      { sessionID: "s1", command: "review", text: "staged files", delivery: "queue" },
      expect.any(Object)
    )
    await collect(adapter.prompt("s1", textMessage("/unknown input")))
    expect(client.session.prompt).toHaveBeenCalledWith(
      expect.objectContaining({ text: "/unknown input" }),
      expect.any(Object)
    )
  })

  it("does not submit or interrupt when the caller is already aborted", async () => {
    await adapter.connect(config)
    await adapter.createSession()
    const controller = new AbortController()
    controller.abort(new Error("caller cancelled"))
    await expect(
      collect(adapter.prompt("s1", message, { signal: controller.signal }))
    ).rejects.toThrow("caller cancelled")
    expect(client.session.prompt).not.toHaveBeenCalled()
    expect(client.session.interrupt).not.toHaveBeenCalled()
    expect(adapter.getSession("s1")?.status).toBe("active")
  })

  it.each(["signal", "cancel"])("interrupts a submitted turn once on %s", async (method) => {
    await adapter.connect(config)
    await adapter.createSession()
    client.event.subscribe.mockImplementation(abortableStream)
    const controller = new AbortController()
    const stream = adapter
      .prompt("s1", message, { signal: controller.signal })
      [Symbol.asyncIterator]()
    expect((await stream.next()).value).toMatchObject({ type: "message_delta" })
    const next = stream.next()
    const rejected = expect(next).rejects.toThrow()
    if (method === "signal") controller.abort()
    else await adapter.cancel("s1")
    await rejected
    expect(client.session.interrupt).toHaveBeenCalledTimes(1)
    expect(adapter.getSession("s1")?.status).toBe("active")
  })

  it("cancels remote execution when a consumer stops reading early", async () => {
    await adapter.connect(config)
    await adapter.createSession()
    const stream = adapter.prompt("s1", message)[Symbol.asyncIterator]()
    await stream.next()
    await stream.return?.()
    expect(client.session.interrupt).toHaveBeenCalledTimes(1)
    expect(adapter.getSession("s1")?.status).toBe("active")
    await collect(adapter.prompt("s1", message))
  })

  it("rejects concurrent prompts and only permits steering an active submitted turn", async () => {
    await adapter.connect(config)
    await adapter.createSession()
    await expect(adapter.steerTurn("s1", "more")).rejects.toThrow(/no active turn/)
    const stream = adapter.prompt("s1", message)[Symbol.asyncIterator]()
    await stream.next()
    await expect(collect(adapter.prompt("s1", message))).rejects.toThrow(
      /already has an active turn/
    )
    await adapter.steerTurn("s1", "focus on tests")
    expect(client.session.prompt).toHaveBeenLastCalledWith({
      sessionID: "s1",
      text: "focus on tests",
      delivery: "steer",
    })
    await stream.return?.()
  })

  it.each(["before-handshake", "after-handshake"])(
    "does not falsely report done when SSE ends %s",
    async (phase) => {
      await adapter.connect(config)
      await adapter.createSession()
      client.event.subscribe.mockImplementation(() =>
        phase === "before-handshake"
          ? streamEvents()
          : streamEvents(
              event("server.connected"),
              event("session.text.delta", {
                assistantMessageID: "a1",
                ordinal: 0,
                delta: "partial",
              })
            )
      )
      const events: ExternalAgentEvent[] = []
      await expect(
        (async () => {
          for await (const item of adapter.prompt("s1", message)) events.push(item)
        })()
      ).rejects.toThrow(/stream (closed|ended)/)
      expect(events.some((item) => item.type === "done")).toBe(false)
      expect(client.session.interrupt).toHaveBeenCalledTimes(phase === "before-handshake" ? 0 : 1)
    }
  )

  it("waits for execution completion across multiple model steps", async () => {
    await adapter.connect(config)
    await adapter.createSession()
    const tokens = { input: 3, output: 2, reasoning: 1, cache: { read: 0, write: 0 } }
    client.event.subscribe.mockImplementation(() =>
      streamEvents(
        event("server.connected"),
        event("session.text.delta", { assistantMessageID: "a1", ordinal: 0, delta: "First" }),
        event("session.step.ended", {
          assistantMessageID: "a1",
          tokens,
          cost: 0.01,
          finish: "tool-calls",
        }),
        event("session.text.delta", { assistantMessageID: "a2", ordinal: 0, delta: "Second" }),
        event("session.step.ended", {
          assistantMessageID: "a2",
          tokens,
          cost: 0.01,
          finish: "stop",
        }),
        event("session.execution.succeeded")
      )
    )
    const events = await collect(adapter.prompt("s1", message))
    expect(events.filter((item) => item.type === "message_delta")).toHaveLength(2)
    expect(events.filter((item) => item.type === "done")).toEqual([
      expect.objectContaining({
        success: true,
        tokenUsage: expect.objectContaining({ promptTokens: 6, completionTokens: 6 }),
      }),
    ])
    expect(client.session.interrupt).not.toHaveBeenCalled()
  })

  it("replies to permissions with once, always, and reject semantics", async () => {
    await adapter.connect(config)
    await adapter.createSession()
    await adapter.respondToPermission("s1", { requestId: "r1", granted: true })
    await adapter.respondToPermission("s1", {
      requestId: "r2",
      granted: true,
      scope: "always",
      reason: "Approved",
    })
    await adapter.respondToPermission("s1", { requestId: "r3", granted: false })
    expect(client.permission.reply.mock.calls.map(([input]) => input)).toEqual([
      { sessionID: "s1", requestID: "r1", reply: "once" },
      { sessionID: "s1", requestID: "r2", reply: "always", message: "Approved" },
      { sessionID: "s1", requestID: "r3", reply: "reject" },
    ])
  })

  it("forwards validated form answers and cancellation during a turn", async () => {
    await adapter.connect(config)
    await adapter.createSession()
    const form = {
      id: "f1",
      sessionID: "s1",
      title: "Select",
      fields: [{ type: "string", key: "choice", required: true }],
    }
    client.event.subscribe.mockImplementation(() =>
      streamEvents(
        event("server.connected"),
        event("form.created", { form }),
        event("form.created", { form: { ...form, id: "f2" } }),
        event("session.execution.succeeded")
      )
    )
    const stream = adapter.prompt("s1", message)[Symbol.asyncIterator]()
    expect((await stream.next()).value).toMatchObject({ type: "elicitation_request" })
    await adapter.respondToElicitation({
      requestId: "f1",
      action: "accept",
      content: { choice: "yes" },
    })
    expect(client.form.reply).toHaveBeenCalledWith({
      sessionID: "s1",
      formID: "f1",
      answer: { choice: "yes" },
    })
    await expect(
      adapter.respondToElicitation({ requestId: "f1", action: "cancel" })
    ).rejects.toThrow(/Unknown OpenCode form/)
    await stream.next()
    await adapter.respondToElicitation({ requestId: "f2", action: "cancel" })
    expect(client.form.cancel).toHaveBeenCalledWith({ sessionID: "s1", formID: "f2" })
    await stream.return?.()
  })

  it("compacts only known sessions and verifies the remote terminal outcome", async () => {
    await adapter.connect(config)
    expect(await adapter.getCompactionCapability("missing")).toMatchObject({ status: "unknown" })
    await adapter.createSession()
    expect(await adapter.getCompactionCapability("s1")).toMatchObject({ status: "supported" })
    await expect(adapter.compactSession("s1", { focus: "context" })).rejects.toThrow(
      /does not accept focus/
    )
    await adapter.compactSession("s1")
    expect(client.session.compact).toHaveBeenCalledWith(
      { sessionID: "s1", delivery: "queue" },
      expect.any(Object)
    )
    expect(client.session.wait).not.toHaveBeenCalled()
    client.event.subscribe.mockImplementation(() =>
      streamEvents(event("server.connected"), event("session.execution.interrupted"))
    )
    await expect(adapter.compactSession("s1")).rejects.toThrow(/compaction failed/)
    expect(adapter.getSessionExtensionSupport()).toMatchObject({
      "session/list": { state: "supported" },
      "session/resume": { state: "supported" },
      "session/fork": { state: "supported" },
    })
  })

  it("blocks PII-bearing prompt text, instruction envelopes, permission reasons, and native prompt calls", async () => {
    await adapter.connect(config)
    await adapter.createSession()
    await expect(
      collect(adapter.prompt("s1", textMessage("email alice@example.com")))
    ).rejects.toThrow(/PII/)
    await expect(adapter.createSession({ systemPrompt: "alice@example.com" })).rejects.toThrow(
      /PII/
    )
    await expect(
      adapter.respondToPermission("s1", {
        requestId: "r1",
        granted: true,
        reason: "alice@example.com",
      })
    ).rejects.toThrow(/PII/)
    expect(client.session.prompt).not.toHaveBeenCalled()
    const nativeFetch = jest.mocked(OpenCode.make).mock.calls.at(-1)![0]!.fetch!
    expect(() =>
      nativeFetch("https://host/api/session/s1/prompt", {
        method: "POST",
        body: JSON.stringify({ text: "alice@example.com" }),
      })
    ).toThrow(/PII/)
    expect(platformStreamingFetch).not.toHaveBeenCalled()
    await nativeFetch("https://host/api/session/s1/prompt", {
      method: "POST",
      body: JSON.stringify({ text: "safe" }),
    })
    expect(platformStreamingFetch).toHaveBeenCalledWith(
      "https://host/api/session/s1/prompt",
      expect.objectContaining({ readTimeout: 90000 })
    )
  })

  it("applies explicit resume instructions and model choices to the native session", async () => {
    await adapter.connect(config)
    await adapter.resumeSession("s1", {
      systemPrompt: "Resume policy",
      metadata: { model: "vendor/model#deep" },
      context: { task: "Continue" },
    })
    expect(client.session.switchModel).toHaveBeenCalledWith({
      sessionID: "s1",
      model: { providerID: "vendor", id: "model", variant: "deep" },
    })
    expect(client.session.instructions.entry.put).toHaveBeenCalledWith({
      sessionID: "s1",
      key: "cognia",
      value: 'Resume policy\n\n{"task":"Continue"}',
    })
  })

  it("applies fork permissions remotely and removes a fork when initialization fails", async () => {
    await adapter.connect(config)
    await adapter.forkSession("s1", { permissionMode: "plan" })
    expect(client.permission.rules).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionID: "s2",
        permissions: expect.arrayContaining([{ action: "*", resource: "*", effect: "deny" }]),
      })
    )
    client.session.instructions.entry.put.mockRejectedValueOnce(
      new Error("fork instructions failed")
    )
    await expect(adapter.forkSession("s1", { systemPrompt: "Policy" })).rejects.toThrow(
      "fork instructions failed"
    )
    expect(client.session.remove).toHaveBeenCalledWith({ sessionID: "s2" })
    await expect(adapter.forkSession("s1", { cwd: "/other" })).rejects.toThrow(
      /different working directory/
    )
  })

  it("times out an active turn and interrupts the remote execution", async () => {
    await adapter.connect(config)
    await adapter.createSession()
    client.event.subscribe.mockImplementation(abortableStream)
    const stream = adapter.prompt("s1", message, { timeout: 15 })[Symbol.asyncIterator]()
    await stream.next()
    await expect(stream.next()).rejects.toThrow(/timed out/)
    expect(client.session.interrupt).toHaveBeenCalledTimes(1)
  })

  it("cleans up and interrupts when submitting a prompt fails", async () => {
    await adapter.connect(config)
    await adapter.createSession()
    client.session.prompt.mockRejectedValueOnce(new Error("submission failed"))
    await expect(collect(adapter.prompt("s1", message))).rejects.toThrow("submission failed")
    expect(client.session.interrupt).toHaveBeenCalledTimes(1)
    expect(adapter.getSession("s1")?.status).toBe("active")
  })

  it.each(["utf-8", "base64"] as const)(
    "blocks PII in %s attachments before submission",
    async (encoding) => {
      await adapter.connect(config)
      await adapter.createSession()
      const unsafe = {
        ...message,
        content: [
          ...message.content,
          {
            type: "file" as const,
            path: "/tmp/contacts.txt",
            mimeType: "text/plain",
            encoding,
            content:
              encoding === "utf-8"
                ? "alice@example.com"
                : Buffer.from("alice@example.com").toString("base64"),
          },
        ],
      }
      await expect(collect(adapter.prompt("s1", unsafe))).rejects.toThrow(/PII gate/)
      expect(client.session.prompt).not.toHaveBeenCalled()
    }
  )

  it("preserves safe attachment data in the current prompt file contract", async () => {
    await adapter.connect(config)
    await adapter.createSession()
    await collect(
      adapter.prompt("s1", {
        ...message,
        content: [
          ...message.content,
          {
            type: "file",
            path: "/tmp/readme.txt",
            mimeType: "text/plain",
            content: "safe text",
            encoding: "utf-8",
          },
        ],
      })
    )
    expect(client.session.prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        files: [{ uri: expect.stringContaining("data:text/plain"), name: "readme.txt" }],
      }),
      expect.any(Object)
    )
  })
  it("disconnects an in-flight execution with one server interrupt and clears its catalogs", async () => {
    await adapter.connect(config)
    await adapter.createSession()
    client.event.subscribe.mockImplementation(abortableStream)
    const stream = adapter.prompt("s1", message)[Symbol.asyncIterator]()
    await stream.next()
    const next = stream.next()
    const rejected = expect(next).rejects.toThrow()
    await adapter.disconnect()
    await rejected
    expect(client.session.interrupt).toHaveBeenCalledTimes(1)
    expect(adapter.getSessions()).toEqual([])
    expect(adapter.getSessionModels("s1")).toBeUndefined()
    expect(() => adapter.getSdkClient()).toThrow(/Not connected/)
  })

  it("surfaces disconnect interruption failures while clearing the connection", async () => {
    await adapter.connect(config)
    await adapter.createSession()
    const stream = adapter.prompt("s1", message)[Symbol.asyncIterator]()
    await stream.next()
    client.session.interrupt.mockRejectedValueOnce(new Error("interrupt failed"))
    await expect(adapter.disconnect()).rejects.toThrow("interrupt failed")
    await expect(stream.return?.()).rejects.toThrow("interrupt failed")
    expect(adapter.connectionStatus).toBe("disconnected")
    expect(client.session.interrupt).toHaveBeenCalledTimes(1)
  })

  it("ignores other sessions and waits for the subscription handshake before submission", async () => {
    await adapter.connect(config)
    await adapter.createSession()
    client.event.subscribe.mockImplementation(() =>
      (async function* () {
        expect(client.session.prompt).not.toHaveBeenCalled()
        yield event("session.execution.succeeded")
        expect(client.session.prompt).not.toHaveBeenCalled()
        yield event("server.connected")
        expect(client.session.prompt).toHaveBeenCalledTimes(1)
        yield event("session.execution.failed", {
          sessionID: "other",
          error: { type: "Test", message: "Other failure" },
        })
        yield event("session.execution.succeeded")
      })()
    )
    const events = await collect(adapter.prompt("s1", message))
    expect(events).toEqual([expect.objectContaining({ type: "done", success: true })])
  })

  it("rejects PII in steering and elicitation answers before their outbound calls", async () => {
    await adapter.connect(config)
    await adapter.createSession()
    client.event.subscribe.mockImplementation(() =>
      streamEvents(
        event("server.connected"),
        event("form.created", {
          form: {
            list: jest.fn().mockResolvedValue([]),
            id: "f1",
            sessionID: "s1",
            title: "Input",
            fields: [{ type: "string", key: "value", required: true }],
          },
        }),
        event("session.execution.succeeded")
      )
    )
    const stream = adapter.prompt("s1", message)[Symbol.asyncIterator]()
    await stream.next()
    const calls = client.session.prompt.mock.calls.length
    await expect(adapter.steerTurn("s1", "alice@example.com")).rejects.toThrow(/PII/)
    await expect(
      adapter.respondToElicitation({
        requestId: "f1",
        action: "accept",
        content: { value: "alice@example.com" },
      })
    ).rejects.toThrow(/PII/)
    expect(client.session.prompt).toHaveBeenCalledTimes(calls)
    expect(client.form.reply).not.toHaveBeenCalled()
    await stream.return?.()
  })

  it("only advertises provider undo when the location exposes the undo command", async () => {
    await adapter.connect(config)
    await adapter.createSession()
    expect(await adapter.getProviderUndoCapability("missing")).toMatchObject({ status: "unknown" })
    expect(await adapter.getProviderUndoCapability("s1")).toMatchObject({ status: "unsupported" })
    await expect(adapter.undoLastProviderChange("s1")).rejects.toThrow(
      /does not support provider undo/
    )
    client.command.list.mockResolvedValue({
      data: [{ name: "undo", description: "Undo", template: "$ARGUMENTS" }],
    })
    await adapter.resumeSession("s1")
    expect(await adapter.getProviderUndoCapability("s1")).toMatchObject({ status: "supported" })
    await adapter.undoLastProviderChange("s1")
    expect(client.session.command).toHaveBeenCalledWith(
      expect.objectContaining({ command: "undo", text: "" }),
      expect.any(Object)
    )
  })

  it("does not submit a queued request into an already-running server execution", async () => {
    await adapter.connect(config)
    await adapter.createSession()
    client.session.active.mockResolvedValue({ s1: { status: "running" } })
    await expect(collect(adapter.prompt("s1", message))).rejects.toThrow(/already running/)
    expect(client.session.prompt).not.toHaveBeenCalled()
    expect(client.event.subscribe).not.toHaveBeenCalled()
    expect(client.session.interrupt).not.toHaveBeenCalled()
  })

  it("keeps existing native message ids stable instead of prefixing twice", async () => {
    await adapter.connect(config)
    await adapter.createSession()
    await collect(adapter.prompt("s1", { ...message, id: "msg_existing" }))
    expect(client.session.prompt).toHaveBeenCalledWith(
      expect.objectContaining({ id: "msg_existing" }),
      expect.any(Object)
    )
  })

  it("loads ordered history across pages when resuming", async () => {
    await adapter.connect(config)
    client.message.list
      .mockResolvedValueOnce({
        data: [{ id: "msg_user", type: "user", text: "Question", time: { created: 1000 } }],
        cursor: { next: "history-2" },
      })
      .mockResolvedValueOnce({
        data: [
          {
            id: "msg_assistant",
            type: "assistant",
            content: [{ type: "text", text: "Answer" }],
            time: { created: 2000 },
          },
        ],
        cursor: {},
      })
    const session = await adapter.resumeSession("s1")
    expect(session.messages?.map((entry) => entry.role)).toEqual(["user", "assistant"])
    expect(session.messages?.[1].content).toEqual([{ type: "text", text: "Answer" }])
    expect(client.message.list).toHaveBeenLastCalledWith({
      sessionID: "s1",
      limit: 100,
      cursor: "history-2",
    })
  })

  it("rejects a repeated history cursor instead of endlessly resuming", async () => {
    await adapter.connect(config)
    client.message.list.mockResolvedValue({ data: [], cursor: { next: "repeated" } })
    await expect(adapter.resumeSession("s1")).rejects.toThrow(/message pagination repeated/)
  })

  it("waits for plugin activation and uses the location default model for an unbound session", async () => {
    await adapter.connect(config)
    client.session.create.mockResolvedValueOnce({ ...info(), model: undefined } as never)
    await adapter.createSession()
    expect(client.model.default).toHaveBeenCalledWith({ location: { directory: "/workspace" } })
    expect(client.plugin.awaitActivation.mock.invocationCallOrder[0]).toBeLessThan(
      client.model.list.mock.invocationCallOrder[0]
    )
    expect(adapter.getSessionModels("s1")?.currentModelId).toBe("vendor/model")
  })

  it("cancels unsupported conditional forms so the server cannot wait on an invisible input", async () => {
    await adapter.connect(config)
    await adapter.createSession()
    client.event.subscribe.mockImplementation(() =>
      streamEvents(
        event("server.connected"),
        event("form.created", {
          form: {
            list: jest.fn().mockResolvedValue([]),
            id: "conditional",
            sessionID: "s1",
            title: "Conditional",
            fields: [{ type: "string", key: "value", when: [{ field: "other", value: "yes" }] }],
          },
        }),
        event("session.execution.succeeded")
      )
    )
    const events = await collect(adapter.prompt("s1", message))
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "error", code: "opencode_form_conditional_fields" }),
      ])
    )
    expect(client.form.cancel).toHaveBeenCalledWith({ sessionID: "s1", formID: "conditional" })
  })
  it.each([
    [
      {
        type: "image",
        source: { type: "url", url: "https://assets.test/image.png" },
        alt: "Diagram",
      },
      { uri: "https://assets.test/image.png", name: "Diagram" },
    ],
    [
      { type: "image", source: { type: "base64", data: "YQ==", mediaType: "image/png" } },
      { uri: "data:image/png;base64,YQ==" },
    ],
    [{ type: "audio", data: "YQ==", mimeType: "audio/wav" }, { uri: "data:audio/wav;base64,YQ==" }],
    [
      { type: "resource_link", uri: "https://assets.test/readme", name: "readme" },
      { uri: "https://assets.test/readme", name: "readme" },
    ],
    [
      { type: "resource", resource: { uri: "memory:note", text: "safe" } },
      { uri: "data:text/plain;base64,c2FmZQ==" },
    ],
    [
      { type: "resource", resource: { uri: "memory:binary", blob: "YQ==" } },
      { uri: "data:application/octet-stream;base64,YQ==" },
    ],
    [
      { type: "resource", resource: { uri: "https://assets.test/resource" } },
      { uri: "https://assets.test/resource" },
    ],
    [
      { type: "file", path: "src/readme.txt" },
      { uri: "file:///workspace/src/readme.txt", name: "readme.txt" },
    ],
    [
      { type: "file", path: "/tmp/read me.txt" },
      { uri: "file:///tmp/read%20me.txt", name: "read me.txt" },
    ],
    [
      { type: "file", path: "C:/work/readme.txt" },
      { uri: "file:///C:/work/readme.txt", name: "readme.txt" },
    ],
    [
      { type: "file", path: "https://assets.test/readme.txt" },
      { uri: "https://assets.test/readme.txt", name: "readme.txt" },
    ],
    [
      { type: "file", path: "readme.txt", content: "c2FmZQ==", encoding: "base64" },
      { uri: "data:text/plain;base64,c2FmZQ==", name: "readme.txt" },
    ],
  ])("preserves native attachment semantics %#", async (part, file) => {
    await adapter.connect(config)
    await adapter.createSession()
    await collect(
      adapter.prompt("s1", { ...message, content: [...message.content, part] } as never)
    )
    expect(client.session.prompt).toHaveBeenCalledWith(
      expect.objectContaining({ files: [file] }),
      expect.any(Object)
    )
  })

  it.each([
    { type: "thinking", thinking: "Internal content" },
    { type: "image", source: { type: "base64", mediaType: "image/png" } },
  ])("rejects malformed or unsupported prompt content %# without sending", async (part) => {
    await adapter.connect(config)
    await adapter.createSession()
    await expect(
      collect(adapter.prompt("s1", { ...message, content: [part] } as never))
    ).rejects.toThrow(/does not accept|no source/)
    expect(client.session.prompt).not.toHaveBeenCalled()
  })
  it.each([
    [
      "base64 text",
      `data:text/plain;base64,${Buffer.from("alice@example.com").toString("base64")}`,
    ],
    ["percent-encoded text", "data:text/plain,alice%40example.com"],
    ["default text MIME", "data:,alice%40example.com"],
    [
      "default text MIME with base64",
      `data:;base64,${Buffer.from("alice@example.com").toString("base64")}`,
    ],
    ["SVG text", `data:image/svg+xml,${encodeURIComponent("<svg>alice@example.com</svg>")}`],
    [
      "structured JSON MIME",
      `data:application/vnd.api+json;base64,${Buffer.from('{"contact":"alice@example.com"}').toString("base64")}`,
    ],
    [
      "MIME parameters",
      `data:TEXT/PLAIN;charset=utf-8;BASE64,${Buffer.from("alice@example.com").toString("base64")}`,
    ],
  ])("blocks nested native JSON %s data URIs before network I/O", async (_kind, uri) => {
    await adapter.connect(config)
    const nativeFetch = jest.mocked(OpenCode.make).mock.calls.at(-1)![0]!.fetch!
    expect(() =>
      nativeFetch("https://host/api/session/s1/prompt", {
        method: "POST",
        body: JSON.stringify({ messages: [{ content: [{ attachment: { uri } }] }] }),
      })
    ).toThrow(/PII gate/)
    expect(platformStreamingFetch).not.toHaveBeenCalled()
  })

  it.each([
    ["base64", "data:text/plain;base64,not~base64"],
    ["percent encoding", "data:text/plain,%GG"],
    ["base64 UTF-8", "data:text/plain;base64,/w=="],
    ["percent UTF-8", "data:text/plain,%FF"],
  ])("rejects invalid native text attachment %s before network I/O", async (_kind, uri) => {
    await adapter.connect(config)
    const nativeFetch = jest.mocked(OpenCode.make).mock.calls.at(-1)![0]!.fetch!
    expect(() =>
      nativeFetch("https://host/api/session/s1/prompt", {
        method: "POST",
        body: JSON.stringify({ files: [{ uri }] }),
      })
    ).toThrow(/not valid encoded text/)
    expect(platformStreamingFetch).not.toHaveBeenCalled()
  })

  it.each([
    "data:text/plain;base64,c2FmZSB0ZXh0",
    "data:text/plain,safe%20text",
    "data:image/png;base64,YQ==",
    "data:application/octet-stream;base64,YQ==",
  ])("preserves valid safe native data URI %s", async (uri) => {
    await adapter.connect(config)
    const nativeFetch = jest.mocked(OpenCode.make).mock.calls.at(-1)![0]!.fetch!
    const body = JSON.stringify({ files: [{ uri }], enabled: true, count: 1, optional: null })
    await nativeFetch("https://host/api/session/s1/prompt", { method: "POST", body })
    expect(platformStreamingFetch).toHaveBeenCalledWith(
      "https://host/api/session/s1/prompt",
      expect.objectContaining({ body })
    )
  })
  it("restores typed forms and permissions as pending interactions without starting a prompt", async () => {
    await adapter.connect(config)
    client.permission.list.mockResolvedValue([
      {
        id: "restored-permission",
        sessionID: "s1",
        action: "shell",
        resources: ["pwd"],
        save: ["pwd"],
        source: { type: "tool", id: "call1", messageID: "msg_previous" },
      },
    ])
    client.form.list.mockResolvedValue([
      {
        id: "restored-form",
        sessionID: "s1",
        title: "Build options",
        fields: [
          { type: "integer", key: "count", required: true, minimum: 1, maximum: 10 },
          { type: "boolean", key: "enabled", required: true },
          {
            type: "multiselect",
            key: "targets",
            options: [{ value: "web", label: "Web" }],
            required: true,
          },
        ],
      },
    ])
    const session = await adapter.resumeSession("s1")
    expect(client.permission.list).toHaveBeenCalledWith({ sessionID: "s1" })
    expect(client.form.list).toHaveBeenCalledWith({ sessionID: "s1" })
    expect(session.metadata?.pendingInteractions).toEqual([
      expect.objectContaining({
        type: "permission_request",
        request: expect.objectContaining({ id: "restored-permission", toolCallId: "call1" }),
      }),
      expect.objectContaining({
        type: "elicitation_request",
        request: expect.objectContaining({
          id: "restored-form",
          requestedSchema: expect.objectContaining({
            properties: expect.objectContaining({
              count: expect.objectContaining({ type: "integer" }),
              enabled: expect.objectContaining({ type: "boolean" }),
              targets: expect.objectContaining({ type: "array" }),
            }),
          }),
        }),
      }),
    ])
    await adapter.respondToPermission("s1", { requestId: "restored-permission", granted: true })
    expect(session.metadata?.pendingInteractions).toHaveLength(1)
    const answer = { count: 2, enabled: true, targets: ["web"] }
    await adapter.respondToElicitation({
      requestId: "restored-form",
      action: "accept",
      content: answer,
    })
    expect(client.form.reply).toHaveBeenCalledWith({
      sessionID: "s1",
      formID: "restored-form",
      answer,
    })
    expect(session.metadata?.pendingInteractions).toEqual([])
    expect(client.session.prompt).not.toHaveBeenCalled()
    expect(client.event.subscribe).not.toHaveBeenCalled()
  })

  it("keeps a restored permission pending when the reply fails and resolves it after retry", async () => {
    await adapter.connect(config)
    client.permission.list.mockResolvedValue([
      { id: "permission-retry", sessionID: "s1", action: "shell", resources: ["pwd"], save: [] },
    ])
    const session = await adapter.resumeSession("s1")
    client.permission.reply.mockRejectedValueOnce(new Error("reply offline"))
    await expect(
      adapter.respondToPermission("s1", { requestId: "permission-retry", granted: false })
    ).rejects.toThrow("reply offline")
    expect(session.metadata?.pendingInteractions).toHaveLength(1)
    await adapter.respondToPermission("s1", { requestId: "permission-retry", granted: false })
    expect(session.metadata?.pendingInteractions).toEqual([])
    expect(client.permission.reply).toHaveBeenCalledTimes(2)
  })

  it("keeps a restored form answerable after validation or transport failure", async () => {
    await adapter.connect(config)
    client.form.list.mockResolvedValue([
      {
        id: "form-retry",
        sessionID: "s1",
        title: "Count",
        fields: [{ type: "integer", key: "count", required: true, minimum: 1 }],
      },
    ])
    const session = await adapter.resumeSession("s1")
    await expect(
      adapter.respondToElicitation({
        requestId: "form-retry",
        action: "accept",
        content: { count: "wrong type" },
      })
    ).rejects.toThrow()
    expect(client.form.reply).not.toHaveBeenCalled()
    client.form.reply.mockRejectedValueOnce(new Error("form offline"))
    await expect(
      adapter.respondToElicitation({
        requestId: "form-retry",
        action: "accept",
        content: { count: 1 },
      })
    ).rejects.toThrow("form offline")
    expect(session.metadata?.pendingInteractions).toHaveLength(1)
    await adapter.respondToElicitation({
      requestId: "form-retry",
      action: "accept",
      content: { count: 1 },
    })
    expect(session.metadata?.pendingInteractions).toEqual([])
    await expect(
      adapter.respondToElicitation({ requestId: "form-retry", action: "cancel" })
    ).rejects.toThrow(/Unknown OpenCode form/)
  })

  it("cancels restored forms and preserves failed cancellation for retry", async () => {
    await adapter.connect(config)
    client.form.list.mockResolvedValue([
      {
        id: "form-cancel",
        sessionID: "s1",
        title: "Cancel",
        fields: [{ type: "string", key: "value" }],
      },
    ])
    const session = await adapter.resumeSession("s1")
    client.form.cancel.mockRejectedValueOnce(new Error("cancel offline"))
    await expect(
      adapter.respondToElicitation({ requestId: "form-cancel", action: "cancel" })
    ).rejects.toThrow("cancel offline")
    expect(session.metadata?.pendingInteractions).toHaveLength(1)
    await adapter.respondToElicitation({ requestId: "form-cancel", action: "decline" })
    expect(client.form.cancel).toHaveBeenLastCalledWith({ sessionID: "s1", formID: "form-cancel" })
    expect(session.metadata?.pendingInteractions).toEqual([])
  })

  it("explicitly cancels unsupported restored forms and retains their diagnostic event", async () => {
    await adapter.connect(config)
    client.form.list.mockResolvedValue([
      {
        id: "restored-conditional",
        sessionID: "s1",
        title: "Conditional",
        fields: [{ type: "string", key: "value", when: [{ field: "other", value: "yes" }] }],
      },
    ])
    const session = await adapter.resumeSession("s1")
    expect(client.form.cancel).toHaveBeenCalledWith({
      sessionID: "s1",
      formID: "restored-conditional",
    })
    expect(session.metadata?.pendingInteractions).toEqual([
      expect.objectContaining({ type: "error", code: "opencode_form_conditional_fields" }),
    ])
    await expect(
      adapter.respondToElicitation({
        requestId: "restored-conditional",
        action: "accept",
        content: { value: "yes" },
      })
    ).rejects.toThrow(/Unknown OpenCode form/)
  })

  it.each(["close", "disconnect", "resume"])(
    "forgets restored requests after %s",
    async (operation) => {
      await adapter.connect(config)
      client.form.list.mockResolvedValueOnce([
        {
          id: "stale-form",
          sessionID: "s1",
          title: "Stale",
          fields: [{ type: "string", key: "value" }],
        },
      ])
      await adapter.resumeSession("s1")
      if (operation === "close") await adapter.closeSession("s1")
      else if (operation === "disconnect") await adapter.disconnect()
      else await adapter.resumeSession("s1")
      await expect(
        adapter.respondToElicitation({ requestId: "stale-form", action: "cancel" })
      ).rejects.toThrow(/Unknown OpenCode form/)
      expect(client.form.cancel).not.toHaveBeenCalled()
    }
  )
  it("enforces numeric bounds on a restored typed form before sending an answer", async () => {
    await adapter.connect(config)
    client.form.list.mockResolvedValue([
      {
        id: "bounded-form",
        sessionID: "s1",
        title: "Count",
        fields: [{ type: "integer", key: "count", required: true, minimum: 1, maximum: 3 }],
      },
    ])
    const session = await adapter.resumeSession("s1")
    await expect(
      adapter.respondToElicitation({
        requestId: "bounded-form",
        action: "accept",
        content: { count: 0 },
      })
    ).rejects.toThrow()
    expect(client.form.reply).not.toHaveBeenCalled()
    expect(session.metadata?.pendingInteractions).toHaveLength(1)
  })
  it.each<[string, Record<string, unknown>, AcpElicitationValue]>([
    ["numeric maximum", { type: "number", key: "value", minimum: 1, maximum: 3 }, 4],
    ["string minimum", { type: "string", key: "value", minLength: 2 }, "a"],
    ["string maximum", { type: "string", key: "value", maxLength: 2 }, "abc"],
    ["string pattern", { type: "string", key: "value", pattern: "^[a-z]+$" }, "ABC"],
    [
      "array minimum",
      { type: "multiselect", key: "value", minItems: 1, options: [{ value: "web", label: "Web" }] },
      [],
    ],
    [
      "array maximum",
      {
        type: "multiselect",
        key: "value",
        maxItems: 1,
        options: [
          { value: "web", label: "Web" },
          { value: "cli", label: "CLI" },
        ],
      },
      ["web", "cli"],
    ],
    [
      "unknown array choice",
      { type: "multiselect", key: "value", options: [{ value: "web", label: "Web" }] },
      ["unknown"],
    ],
  ])(
    "rejects restored form %s violations without consuming the pending request",
    async (_label, field, value) => {
      await adapter.connect(config)
      client.form.list.mockResolvedValue([
        {
          id: "constraints",
          sessionID: "s1",
          title: "Constraints",
          fields: [{ ...field, required: true }],
        },
      ])
      const session = await adapter.resumeSession("s1")
      await expect(
        adapter.respondToElicitation({
          requestId: "constraints",
          action: "accept",
          content: { value: value as AcpElicitationValue },
        })
      ).rejects.toThrow()
      expect(client.form.reply).not.toHaveBeenCalled()
      expect(session.metadata?.pendingInteractions).toHaveLength(1)
    }
  )

  it.each<[string, Record<string, unknown>, AcpElicitationValue]>([
    ["numeric minimum", { type: "number", key: "value", minimum: 1, maximum: 3 }, 1],
    ["numeric maximum", { type: "number", key: "value", minimum: 1, maximum: 3 }, 3],
    [
      "Unicode codepoint length",
      { type: "string", key: "value", minLength: 1, maxLength: 1, pattern: "^😀$" },
      "😀",
    ],
    [
      "string exact boundary",
      { type: "string", key: "value", minLength: 2, maxLength: 2, pattern: "^[a-z]+$" },
      "ab",
    ],
    [
      "array exact boundary",
      {
        type: "multiselect",
        key: "value",
        minItems: 1,
        maxItems: 1,
        options: [{ value: "web", label: "Web" }],
      },
      ["web"],
    ],
  ])(
    "accepts restored form %s boundaries with the original typed value",
    async (_label, field, value) => {
      await adapter.connect(config)
      client.form.list.mockResolvedValue([
        {
          id: "valid-boundary",
          sessionID: "s1",
          title: "Valid",
          fields: [{ ...field, required: true }],
        },
      ])
      const session = await adapter.resumeSession("s1")
      await adapter.respondToElicitation({
        requestId: "valid-boundary",
        action: "accept",
        content: { value: value as AcpElicitationValue },
      })
      expect(client.form.reply).toHaveBeenCalledWith({
        sessionID: "s1",
        formID: "valid-boundary",
        answer: { value },
      })
      expect(session.metadata?.pendingInteractions).toEqual([])
    }
  )

  it("interrupts immediately when the caller aborts while the generator is paused at a yield", async () => {
    await adapter.connect(config)
    await adapter.createSession()
    const controller = new AbortController()
    const stream = adapter
      .prompt("s1", message, { signal: controller.signal })
      [Symbol.asyncIterator]()
    await stream.next()
    controller.abort(new Error("paused caller aborted"))
    expect(client.session.interrupt).toHaveBeenCalledTimes(1)
    await expect(stream.next()).rejects.toThrow("paused caller aborted")
    expect(client.session.interrupt).toHaveBeenCalledTimes(1)
    expect(adapter.getSession("s1")?.status).toBe("active")
  })
})
