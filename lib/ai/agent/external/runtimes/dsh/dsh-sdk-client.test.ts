import type {
  ExternalAgentConfig,
  ExternalAgentEvent,
  ExternalAgentMessage,
} from "@/types/agent/external-agent"
import {
  DshSdkRuntimeAdapter as DshSdkClientAdapter,
  DshSdkClientAdapter as HostedDshAdapter,
  type DshPromptContentBlock,
  type DshRuntimeTransport,
  type DshRuntimeTransportHandlers,
} from "./dsh-sdk-client"

class FakeTransport implements DshRuntimeTransport {
  handlers?: DshRuntimeTransportHandlers
  running = false
  closed = 0
  prompts: Array<{ sessionId: string; contentBlocks: DshPromptContentBlock[] }> = []
  receipt: Promise<string> = Promise.resolve("msg-1")
  async start(handlers: DshRuntimeTransportHandlers) {
    this.handlers = handlers
    this.running = true
  }
  async prompt(sessionId: string, contentBlocks: DshPromptContentBlock[]) {
    this.prompts.push({ sessionId, contentBlocks })
    return this.receipt
  }
  async close() {
    this.closed++
    this.running = false
  }
  isRunning() {
    return this.running
  }
  event(sessionId: string, type: string, data: unknown = {}) {
    this.raw({
      method: "session.event",
      params: { sessionId, event: { type, data, seq: 1, time: 1234 } },
    })
  }
  status(sessionId: string, status: string) {
    this.raw({ method: "session.status", params: { sessionId, status } })
  }
  raw(notification: unknown) {
    this.handlers?.onNotification(notification)
  }
  turn(sessionId: string, text = "answer", kind = "completed", messageId = "msg-1") {
    this.event(sessionId, "turn/start")
    this.event(sessionId, "user/message", {
      id: messageId,
      content: [{ type: "text", text: "hello" }],
    })
    this.event(sessionId, "assistant/message", {
      message: { id: "assistant", content: [{ type: "text", text }] },
      stream: [],
      usage: { inputTokens: 3, outputTokens: 2 },
    })
    this.event(sessionId, "turn/end", {
      reason: {
        kind,
        ...(kind === "error" ? { error: { message: "provider failure", code: "X" } } : {}),
      },
    })
    this.status(sessionId, "idle")
  }
}
const CONFIG: ExternalAgentConfig = {
  id: "agent",
  name: "DeepSeek Harness test",
  protocol: "dsh-sdk",
  transport: "stdio",
  enabled: true,
  process: { command: "node", cwd: "/workspace", env: { COGNIA_DSH_MODEL: "deepseek-v4-flash" } },
}
const MESSAGE = { role: "user", content: [{ type: "text", text: "hello" }] } as ExternalAgentMessage

describe("DSH Cognia session hosting", () => {
  it("mounts each conversation's tools in an isolated process and closes only its owner", async () => {
    const configs: ExternalAgentConfig[] = []
    const transports: FakeTransport[] = []
    const adapter = new HostedDshAdapter({
      createTransport: (config) => {
        configs.push(config)
        const transport = new FakeTransport()
        transports.push(transport)
        return transport
      },
    })
    await adapter.connect(CONFIG)
    const server = (token: string) => ({
      name: "cognia-tools",
      command: "/node",
      args: ["/bridge"],
      env: [{ name: "TOKEN", value: token }],
    })
    const a = await adapter.createSession({ mcpServers: [server("a")], cwd: "/workspace/a" })
    const b = await adapter.createSession({ mcpServers: [server("b")], cwd: "/workspace/b" })
    expect(configs).toHaveLength(3)
    expect(configs[0].process?.env?.COGNIA_DSH_MCP_SERVERS).toBeUndefined()
    expect(JSON.parse(configs[1].process!.env!.COGNIA_DSH_MCP_SERVERS)).toEqual([server("a")])
    expect(JSON.stringify(configs[2])).not.toContain('"value":"a"')
    expect(configs[1].process?.env?.COGNIA_DSH_WORKSPACE).toBe("/workspace/a")
    expect(a.agentId).toBe(CONFIG.id)
    const ar = adapter.execute(a.id, MESSAGE)
    const br = adapter.execute(b.id, MESSAGE)
    await adapter.cancel(a.id)
    transports[2].turn(b.id)
    await expect(ar).resolves.toMatchObject({ success: false })
    await expect(br).resolves.toMatchObject({ success: true })
    expect(transports[2].closed).toBe(0)
    expect(adapter.isConnected()).toBe(true)
    await adapter.disconnect()
    expect(transports.every((t) => !t.running)).toBe(true)
  })
})
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function hosted(customize?: (transport: FakeTransport, index: number) => void) {
  const transports: FakeTransport[] = []
  const configs: ExternalAgentConfig[] = []
  const adapter = new HostedDshAdapter({
    createTransport: (config) => {
      const transport = new FakeTransport()
      customize?.(transport, transports.length)
      configs.push(config)
      transports.push(transport)
      return transport
    },
  })
  return { adapter, transports, configs }
}

