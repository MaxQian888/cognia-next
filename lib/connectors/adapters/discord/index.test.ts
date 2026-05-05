import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { createDiscordAdapter } from "./index"
import type { AdapterContext, NormalizedInboundEvent } from "@/types/connectors"

const mockInvoke = invoke as jest.Mock
const mockListen = listen as jest.Mock

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSendOkResp(id = "msg-999") {
  return {
    status: 200,
    headers: {},
    body: JSON.stringify({ id }),
  }
}

function makeTypingOkResp() {
  return { status: 204, headers: {}, body: "" }
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
    secrets: {
      get: jest.fn(),
      set: jest.fn(),
      delete: jest.fn(),
      list: jest.fn(),
    },
    logger: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    signal: new AbortController().signal,
    adapterId: "dc-test",
  }
  return { ctx, emitted }
}

function makeAdapter() {
  return createDiscordAdapter({
    id: "dc-1",
    displayName: "My Discord Bot",
    botToken: async () => "BOT_TOKEN",
    selfId: "bot-self-id",
  })
}

// ---------------------------------------------------------------------------
// Fake gateway session (mirrors gateway-client.test.ts pattern)
// ---------------------------------------------------------------------------

function createFakeGatewaySession() {
  let messageHandler: ((event: { payload: string }) => void) | null = null
  let closeHandler: (() => void) | null = null
  let listenCallCount = 0
  let handlersResolve: () => void = () => {}
  const handlersReadyP = new Promise<void>((r) => {
    handlersResolve = r
  })

  const listenImpl = jest.fn().mockImplementation(async (eventName: string, handler: unknown) => {
    listenCallCount++
    if ((eventName as string).endsWith("/message")) {
      messageHandler = handler as (event: { payload: string }) => void
    } else if ((eventName as string).endsWith("/close")) {
      closeHandler = handler as () => void
    }
    if (listenCallCount >= 2) handlersResolve()
    return jest.fn()
  })

  return {
    listenImpl,
    waitForListeners: () => handlersReadyP,
    push(payload: unknown) {
      messageHandler?.({ payload: JSON.stringify(payload) })
    },
    triggerClose() {
      closeHandler?.()
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createDiscordAdapter", () => {
  beforeEach(() => {
    mockInvoke.mockReset()
    mockListen.mockReset()
    // Default: WS open returns handle-id
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "connectors_ws_open") return "gateway-handle-id"
      if (cmd === "connectors_ws_send") return undefined
      if (cmd === "connectors_ws_close") return undefined
      return makeSendOkResp()
    })
    mockListen.mockResolvedValue(jest.fn())
  })

  it("exposes correct meta", () => {
    const adapter = makeAdapter()
    expect(adapter.id).toBe("dc-1")
    expect(adapter.meta.type).toBe("discord")
    expect(adapter.meta.displayName).toBe("My Discord Bot")
    expect(adapter.meta.version).toBe("0.1.0")
    expect(adapter.meta.transportModes).toContain("gateway")
    expect(adapter.meta.capabilities).toContain("send.text")
  })

  it("health() starts as 'starting'", () => {
    const adapter = makeAdapter()
    expect(adapter.health().state).toBe("starting")
  })

  it("health() is 'running' after start()", async () => {
    const adapter = makeAdapter()
    const { ctx } = makeCtx()
    await adapter.start(ctx)
    expect(adapter.health().state).toBe("running")
    await adapter.stop()
  })

  it("health() is 'down' after stop()", async () => {
    const adapter = makeAdapter()
    const { ctx } = makeCtx()
    await adapter.start(ctx)
    await adapter.stop()
    expect(adapter.health().state).toBe("down")
  })

  it("start() drives gateway messages and emits parsed events", async () => {
    const session = createFakeGatewaySession()
    mockListen.mockImplementation(session.listenImpl)

    const adapter = createDiscordAdapter({
      id: "dc-evt",
      displayName: "Test Bot",
      botToken: async () => "TOKEN",
      selfId: "bot-id",
    })

    const { ctx, emitted } = makeCtx()
    await adapter.start(ctx)

    // Wait for gateway listeners to register
    await session.waitForListeners()

    // Drive HELLO → IDENTIFY → MESSAGE_CREATE
    session.push({ op: 10, d: { heartbeat_interval: 100000 } })
    await new Promise((r) => setTimeout(r, 20))

    session.push({
      op: 0,
      t: "MESSAGE_CREATE",
      s: 1,
      d: {
        id: "msg-111",
        content: "hello from discord",
        channel_id: "chan-1",
        author: { id: "user-1", username: "Alice", global_name: "Alice" },
        timestamp: "2024-05-05T12:00:00.000000+00:00",
        attachments: [],
        mentions: [],
      },
    })

    await new Promise((r) => setTimeout(r, 20))
    await adapter.stop()

    expect(emitted.length).toBeGreaterThanOrEqual(1)
    expect(emitted[0].messageId).toBe("msg-111")
    expect(emitted[0].platform).toBe("discord")
  }, 10000)

  it("send() calls Discord messages endpoint", async () => {
    mockInvoke.mockResolvedValue(makeSendOkResp("sent-id"))

    const adapter = makeAdapter()
    const req = {
      conversationRef: {
        platform: "discord" as const,
        adapterId: "dc-1",
        channelId: "channel-abc",
      },
      segments: [{ type: "text" as const, text: "Hello world" }],
      metadata: { idempotencyKey: "key-1" },
    }

    const result = await adapter.send(req)

    expect(result.ok).toBe(true)
    expect(result.platformMessageId).toBe("sent-id")

    const httpCalls = mockInvoke.mock.calls.filter(
      ([cmd]: [string]) => cmd === "connectors_http_request"
    )
    expect(httpCalls.length).toBeGreaterThan(0)
    const reqPayload = (httpCalls[0][1] as { req: { url: string; method: string } }).req
    expect(reqPayload.url).toContain("/channels/channel-abc/messages")
    expect(reqPayload.method).toBe("POST")
  })

  it("setTyping(on=true) calls POST /channels/:id/typing", async () => {
    mockInvoke.mockResolvedValue(makeTypingOkResp())

    const adapter = makeAdapter()
    await adapter.setTyping!("discord:dc-1:channel-xyz", true)

    const httpCalls = mockInvoke.mock.calls.filter(
      ([cmd]: [string]) => cmd === "connectors_http_request"
    )
    expect(httpCalls.length).toBeGreaterThan(0)
    const reqPayload = (httpCalls[0][1] as { req: { url: string } }).req
    expect(reqPayload.url).toContain("/channels/channel-xyz/typing")
  })

  it("setTyping(on=false) is a no-op", async () => {
    const adapter = makeAdapter()
    await adapter.setTyping!("discord:dc-1:channel-xyz", false)

    const httpCalls = mockInvoke.mock.calls.filter(
      ([cmd]: [string]) => cmd === "connectors_http_request"
    )
    expect(httpCalls).toHaveLength(0)
  })
})
