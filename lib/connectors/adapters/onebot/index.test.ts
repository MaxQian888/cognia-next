import { listen, emit } from "@tauri-apps/api/event"
import { createOneBotAdapter } from "./index"
import type { AdapterContext, NormalizedInboundEvent } from "@/types/connectors"
import { clearAllVariantCaches } from "./parse"

// Mock the generic WS client commands so the forward-ws path doesn't invoke
// Tauri. The reverse-ws path (default in most tests) never touches these.
jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsWsOpen: jest.fn().mockResolvedValue("fw-1"),
  connectorsWsSend: jest.fn().mockResolvedValue(undefined),
  connectorsWsClose: jest.fn().mockResolvedValue(undefined),
}))
import { connectorsWsOpen } from "@/lib/connectors/tauri/commands"

const mockListen = listen as jest.Mock
const mockEmit = emit as jest.Mock
const mockWsOpen = connectorsWsOpen as jest.Mock

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ListenerMap = Map<string, ((event: { payload: string }) => void)[]>

function createEventBus() {
  const listeners: ListenerMap = new Map()

  const listenImpl = jest
    .fn()
    .mockImplementation(async (topic: string, handler: (event: { payload: string }) => void) => {
      if (!listeners.has(topic)) listeners.set(topic, [])
      listeners.get(topic)!.push(handler)
      return jest.fn() // unlisten
    })

  const emitImpl = jest.fn().mockResolvedValue(undefined)

  function trigger(topic: string, payload: string) {
    const handlers = listeners.get(topic) ?? []
    for (const h of handlers) h({ payload })
  }

  return { listenImpl, emitImpl, trigger }
}

function makeCtx(): { ctx: AdapterContext; emitted: NormalizedInboundEvent[] } {
  const emitted: NormalizedInboundEvent[] = []
  const ctx: AdapterContext = {
    emit: jest.fn(async (e: NormalizedInboundEvent) => {
      emitted.push(e)
    }),
    tauri: {
      httpRequest: jest.fn(),
      openWs: jest.fn(),
      fetchAttachment: jest.fn(),
      bindWebhookRoute: jest.fn(),
      unbindWebhookRoute: jest.fn(),
      publicBaseUrl: jest.fn(),
    },
    secrets: { get: jest.fn(), set: jest.fn(), delete: jest.fn(), list: jest.fn() },
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    signal: new AbortController().signal,
    adapterId: "ob-test",
  }
  return { ctx, emitted }
}

function makeAdapter(id = "ob-1") {
  return createOneBotAdapter({
    id,
    displayName: "Test OneBot",
    selfBotUin: "100000",
  })
}

