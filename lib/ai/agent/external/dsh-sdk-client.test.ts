import type {
  ExternalAgentConfig,
  ExternalAgentEvent,
  ExternalAgentMessage,
} from "@/types/agent/external-agent"

import { SUPPORTED_EXTERNAL_AGENT_PROTOCOLS } from "./config-normalizer"
import {
  DshSdkClientAdapter,
  type DshRuntimeTransport,
  type DshRuntimeTransportHandlers,
} from "./dsh-sdk-client"

class FakeTransport implements DshRuntimeTransport {
  handlers?: DshRuntimeTransportHandlers
  running = false
  readonly prompts: Array<{ sessionId: string; text: string }> = []
  closed = 0
  promptRejection?: Error

  async start(handlers: DshRuntimeTransportHandlers): Promise<void> {
    this.handlers = handlers
    this.running = true
  }
  async prompt(sessionId: string, text: string): Promise<string> {
    if (this.promptRejection) throw this.promptRejection
    this.prompts.push({ sessionId, text })
    return "msg-1"
  }
  async close(): Promise<void> {
    this.closed += 1
    this.running = false
  }
  isRunning(): boolean {
    return this.running
  }

  emit(type: string, data: unknown, seq = 1): void {
    this.handlers?.onNotification({
      method: "session.event",
      params: { sessionId: "runtime-1", event: { type, seq, data } },
    })
  }
  emitRaw(notification: unknown): void {
    this.handlers?.onNotification(notification)
  }
  die(reason: string): void {
    this.running = false
    this.handlers?.onClosed(reason)
  }
}

const CONFIG = { id: "agent-1", name: "DSH", protocol: "dsh-sdk" } as unknown as ExternalAgentConfig
const MESSAGE = { role: "user", content: "hello" } as unknown as ExternalAgentMessage

async function collect(
  iterable: AsyncIterable<ExternalAgentEvent>,
  limit: number
): Promise<ExternalAgentEvent[]> {
  const out: ExternalAgentEvent[] = []
  for await (const event of iterable) {
    out.push(event)
    if (out.length >= limit) break
  }
  return out
}

function makeAdapter(transport: FakeTransport, onCodecWarning?: jest.Mock) {
  return new DshSdkClientAdapter({ createTransport: () => transport, onCodecWarning })
}

describe("protocol registration invariant", () => {
  it("lists dsh-sdk among the supported protocols", () => {
    // Set-equality with ExternalAgentManager.registerDefaultAdapters(). If this
    // list gains a protocol with no registered adapter, a fresh config is
    // labelled supported and then fails at connect instead of being reported
    // as unsupported up front.
    expect([...SUPPORTED_EXTERNAL_AGENT_PROTOCOLS]).toContain("dsh-sdk")
  })

  it("declares exactly the built-in adapter protocols", () => {
    expect([...SUPPORTED_EXTERNAL_AGENT_PROTOCOLS].sort()).toEqual([
      "a2a",
      "acp",
      "codex-app-server",
      "dsh-sdk",
      "opencode",
      "opencode-v2",
      "pi-rpc",
    ])
  })
})

describe("DshSdkClientAdapter lifecycle", () => {
  it("reports its protocol id", () => {
    expect(makeAdapter(new FakeTransport()).protocol).toBe("dsh-sdk")
  })

  it("connects and reports connected", async () => {
    const transport = new FakeTransport()
    const adapter = makeAdapter(transport)
    await adapter.connect(CONFIG)
    expect(adapter.isConnected()).toBe(true)
  })

  it("marks the connection failed when the transport will not start", async () => {
    const transport = new FakeTransport()
    transport.start = async () => {
      throw new Error("spawn failed")
    }
    const adapter = makeAdapter(transport)
    await expect(adapter.connect(CONFIG)).rejects.toThrow("spawn failed")
    expect(adapter.isConnected()).toBe(false)
  })

  it("is idempotent on repeat connects", async () => {
    const transport = new FakeTransport()
    const adapter = makeAdapter(transport)
    await adapter.connect(CONFIG)
    await adapter.connect(CONFIG)
    expect(transport.closed).toBe(0)
  })

  it("refuses to create a session before connecting", async () => {
    await expect(makeAdapter(new FakeTransport()).createSession()).rejects.toThrow(/not connected/i)
  })

  it("creates and tracks a session", async () => {
    const adapter = makeAdapter(new FakeTransport())
    await adapter.connect(CONFIG)
    const session = await adapter.createSession({
      permissionMode: "dontAsk",
      allowedTools: ["read"],
    })
    expect(session.status).toBe("active")
    expect(session.allowedTools).toEqual(["read"])
    expect(adapter.getSession(session.id)?.id).toBe(session.id)
    expect(adapter.getSessions()).toHaveLength(1)
  })

  it("closes a session and forgets it", async () => {
    const adapter = makeAdapter(new FakeTransport())
    await adapter.connect(CONFIG)
    const session = await adapter.createSession()
    await adapter.closeSession(session.id)
    expect(adapter.getSession(session.id)).toBeUndefined()
  })

  it("ignores closing an unknown session", async () => {
    const adapter = makeAdapter(new FakeTransport())
    await adapter.connect(CONFIG)
    await expect(adapter.closeSession("nope")).resolves.toBeUndefined()
  })

  it("closes every session on disconnect because none can outlive the process", async () => {
    // The wire has no per-session close; sessions die with the runtime.
    const transport = new FakeTransport()
    const adapter = makeAdapter(transport)
    await adapter.connect(CONFIG)
    await adapter.createSession()
    await adapter.disconnect()
    expect(adapter.getSessions()).toHaveLength(0)
    expect(transport.closed).toBe(1)
    expect(adapter.isConnected()).toBe(false)
  })
})