describe("DSH hosted conversation lifecycle", () => {
  it("requires connection, exposes MCP capability and refuses unknown session operations", async () => {
    const { adapter } = hosted()
    expect(adapter.protocol).toBe("dsh-sdk")
    expect(adapter.capabilities).toMatchObject({ mcpTools: true })
    expect(await adapter.healthCheck()).toBe(false)
    await expect(adapter.createSession()).rejects.toThrow("not connected")
    expect(() => adapter.prompt("missing", MESSAGE)).toThrow("Unknown")
    expect(() => adapter.respondToPermission("missing", {} as never)).toThrow("Unknown")
    await expect(adapter.cancel("missing")).resolves.toBeUndefined()
    expect(adapter.getSession("missing")).toBeUndefined()
    expect(adapter.getSessions()).toEqual([])
  })
  it("connects idempotently with discovery stripped of conversation MCP credentials", async () => {
    const { adapter, configs, transports } = hosted()
    await adapter.connect({
      ...CONFIG,
      process: {
        ...CONFIG.process!,
        env: {
          ...CONFIG.process?.env,
          COGNIA_DSH_MCP_SERVERS: "private-server",
          COGNIA_DSH_MCP_CONFIGS: "private-config",
        },
      },
    })
    await adapter.connect(CONFIG)
    expect(configs).toHaveLength(1)
    expect(configs[0].process!.env!.COGNIA_DSH_MCP_SERVERS).toBeUndefined()
    expect(configs[0].process!.env!.COGNIA_DSH_MCP_CONFIGS).toBeUndefined()
    transports[0].running = false
    transports[0].handlers?.onClosed("discovery failed")
    expect(adapter.connectionStatus).toBe("disconnected")
    expect(adapter.isConnected()).toBe(false)
    await adapter.disconnect()
  })
  it("surfaces discovery startup failure and can reconnect successfully", async () => {
    const { adapter, transports } = hosted((transport, index) => {
      if (index === 0)
        transport.start = async () => {
          throw new Error("discovery startup failed")
        }
    })
    await expect(adapter.connect(CONFIG)).rejects.toThrow("discovery startup failed")
    expect(adapter.connectionStatus).toBe("error")
    await adapter.connect(CONFIG)
    expect(adapter.isConnected()).toBe(true)
    expect(transports[0].closed).toBe(1)
    await adapter.disconnect()
  })
  it("retains discovery cleanup failure for retry", async () => {
    const { adapter, transports } = hosted()
    await adapter.connect(CONFIG)
    const close = jest
      .spyOn(transports[0], "close")
      .mockRejectedValueOnce(new Error("discovery kill failed"))
    await expect(adapter.disconnect()).rejects.toThrow("runtime cleanup failed")
    expect(adapter.connectionStatus).toBe("error")
    await adapter.disconnect()
    expect(close).toHaveBeenCalledTimes(2)
    expect(transports[0].running).toBe(false)
  })
  it("keeps failed child cleanup owned until closeSession succeeds", async () => {
    const { adapter, transports } = hosted()
    await adapter.connect(CONFIG)
    const session = await adapter.createSession()
    const close = jest
      .spyOn(transports[1], "close")
      .mockRejectedValueOnce(new Error("child kill failed"))
    await expect(adapter.closeSession(session.id)).rejects.toThrow("child kill failed")
    expect(adapter.getSession(session.id)).toBeUndefined()
    await adapter.closeSession(session.id)
    expect(close).toHaveBeenCalledTimes(2)
    expect(adapter.getSessions()).toEqual([])
    expect(adapter.isConnected()).toBe(true)
    await adapter.disconnect()
  })
  it("coalesces concurrent cancel and disconnect without double-closing the child", async () => {
    const closing = deferred<void>()
    const { adapter, transports } = hosted()
    await adapter.connect(CONFIG)
    const session = await adapter.createSession()
    const close = jest.spyOn(transports[1], "close").mockImplementation(async () => {
      await closing.promise
      transports[1].running = false
    })
    const cancelled = adapter.cancel(session.id)
    const stopped = adapter.disconnect()
    const stoppedAgain = adapter.disconnect()
    await tick()
    expect(close).toHaveBeenCalledTimes(1)
    closing.resolve()
    await Promise.all([cancelled, stopped, stoppedAgain])
    expect(adapter.getSessions()).toEqual([])
    expect(adapter.connectionStatus).toBe("disconnected")
  })
  it("cleans a child whose startup fails without damaging discovery", async () => {
    const { adapter, transports } = hosted((transport, index) => {
      if (index === 1)
        transport.start = async () => {
          throw new Error("child initialization failed")
        }
    })
    await adapter.connect(CONFIG)
    await expect(adapter.createSession()).rejects.toThrow("child initialization failed")
    expect(transports[1].closed).toBe(1)
    expect(adapter.getSessions()).toEqual([])
    expect(adapter.isConnected()).toBe(true)
    await adapter.disconnect()
  })
  it("retains repeated child startup-cleanup failures for host disconnect retry", async () => {
    const { adapter, transports } = hosted((transport, index) => {
      if (index === 1) {
        transport.start = async () => {
          transport.running = true
          throw new Error("child initialization failed")
        }
        jest
          .spyOn(transport, "close")
          .mockRejectedValueOnce(new Error("first reap failed"))
          .mockRejectedValueOnce(new Error("second reap failed"))
      }
    })
    await adapter.connect(CONFIG)
    await expect(adapter.createSession()).rejects.toThrow("session startup and cleanup failed")
    await adapter.disconnect()
    expect(transports[1].close).toHaveBeenCalledTimes(3)
    expect(transports[1].running).toBe(false)
  })
  it("waits for pending child initialization before completing disconnect", async () => {
    const starting = deferred<void>()
    const { adapter, transports } = hosted((transport, index) => {
      if (index === 1)
        transport.start = async (handlers) => {
          transport.handlers = handlers
          transport.running = true
          await starting.promise
        }
    })
    await adapter.connect(CONFIG)
    const creating = adapter.createSession()
    const expectedRejection = expect(creating).rejects.toThrow("session cancelled")
    const stopped = adapter.disconnect()
    let ended = false
    void stopped.then(() => {
      ended = true
    })
    await tick()
    expect(ended).toBe(false)
    starting.resolve()
    await expectedRejection
    await stopped
    expect(adapter.getSessions()).toEqual([])
    expect(transports.every((transport) => !transport.running)).toBe(true)
  })
  it("cancels pending discovery initialization without resurrecting the connection", async () => {
    const starting = deferred<void>()
    const entered = deferred<void>()
    const { adapter, transports } = hosted((transport) => {
      transport.start = async (handlers) => {
        transport.handlers = handlers
        transport.running = true
        entered.resolve()
        await starting.promise
      }
    })
    const connecting = adapter.connect(CONFIG)
    const expectedRejection = expect(connecting).rejects.toThrow("connection cancelled")
    await entered.promise
    const stopped = adapter.disconnect()
    starting.resolve()
    await expectedRejection
    await stopped
    expect(adapter.isConnected()).toBe(false)
    expect(transports.every((transport) => !transport.running)).toBe(true)
  })
  it("does not start discovery after an immediate stop during connect preparation", async () => {
    const { adapter, transports } = hosted()
    const connecting = adapter.connect(CONFIG)
    const stopped = adapter.disconnect()
    await Promise.allSettled([connecting, stopped])
    const connectedAfterStop = adapter.isConnected()
    const leakedRuntime = transports.some((transport) => transport.running)
    await adapter.disconnect()
    expect(connectedAfterStop).toBe(false)
    expect(leakedRuntime).toBe(false)
  })
  it("mounts exact options and rejects later tool/model changes before admission", async () => {
    const { adapter, configs, transports } = hosted()
    await adapter.connect(CONFIG)
    const servers = [
      {
        name: "cognia",
        command: "/node",
        args: ["/mcp"],
        env: [{ name: "TOKEN", value: "broker-secret" }],
      },
    ]
    const options = {
      cwd: "/workspace/task",
      allowedTools: ["cognia_read"],
      additionalDirectories: ["/extra"],
      mcpServers: servers,
      metadata: {
        selectedModel: "chosen-model",
        reasoningEffort: "high",
        cogniaSessionId: "chat-identity",
      },
      systemPrompt: "Follow Cognia guidance",
      instructionEnvelope: { hash: "h", developerInstructions: "Keep scope small" },
      context: {
        workingDirectory: "/workspace/task",
        custom: {
          mcpServers: servers,
          additionalDirectories: ["/extra"],
          traceId: "private-trace",
          sessionId: "private-session",
        },
      },
    }
    const session = await adapter.createSession(options)
    expect(session.agentId).toBe(CONFIG.id)
    expect(configs[1].id).not.toBe(CONFIG.id)
    expect(session.metadata).toMatchObject({
      cogniaSessionId: "chat-identity",
      cwd: "/workspace/task",
      additionalDirectories: ["/extra"],
    })
    expect(adapter.getSession(session.id)).toBe(session)
    expect(adapter.getSessions()).toEqual([session])
    expect(configs[1].process!.env).toMatchObject({
      COGNIA_DSH_MODEL: "chosen-model",
      COGNIA_DSH_REASONING_EFFORT: "high",
      COGNIA_DSH_ALLOWED_TOOLS: '["cognia_read"]',
      COGNIA_DSH_ADDITIONAL_DIRECTORIES: '["/extra"]',
    })
    expect(() => adapter.prompt(session.id, MESSAGE, { allowedTools: ["write"] })).toThrow(
      "per-session overrides"
    )
    expect(() =>
      adapter.prompt(session.id, MESSAGE, {
        context: { custom: { mcpServers: [{ ...servers[0], name: "replacement" }] } },
      })
    ).toThrow("per-session overrides")
    expect(() => adapter.prompt(session.id, MESSAGE, { model: "other" })).toThrow(
      "per-session overrides"
    )
    const result = adapter.execute(session.id, MESSAGE, {
      allowedTools: ["cognia_read"],
      model: "chosen-model",
      reasoningEffort: "high",
      workingDirectory: "/workspace/task",
      context: options.context,
    })
    const prompt = JSON.stringify(transports[1].prompts[0].contentBlocks)
    for (const secret of ["broker-secret", "private-trace", "private-session", "chat-identity"])
      expect(prompt).not.toContain(secret)
    expect(prompt).toContain("Follow Cognia guidance")
    expect(prompt).toContain("Keep scope small")
    transports[1].turn(session.id)
    await expect(result).resolves.toMatchObject({ success: true })
    await expect(adapter.respondToPermission(session.id, {} as never)).rejects.toThrow(
      "cannot carry permission requests"
    )
    await adapter.disconnect()
  })
  it("accepts context-mounted MCP and roots and keeps malformed requests from leaving children", async () => {
    const { adapter, configs, transports } = hosted()
    await adapter.connect(CONFIG)
    const server = { name: "cognia", command: "/node", args: [] }
    const session = await adapter.createSession({
      context: { custom: { mcpServers: [server], additionalDirectories: ["/extra"] } },
    })
    expect(JSON.parse(configs[1].process!.env!.COGNIA_DSH_MCP_SERVERS)).toEqual([server])
    expect(JSON.parse(configs[1].process!.env!.COGNIA_DSH_ADDITIONAL_DIRECTORIES)).toEqual([
      "/extra",
    ])
    await expect(adapter.createSession({ mcpServers: { invalid: true } as never })).rejects.toThrow(
      "per-session overrides"
    )
    expect(transports[2].running).toBe(false)
    expect(adapter.getSessions()).toEqual([session])
    await adapter.disconnect()
  })
  it("isolates child process failure and health cleanup from a live sibling", async () => {
    const { adapter, transports } = hosted()
    await adapter.connect(CONFIG)
    const failed = await adapter.createSession()
    const healthy = await adapter.createSession()
    const failure = adapter.execute(failed.id, MESSAGE)
    const success = adapter.execute(healthy.id, MESSAGE)
    transports[1].running = false
    transports[1].handlers?.onClosed("child crashed")
    transports[2].turn(healthy.id, "sibling answer")
    await expect(failure).resolves.toMatchObject({ success: false, error: "child crashed" })
    await expect(success).resolves.toMatchObject({ success: true, finalResponse: "sibling answer" })
    expect(await adapter.healthCheck()).toBe(true)
    expect(adapter.getSession(failed.id)).toBeUndefined()
    expect(adapter.getSessions()).toEqual([healthy])
    expect(transports[2].closed).toBe(0)
    await adapter.disconnect()
  })
  it("forgets owned sessions by awaiting normal runtime disposal", async () => {
    const { adapter, transports } = hosted()
    await adapter.connect(CONFIG)
    const session = await adapter.createSession()
    const result = adapter.execute(session.id, MESSAGE)
    adapter.forgetSessions()
    await expect(result).resolves.toMatchObject({ success: false })
    await adapter.disconnect()
    expect(adapter.getSessions()).toEqual([])
    expect(transports.every((transport) => !transport.running)).toBe(true)
  })
  it("records a failed background forget and permits retry", async () => {
    const { adapter, transports } = hosted()
    await adapter.connect(CONFIG)
    jest.spyOn(transports[0], "close").mockRejectedValueOnce(new Error("reap failed"))
    adapter.forgetSessions()
    await expect(adapter.disconnect()).rejects.toThrow("runtime cleanup failed")
    await tick()
    expect(adapter.connectionStatus).toBe("error")
    await adapter.disconnect()
    expect(adapter.connectionStatus).toBe("disconnected")
  })
})
const tick = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}
async function collect(stream: AsyncIterable<ExternalAgentEvent>) {
  const events: ExternalAgentEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}