beforeEach(() => {
  mockListen.mockReset()
  mockEmit.mockReset()
  clearAllVariantCaches()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createOneBotAdapter", () => {
  it("exposes correct meta", () => {
    const adapter = makeAdapter()
    expect(adapter.id).toBe("ob-1")
    expect(adapter.meta.type).toBe("onebot")
    expect(adapter.meta.displayName).toBe("Test OneBot")
    expect(adapter.meta.version).toBe("0.1.0")
    expect(adapter.meta.transportModes).toContain("reverse-ws")
    expect(adapter.meta.capabilities).toContain("send.text")
    expect(adapter.meta.capabilities).not.toContain("edit")
  })

  it("health() starts as 'starting'", () => {
    const adapter = makeAdapter()
    expect(adapter.health().state).toBe("starting")
  })

  it("health() is 'running' after start()", async () => {
    const bus = createEventBus()
    mockListen.mockImplementation(bus.listenImpl)

    const adapter = makeAdapter("ob-start")
    const { ctx } = makeCtx()
    await adapter.start(ctx)
    expect(adapter.health().state).toBe("running")
    await adapter.stop()
  })

  it("health() is 'down' after stop()", async () => {
    const bus = createEventBus()
    mockListen.mockImplementation(bus.listenImpl)

    const adapter = makeAdapter("ob-stop")
    const { ctx } = makeCtx()
    await adapter.start(ctx)
    await adapter.stop()
    expect(adapter.health().state).toBe("down")
  })

  it("start() drives events through parser and emits to ctx", async () => {
    const bus = createEventBus()
    mockListen.mockImplementation(bus.listenImpl)

    const adapter = createOneBotAdapter({ id: "ob-evt", displayName: "T", selfBotUin: "100000" })
    const { ctx, emitted } = makeCtx()
    await adapter.start(ctx)

    // Simulate a v11 message arriving
    const v11Msg = {
      time: 1700000000,
      self_id: 100000,
      post_type: "message",
      message_type: "private",
      message_id: 1001,
      user_id: 200001,
      sender: { user_id: 200001, nickname: "Alice" },
      message: [{ type: "text", data: { text: "hello via reverse-ws" } }],
    }
    bus.trigger("connectors://onebot/ob-evt/event", JSON.stringify(v11Msg))

    // Allow microtask queue to drain
    await new Promise((r) => setTimeout(r, 20))

    expect(emitted.length).toBeGreaterThanOrEqual(1)
    expect(emitted[0].plainText).toBe("hello via reverse-ws")
    expect(emitted[0].platform).toBe("onebot")

    await adapter.stop()
  })

  it("send() routes to sendToOneBot via v11 action", async () => {
    const bus = createEventBus()
    mockListen.mockImplementation(bus.listenImpl)

    const adapter = createOneBotAdapter({ id: "ob-send", displayName: "T", selfBotUin: "100000" })
    const { ctx } = makeCtx()
    await adapter.start(ctx)

    // Simulate a v11 event to seed the variant cache
    const v11Msg = {
      time: 1700000000,
      self_id: 100000,
      post_type: "message",
      message_type: "private",
      message_id: 1001,
      user_id: 200001,
      sender: { user_id: 200001, nickname: "Alice" },
      message: [{ type: "text", data: { text: "seed" } }],
    }
    bus.trigger("connectors://onebot/ob-send/event", JSON.stringify(v11Msg))
    await new Promise((r) => setTimeout(r, 20))

    // Mock emit to respond immediately with a success response
    mockEmit.mockImplementation(async (_topic: string, payload: string) => {
      const call = JSON.parse(payload) as { echo: string }
      setTimeout(() => {
        bus.trigger(
          "connectors://onebot/ob-send/response",
          JSON.stringify({ status: "ok", retcode: 0, data: { message_id: 99 }, echo: call.echo })
        )
      }, 5)
    })

    const result = await adapter.send({
      conversationRef: { platform: "onebot", adapterId: "ob-send", chatKey: "p:200001" },
      segments: [{ type: "text", text: "hello from adapter" }],
      metadata: { idempotencyKey: "k1" },
    })

    expect(result.ok).toBe(true)
    expect(mockEmit).toHaveBeenCalledWith(
      "connectors://onebot/ob-send/send",
      expect.stringContaining("send_private_msg")
    )

    await adapter.stop()
  })

  it("edit() returns unsupported error", async () => {
    const bus = createEventBus()
    mockListen.mockImplementation(bus.listenImpl)

    const adapter = makeAdapter("ob-edit")
    const { ctx } = makeCtx()
    await adapter.start(ctx)

    const result = await adapter.edit!("999", {
      conversationRef: { platform: "onebot", adapterId: "ob-edit", chatKey: "p:200001" },
      segments: [{ type: "text", text: "edited" }],
      metadata: { idempotencyKey: "k2" },
    })

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe("unsupported_segment")

    await adapter.stop()
  })

  it("setTyping() is a no-op (no error)", async () => {
    const bus = createEventBus()
    mockListen.mockImplementation(bus.listenImpl)

    const adapter = makeAdapter("ob-typing")
    const { ctx } = makeCtx()
    await adapter.start(ctx)
    await expect(adapter.setTyping!("onebot:ob-typing:g:300001", true)).resolves.toBeUndefined()
    await adapter.stop()
  })
})

describe("createOneBotAdapter — forward-ws transport", () => {
  beforeEach(() => {
    mockWsOpen.mockClear()
    mockWsOpen.mockResolvedValue("fw-1")
  })

  it("meta advertises both reverse-ws and forward-ws", () => {
    const adapter = makeAdapter()
    expect(adapter.meta.transportModes).toContain("reverse-ws")
    expect(adapter.meta.transportModes).toContain("forward-ws")
  })

  it("dials the NapCat WS server with a Bearer header on start", async () => {
    const bus = createEventBus()
    mockListen.mockImplementation(bus.listenImpl)

    const adapter = createOneBotAdapter({
      id: "ob-forward",
      displayName: "Fwd",
      selfBotUin: "100000",
      transportMode: "forward-ws",
      forwardWsUrl: "ws://127.0.0.1:3001",
      bearerToken: async () => "tok",
    })
    const { ctx } = makeCtx()
    await adapter.start(ctx)

    expect(mockWsOpen).toHaveBeenCalledWith("ws://127.0.0.1:3001", {
      Authorization: "Bearer tok",
    })

    await adapter.stop()
  })

  it("falls back to reverse-ws when forward-ws is selected without a URL", async () => {
    const bus = createEventBus()
    mockListen.mockImplementation(bus.listenImpl)

    const adapter = createOneBotAdapter({
      id: "ob-forward-nourl",
      displayName: "Fwd",
      selfBotUin: "100000",
      transportMode: "forward-ws",
    })
    const { ctx } = makeCtx()
    await adapter.start(ctx)

    // No outbound dial — the reverse-ws path subscribes via Tauri events.
    expect(mockWsOpen).not.toHaveBeenCalled()

    await adapter.stop()
  })
})