describe("DshSdkClientAdapter prompting", () => {
  async function connected() {
    const transport = new FakeTransport()
    const adapter = makeAdapter(transport)
    await adapter.connect(CONFIG)
    const session = await adapter.createSession()
    return { transport, adapter, session }
  }

  it("rejects prompting an unknown session", async () => {
    const { adapter } = await connected()
    expect(() => adapter.prompt("nope", MESSAGE)).toThrow(/Unknown DeepSeek Harness session/)
  })

  it("forwards the prompt text to the runtime", async () => {
    const { transport, adapter, session } = await connected()
    adapter.prompt(session.id, MESSAGE)
    await Promise.resolve()
    expect(transport.prompts).toEqual([{ sessionId: session.id, text: "hello" }])
  })

  it("flattens array message content", async () => {
    const { transport, adapter, session } = await connected()
    const message = {
      role: "user",
      content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }],
    } as unknown as ExternalAgentMessage
    adapter.prompt(session.id, message)
    await Promise.resolve()
    expect(transport.prompts[0].text).toBe("ab")
  })

  it("streams translated events tagged with the Cognia session id", async () => {
    // DSH generates its own session ids; consumers must see Cognia's.
    const { transport, adapter, session } = await connected()
    const stream = adapter.prompt(session.id, MESSAGE)
    const collected = collect(stream, 2)
    transport.emit("turn/start", { turn: 1 })
    transport.emit("assistant/chunk", { chunk: { type: "text-delta", text: "hi" } }, 2)
    const events = await collected
    expect(events[0]).toMatchObject({ type: "session_start", sessionId: session.id })
    expect(events[1]).toMatchObject({ type: "message_delta", sessionId: session.id })
  })

  it("delivers events buffered before the consumer starts reading", async () => {
    const { transport, adapter, session } = await connected()
    const stream = adapter.prompt(session.id, MESSAGE)
    transport.emit("turn/start", { turn: 1 })
    transport.emit("turn/end", { reason: { kind: "completed" } }, 2)
    const events = await collect(stream, 2)
    expect(events.map((e) => e.type)).toEqual(["session_start", "done"])
  })

  it("surfaces a prompt rejection to the stream consumer", async () => {
    const { transport, adapter, session } = await connected()
    transport.promptRejection = new Error("runtime refused the prompt")
    const stream = adapter.prompt(session.id, MESSAGE)
    await expect(collect(stream, 1)).rejects.toThrow("runtime refused the prompt")
  })

  it("reports an error event and ends the stream when the runtime dies", async () => {
    const { transport, adapter, session } = await connected()
    const stream = adapter.prompt(session.id, MESSAGE)
    const collected = collect(stream, 1)
    transport.die("exit code 1: [redacted]")
    const events = await collected
    expect(events[0]).toMatchObject({ type: "error", recoverable: false })
    expect(adapter.getSession(session.id)?.status).toBe("error")
  })

  it("forwards codec warnings to the sink", async () => {
    const onCodecWarning = jest.fn()
    const transport = new FakeTransport()
    const adapter = makeAdapter(transport, onCodecWarning)
    await adapter.connect(CONFIG)
    const session = await adapter.createSession()
    adapter.prompt(session.id, MESSAGE)
    transport.emit("assistant/chunk", { chunk: { type: "video-delta" } })
    expect(onCodecWarning).toHaveBeenCalledWith({
      kind: "unknown-chunk-type",
      detail: "video-delta",
    })
  })

  it("fails the stream on version drift rather than dropping events", async () => {
    // An unrecognized required event means nothing after it can be trusted.
    const { transport, adapter, session } = await connected()
    const stream = adapter.prompt(session.id, MESSAGE)
    const collected = collect(stream, 1)
    transport.emitRaw({
      method: "session.event",
      params: { sessionId: "runtime-1", event: { type: "turn/teleport", seq: 1 } },
    })
    await expect(collected).rejects.toThrow(/unrecognized required event/)
  })
})