async function connected() {
  const transport = new FakeTransport()
  const warnings = jest.fn()
  const adapter = new DshSdkClientAdapter({
    createTransport: () => transport,
    onCodecWarning: warnings,
  })
  await adapter.connect(CONFIG)
  const session = await adapter.createSession()
  return { adapter, transport, session, warnings }
}

describe("DeepSeek Harness current protocol adapter", () => {
  it("connects idempotently and creates tracked caller-owned session ids", async () => {
    const { adapter, transport, session } = await connected()
    await adapter.connect(CONFIG)
    expect(adapter.protocol).toBe("dsh-sdk")
    expect(adapter.isConnected()).toBe(true)
    expect(adapter.getSession(session.id)).toBe(session)
    expect(transport.closed).toBe(0)
  })
  it("closes a partially started runtime when initialization rejects", async () => {
    const transport = new FakeTransport()
    transport.start = async () => {
      throw new Error("initialize failed")
    }
    const adapter = new DshSdkClientAdapter({ createTransport: () => transport })
    await expect(adapter.connect(CONFIG)).rejects.toThrow("initialize failed")
    expect(transport.closed).toBe(1)
    expect(adapter.connectionStatus).toBe("error")
  })
  it("rejects a runtime that exits during initialization", async () => {
    const transport = new FakeTransport()
    transport.start = async (handlers) => {
      transport.running = true
      handlers.onClosed("exit")
    }
    const adapter = new DshSdkClientAdapter({ createTransport: () => transport })
    await expect(adapter.connect(CONFIG)).rejects.toThrow("closed during initialization")
  })
  it("retains failed teardown so disconnect can retry reaping the process", async () => {
    const { adapter, transport } = await connected()
    const close = jest.spyOn(transport, "close").mockRejectedValueOnce(new Error("kill failed"))
    await expect(adapter.disconnect()).rejects.toThrow("kill failed")
    expect(adapter.connectionStatus).toBe("error")
    await adapter.disconnect()
    expect(close).toHaveBeenCalledTimes(2)
    expect(transport.isRunning()).toBe(false)
  })
  it("retains startup cleanup failures for a later disconnect retry", async () => {
    const transport = new FakeTransport()
    transport.start = async () => {
      transport.running = true
      throw new Error("initialize failed")
    }
    const close = jest.spyOn(transport, "close").mockRejectedValueOnce(new Error("kill failed"))
    const adapter = new DshSdkClientAdapter({ createTransport: () => transport })
    await expect(adapter.connect(CONFIG)).rejects.toThrow(
      "initialization and runtime cleanup failed"
    )
    await adapter.disconnect()
    expect(close).toHaveBeenCalledTimes(2)
  })
  it("retains a previous failed transport if reconnect cannot reap it", async () => {
    const { adapter, transport } = await connected()
    const close = jest
      .spyOn(transport, "close")
      .mockRejectedValueOnce(new Error("kill failed"))
      .mockRejectedValueOnce(new Error("still running"))
    await expect(adapter.disconnect()).rejects.toThrow("kill failed")
    await expect(adapter.connect(CONFIG)).rejects.toThrow("still running")
    await adapter.disconnect()
    expect(close).toHaveBeenCalledTimes(3)
  })
  it("requires a running runtime and a known session", async () => {
    const transport = new FakeTransport()
    const adapter = new DshSdkClientAdapter({ createTransport: () => transport })
    await expect(adapter.createSession()).rejects.toThrow("not connected")
    expect(() => adapter.prompt("unknown", MESSAGE)).toThrow("Unknown")
    await adapter.connect(CONFIG)
    const session = await adapter.createSession()
    transport.running = false
    expect(() => adapter.prompt(session.id, MESSAGE)).toThrow("not connected")
  })
  it("passes text and encoded raster image blocks without flattening or dropping content", async () => {
    const { adapter, transport, session } = await connected()
    adapter.prompt(session.id, {
      ...MESSAGE,
      content: [
        { type: "text", text: "a" },
        { type: "image", source: { type: "base64", data: "YWJj", mediaType: "image/png" } },
        { type: "text", text: "b" },
      ],
    })
    expect(transport.prompts[0]).toEqual({
      sessionId: session.id,
      contentBlocks: [
        { type: "text", text: "a" },
        { type: "image", data: "YWJj", mimeType: "image/png" },
        { type: "text", text: "b" },
      ],
    })
    await adapter.disconnect()
  })
  it.each([
    { type: "audio", data: "a" },
    { type: "file", path: "/a" },
    {
      type: "image",
      source: { type: "url", url: "https://example.com/a.png", mediaType: "image/png" },
    },
  ])("rejects unsupported input before sending", async (block) => {
    const { adapter, transport, session } = await connected()
    expect(() =>
      adapter.prompt(session.id, { ...MESSAGE, content: [block] } as ExternalAgentMessage)
    ).toThrow("does not support prompt content")
    expect(transport.prompts).toHaveLength(0)
  })
  it.each([[], 42])("rejects unusable content", async (content) => {
    const { adapter, session } = await connected()
    expect(() =>
      adapter.prompt(session.id, { ...MESSAGE, content } as ExternalAgentMessage)
    ).toThrow("requires content")
  })
  it("accepts the existing string message API", async () => {
    const { adapter, transport, session } = await connected()
    adapter.prompt(session.id, { ...MESSAGE, content: "hello" } as unknown as ExternalAgentMessage)
    expect(transport.prompts[0].contentBlocks).toEqual([{ type: "text", text: "hello" }])
    await adapter.disconnect()
  })
  it("finishes execute after receipt, committed text, turn/end and idle with one successful done", async () => {
    const { adapter, transport, session } = await connected()
    const result = adapter.execute(session.id, MESSAGE)
    transport.turn(session.id)
    await expect(result).resolves.toMatchObject({
      success: true,
      finalResponse: "answer",
      tokenUsage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
    })
    expect(session.status).toBe("idle")
  })
  it("waits for a delayed receipt even if the full turn arrives first", async () => {
    const { adapter, transport, session } = await connected()
    let admit!: (id: string) => void
    transport.receipt = new Promise((resolve) => {
      admit = resolve
    })
    const stream = collect(adapter.prompt(session.id, MESSAGE))
    transport.turn(session.id)
    let ended = false
    void stream.then(() => {
      ended = true
    })
    await tick()
    expect(ended).toBe(false)
    admit("msg-1")
    expect((await stream).filter((event) => event.type === "done")).toHaveLength(1)
  })
  it("does not let initial idle or unrelated session traffic finish the prompt", async () => {
    const { adapter, transport, session } = await connected()
    const stream = collect(adapter.prompt(session.id, MESSAGE))
    transport.status(session.id, "idle")
    transport.turn("unrelated", "wrong answer")
    transport.turn(session.id, "right answer")
    const events = await stream
    expect(events.filter((event) => event.type === "message_delta")).toMatchObject([
      { delta: { text: "right answer" } },
    ])
  })
  it("routes concurrent sessions independently and allows a second completed turn", async () => {
    const { adapter, transport, session } = await connected()
    const other = await adapter.createSession()
    const first = adapter.execute(session.id, MESSAGE)
    const second = adapter.execute(other.id, MESSAGE)
    transport.turn(other.id, "second")
    transport.turn(session.id, "first")
    await expect(first).resolves.toMatchObject({ finalResponse: "first" })
    await expect(second).resolves.toMatchObject({ finalResponse: "second" })
    const third = adapter.execute(session.id, MESSAGE)
    transport.turn(session.id, "third")
    await expect(third).resolves.toMatchObject({ finalResponse: "third" })
  })
  it("rejects overlap in one session without replacing its existing iterator", async () => {
    const { adapter, transport, session } = await connected()
    const result = adapter.execute(session.id, MESSAGE)
    expect(() => adapter.prompt(session.id, MESSAGE)).toThrow("already has a prompt")
    transport.turn(session.id)
    await expect(result).resolves.toMatchObject({ success: true })
  })
  it("does not attribute child answers or terminal boundaries to the parent", async () => {
    const { adapter, transport, session } = await connected()
    const result = adapter.execute(session.id, MESSAGE)
    transport.raw({
      method: "subagent.started",
      params: { parentSessionId: session.id, childSessionId: "child" },
    })
    transport.turn("child", "child answer")
    transport.raw({
      method: "subagent.started",
      params: { parentSessionId: "child", childSessionId: "grandchild" },
    })
    transport.turn(session.id, "parent answer")
    await expect(result).resolves.toMatchObject({ finalResponse: "parent answer", success: true })
  })
  it("preserves failure when idle arrives and sums usage across steps", async () => {
    const { adapter, transport, session } = await connected()
    const result = adapter.execute(session.id, MESSAGE)
    transport.event(session.id, "turn/start")
    transport.event(session.id, "assistant/message", {
      message: { content: [] },
      usage: { inputTokens: 4, outputTokens: 2, cacheReadTokens: 3 },
    })
    transport.turn(session.id, "", "error")
    await expect(result).resolves.toMatchObject({
      success: false,
      error: "provider failure",
      tokenUsage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
    })
  })
  it("rejects success for a receipt that was not consumed", async () => {
    const { adapter, transport, session } = await connected()
    const stream = collect(adapter.prompt(session.id, MESSAGE))
    transport.turn(session.id, "wrong", "completed", "other-receipt")
    await expect(stream).rejects.toThrow("without consuming")
    expect(transport.closed).toBe(1)
  })
  it("rejects idle without a terminal verdict", async () => {
    const { adapter, transport, session } = await connected()
    const stream = collect(adapter.prompt(session.id, MESSAGE))
    await tick()
    transport.event(session.id, "turn/start")
    transport.status(session.id, "idle")
    await expect(stream).rejects.toThrow("without a turn/end")
  })
  it("allows blocked admission to settle without consuming a user message", async () => {
    const { adapter, transport, session } = await connected()
    const stream = collect(adapter.prompt(session.id, MESSAGE))
    transport.event(session.id, "turn/start")
    transport.event(session.id, "turn/end", { reason: { kind: "blocked" } })
    transport.status(session.id, "idle")
    expect((await stream).at(-1)).toMatchObject({
      type: "done",
      success: false,
      stopReason: "refusal",
    })
  })
  it("fails and closes on a rejected or empty admission receipt", async () => {
    for (const receipt of [Promise.reject(new Error("refused")), Promise.resolve("")]) {
      const { adapter, transport, session } = await connected()
      transport.receipt = receipt
      await expect(collect(adapter.prompt(session.id, MESSAGE))).rejects.toThrow()
      await tick()
      expect(transport.closed).toBe(1)
    }
  })
  it("drains prior events before raising version drift and closes the runtime", async () => {
    const { adapter, transport, session } = await connected()
    const iterator = adapter.prompt(session.id, MESSAGE)[Symbol.asyncIterator]()
    transport.event(session.id, "turn/start")
    transport.event(session.id, "assistant/chunk", {
      chunk: { type: "text-delta", text: "legacy" },
    })
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: "session_start" } })
    await expect(iterator.next()).rejects.toThrow("unrecognized required event")
    expect(transport.closed).toBe(1)
  })
  it("surfaces ignorable event warnings", async () => {
    const { transport, session, warnings } = await connected()
    transport.raw({
      method: "session.event",
      params: {
        sessionId: session.id,
        event: { type: "custom", seq: 1, data: {}, ignorable: true },
      },
    })
    expect(warnings).toHaveBeenCalledWith({ kind: "ignorable-unknown-event", detail: "custom" })
  })
  it("ends a parked consumer with error when the process exits", async () => {
    const { adapter, transport, session } = await connected()
    const events = collect(adapter.prompt(session.id, MESSAGE))
    transport.running = false
    transport.handlers?.onClosed("exit code 1")
    expect(await events).toMatchObject([
      { type: "error", error: "exit code 1", recoverable: false },
    ])
    expect(session.status).toBe("error")
  })
  it("cancels every in-flight session when process cancellation is required", async () => {
    const { adapter, transport, session } = await connected()
    const other = await adapter.createSession()
    const first = collect(adapter.prompt(session.id, MESSAGE))
    const second = collect(adapter.prompt(other.id, MESSAGE))
    await adapter.cancel(session.id)
    for (const events of [await first, await second])
      expect(events.at(-1)).toMatchObject({ type: "done", success: false, stopReason: "cancelled" })
    expect(transport.closed).toBe(1)
    expect(adapter.getSessions()).toEqual([])
  })
  it("honors an already aborted signal without admitting work", async () => {
    const { adapter, transport, session } = await connected()
    const controller = new AbortController()
    controller.abort()
    const events = await collect(adapter.prompt(session.id, MESSAGE, { signal: controller.signal }))
    expect(transport.prompts).toHaveLength(0)
    expect(events.at(-1)).toMatchObject({ success: false, stopReason: "cancelled" })
  })
  it("aborts live work and removes listeners after natural completion", async () => {
    const { adapter, transport, session } = await connected()
    const controller = new AbortController()
    const stream = collect(adapter.prompt(session.id, MESSAGE, { signal: controller.signal }))
    transport.turn(session.id)
    await stream
    controller.abort()
    expect(transport.closed).toBe(0)
    const secondController = new AbortController()
    const second = collect(adapter.prompt(session.id, MESSAGE, { signal: secondController.signal }))
    secondController.abort()
    expect((await second).at(-1)).toMatchObject({ success: false })
    expect(transport.closed).toBe(1)
  })
  it("cancels abandoned iterators and closeSession with active work", async () => {
    for (const action of ["return", "close"] as const) {
      const { adapter, transport, session } = await connected()
      const iterator = adapter.prompt(session.id, MESSAGE)[Symbol.asyncIterator]()
      if (action === "return") await iterator.return?.()
      else await adapter.closeSession(session.id)
      expect(transport.closed).toBe(1)
    }
  })
  it("closes idle sessions locally and ignores unknown close/cancel requests", async () => {
    const { adapter, transport, session } = await connected()
    await adapter.closeSession(session.id)
    await adapter.closeSession("unknown")
    await adapter.cancel("unknown")
    expect(adapter.getSessions()).toEqual([])
    expect(transport.closed).toBe(0)
  })
  it("times out an admitted prompt and closes the runtime", async () => {
    jest.useFakeTimers()
    try {
      const { adapter, transport, session } = await connected()
      const stream = collect(adapter.prompt(session.id, MESSAGE, { timeout: 10 }))
      await tick()
      jest.advanceTimersByTime(10)
      expect(await stream).toMatchObject([
        { type: "error", error: expect.stringContaining("timed out") },
        { type: "done", success: false },
      ])
      expect(transport.closed).toBe(1)
    } finally {
      jest.useRealTimers()
    }
  })
  it.each([
    { cwd: "/other" },
    { mcpServers: [{ name: "mcp" }] },
    { additionalDirectories: ["/other"] },
    { allowedTools: ["read"] },
    { permissionMode: "bypassPermissions" },
    { metadata: { selectedModel: "other" } },
    { metadata: { reasoningEffort: "high" } },
  ])("refuses unsupported session overrides", async (options) => {
    const { adapter } = await connected()
    await expect(adapter.createSession(options as never)).rejects.toThrow("per-session overrides")
  })
  it.each([
    ["cognia-sdk-readonly", "plan"],
    ["cognia-sdk-workspace", "acceptEdits"],
  ] as const)(
    "accepts manager options matching %s and forwards Cognia instructions as user content",
    async (profile, permissionMode) => {
      const transport = new FakeTransport()
      const adapter = new DshSdkClientAdapter({ createTransport: () => transport })
      await adapter.connect({ ...CONFIG, metadata: { dshProfileId: profile } })
      const options = {
        cwd: "/workspace",
        permissionMode,
        systemPrompt: "Be careful",
        briefMode: true,
        instructionEnvelope: {
          hash: "hash",
          developerInstructions: "Use the workspace",
          customInstructions: "Keep changes small",
          projectContextSummary: "TypeScript",
          skillsSummary: "Tests",
        },
        context: {
          workingDirectory: "/workspace",
          parentTask: "Fix parser",
          custom: { cwd: "/workspace", traceId: "trace-only", request: "preserve format" },
        },
        metadata: { selectedModel: "deepseek-v4-flash" },
      }
      const session = await adapter.createSession(options)
      const first = adapter.execute(session.id, MESSAGE, { permissionMode })
      expect(transport.prompts[0].contentBlocks[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("Cognia session instructions"),
      })
      const text = JSON.stringify(transport.prompts[0].contentBlocks)
      for (const expected of [
        "Be careful",
        "Use the workspace",
        "Keep changes small",
        "TypeScript",
        "Tests",
        "Answer concisely",
        "Fix parser",
        "preserve format",
      ])
        expect(text).toContain(expected)
      expect(text).not.toContain("trace-only")
      transport.turn(session.id)
      await expect(first).resolves.toMatchObject({ success: true })
      const second = adapter.execute(session.id, MESSAGE)
      expect(transport.prompts[1].contentBlocks).toEqual(MESSAGE.content)
      transport.turn(session.id)
      await second
      const third = adapter.execute(session.id, MESSAGE, { systemPrompt: "New instruction" })
      expect(JSON.stringify(transport.prompts[2].contentBlocks)).toContain("New instruction")
      transport.turn(session.id)
      await third
    }
  )
  it("accepts routing-only context without inserting a preamble", async () => {
    const { adapter, transport } = await connected()
    const session = await adapter.createSession({
      context: {
        workingDirectory: "/workspace",
        custom: { cwd: "/workspace", mcpServers: [], additionalDirectories: [] },
      },
    })
    const result = adapter.execute(session.id, MESSAGE, {
      context: { workingDirectory: "/workspace" },
    })
    expect(transport.prompts[0].contentBlocks).toEqual(MESSAGE.content)
    transport.turn(session.id)
    await result
  })
  it.each([
    { workingDirectory: "/elsewhere" },
    { custom: { mcpServers: ["server"] } },
    { custom: { additionalDirectories: ["/extra"] } },
  ])("rejects context that asks for an unsupported host control", async (context) => {
    const { adapter, session } = await connected()
    await expect(adapter.createSession({ context })).rejects.toThrow("per-session overrides")
    expect(() => adapter.prompt(session.id, MESSAGE, { context })).toThrow("per-session overrides")
  })
  it("generates globally unique ids across adapters and reconnects sharing durable storage", async () => {
    const first = await connected()
    const second = await connected()
    const ids = [first.session.id, second.session.id]
    await first.adapter.disconnect()
    await first.adapter.connect(CONFIG)
    ids.push((await first.adapter.createSession()).id)
    expect(new Set(ids).size).toBe(3)
    for (const id of ids) expect(id).toMatch(/^dsh-[0-9a-f]{8}-[0-9a-f-]{27}$/)
  })
  it("forgets process-owned sessions before reconnecting", async () => {
    const { adapter, transport, session } = await connected()
    const stream = collect(adapter.prompt(session.id, MESSAGE))
    transport.running = false
    transport.handlers?.onClosed("crashed")
    await stream
    await adapter.connect(CONFIG)
    expect(adapter.getSession(session.id)).toBeUndefined()
    expect(() => adapter.prompt(session.id, MESSAGE)).toThrow("Unknown")
  })
  it("fails parked consumers when the host forgets runtime sessions", async () => {
    const { adapter, session } = await connected()
    const stream = collect(adapter.prompt(session.id, MESSAGE))
    adapter.forgetSessions()
    await expect(stream).rejects.toThrow("forgotten")
    expect(adapter.getSessions()).toEqual([])
  })
  it("rejects non-user message roles instead of silently changing their authority", async () => {
    const { adapter, session } = await connected()
    expect(() => adapter.prompt(session.id, { ...MESSAGE, role: "system" })).toThrow(
      "requires a user message"
    )
  })
  it("accepts process-consistent session options and rejects unsupported execution controls", async () => {
    const { adapter, session } = await connected()
    await expect(
      adapter.createSession({
        cwd: "/workspace",
        permissionMode: "default",
        metadata: { selectedModel: "deepseek-v4-flash" },
      })
    ).resolves.toBeDefined()
    expect(() => adapter.prompt(session.id, MESSAGE, { files: [{ path: "/a" }] })).toThrow(
      "cannot apply"
    )
    await expect(adapter.respondToPermission(session.id, {} as never)).rejects.toThrow(
      "cannot carry permission requests"
    )
  })
})