describe("capabilities this transport does not have", () => {
  it("throws on respondToPermission instead of pretending it applied", async () => {
    // Silently accepting would misreport the session's authority: nothing was
    // gated, because the wire cannot carry the question.
    const adapter = makeAdapter(new FakeTransport())
    await adapter.connect(CONFIG)
    await expect(adapter.respondToPermission("s", { outcome: "allow" } as never)).rejects.toThrow(
      /cannot carry permission requests/
    )
  })

  it("cancels by closing the runtime and reports the turn as cancelled", async () => {
    // Upstream has no prompt-cancel; abandoning a turn means closing the process.
    const transport = new FakeTransport()
    const adapter = makeAdapter(transport)
    await adapter.connect(CONFIG)
    const session = await adapter.createSession()
    const stream = adapter.prompt(session.id, MESSAGE)
    const collected = collect(stream, 1)
    await adapter.cancel(session.id)
    const events = await collected
    expect(events[0]).toMatchObject({ type: "done", success: false, stopReason: "cancelled" })
    expect(transport.closed).toBe(1)
  })

  it("never reports a cancelled turn as successful", async () => {
    const transport = new FakeTransport()
    const adapter = makeAdapter(transport)
    await adapter.connect(CONFIG)
    const session = await adapter.createSession()
    const stream = adapter.prompt(session.id, MESSAGE)
    const collected = collect(stream, 5)
    await adapter.cancel(session.id)
    const events = await collected
    expect(events.some((e) => e.type === "done" && e.success)).toBe(false)
  })

  it("ends a parked consumer cleanly when the session is closed", async () => {
    // closeSession() while a consumer waits must resolve as done, not hang.
    const transport = new FakeTransport()
    const adapter = makeAdapter(transport)
    await adapter.connect(CONFIG)
    const session = await adapter.createSession()
    const stream = adapter.prompt(session.id, MESSAGE)
    const collected = collect(stream, 5)
    await adapter.closeSession(session.id)
    await expect(collected).resolves.toEqual([])
  })

  it("raises a buffered failure only after earlier events drain", async () => {
    // Events observed before the fault are real and must still reach the
    // consumer; the error surfaces once the buffer is empty.
    const transport = new FakeTransport()
    const adapter = makeAdapter(transport)
    await adapter.connect(CONFIG)
    const session = await adapter.createSession()
    const stream = adapter.prompt(session.id, MESSAGE)
    transport.emit("turn/start", { turn: 1 })
    transport.emitRaw({
      method: "session.event",
      params: { sessionId: "runtime-1", event: { type: "turn/teleport", seq: 2 } },
    })
    const iterator = stream[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: "session_start" } })
    await expect(iterator.next()).rejects.toThrow(/unrecognized required event/)
  })

  it("drops notifications that arrive with no prompt in flight", async () => {
    // DSH notifies for every session in the runtime, unfiltered.
    const transport = new FakeTransport()
    const adapter = makeAdapter(transport)
    await adapter.connect(CONFIG)
    await adapter.createSession()
    expect(() => transport.emit("turn/start", { turn: 1 })).not.toThrow()
  })

  it("treats a message with unusable content as empty text", async () => {
    const transport = new FakeTransport()
    const adapter = makeAdapter(transport)
    await adapter.connect(CONFIG)
    const session = await adapter.createSession()
    adapter.prompt(session.id, { role: "user", content: 42 } as unknown as ExternalAgentMessage)
    await Promise.resolve()
    expect(transport.prompts[0].text).toBe("")
  })

  it("tolerates cancelling an unknown session", async () => {
    const adapter = makeAdapter(new FakeTransport())
    await adapter.connect(CONFIG)
    await expect(adapter.cancel("nope")).resolves.toBeUndefined()
  })

  it("closes the runtime when the caller aborts", async () => {
    const transport = new FakeTransport()
    const adapter = makeAdapter(transport)
    await adapter.connect(CONFIG)
    const session = await adapter.createSession()
    const controller = new AbortController()
    adapter.prompt(session.id, MESSAGE, { signal: controller.signal } as never)
    controller.abort()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(transport.closed).toBe(1)
  })
})
