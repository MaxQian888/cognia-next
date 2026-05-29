/**
 * @jest-environment jsdom
 */

import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { createLarkAdapter } from "./index"
import type { AdapterContext, NormalizedInboundEvent } from "@/types/connectors"

const mockInvoke = invoke as jest.Mock
const mockListen = listen as jest.Mock

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTatOkResp(token = "t-tat-test") {
  return {
    status: 200,
    headers: {},
    body: JSON.stringify({ code: 0, tenant_access_token: token, expire: 7200 }),
  }
}

function makeSendOkResp() {
  return {
    status: 200,
    headers: {},
    body: JSON.stringify({ code: 0, data: { message_id: "om_resp_001" } }),
  }
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
    adapterId: "lark-test",
  }
  return { ctx, emitted }
}

function makeAdapter(transport: "webhook" | "long-connection" = "long-connection") {
  return createLarkAdapter({
    id: "lark-1",
    displayName: "My Lark Bot",
    appId: async () => "cli_app_001",
    appSecret: async () => "app-secret-001",
    verificationToken: async () => "verify-token-001",
    selfBotOpenId: "ou_bot_self_001",
    transport,
  })
}

// ---------------------------------------------------------------------------
// Fake long-connection WS session
// ---------------------------------------------------------------------------

function createFakeLongConnSession() {
  let messageHandler: ((event: { payload: string }) => void) | null = null
  let closeHandler: (() => void) | null = null
  let listenCallCount = 0
  let handlersResolve: () => void = () => {}
  const handlersReadyP = new Promise<void>((r) => {
    handlersResolve = r
  })

  const listenImpl = jest.fn().mockImplementation(async (eventName: string, handler: unknown) => {
    listenCallCount++
    if ((eventName as string).endsWith("/event")) {
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

describe("createLarkAdapter", () => {
  beforeEach(() => {
    mockInvoke.mockReset()
    mockListen.mockReset()
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "connectors_lark_ws_open") return "lark-ws-handle"
      if (cmd === "connectors_lark_ws_close") return undefined
      if (cmd === "connectors_http_request") return makeTatOkResp()
      return undefined
    })
    mockListen.mockResolvedValue(jest.fn())
  })

  it("exposes correct meta for long-connection", () => {
    const adapter = makeAdapter("long-connection")
    expect(adapter.id).toBe("lark-1")
    expect(adapter.meta.type).toBe("lark")
    expect(adapter.meta.displayName).toBe("My Lark Bot")
    expect(adapter.meta.version).toBe("0.1.0")
    expect(adapter.meta.transportModes).toContain("gateway")
    expect(adapter.meta.capabilities).toContain("send.text")
  })

  it("exposes webhook transport mode for webhook", () => {
    const adapter = makeAdapter("webhook")
    expect(adapter.meta.transportModes).toContain("webhook")
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

  it("start() skips adapters with empty appId/appSecret (no doomed reconnect loop)", async () => {
    const adapter = createLarkAdapter({
      id: "lark-empty",
      displayName: "Unconfigured Bot",
      appId: async () => "",
      appSecret: async () => "",
      verificationToken: async () => "",
      selfBotOpenId: "ou_bot",
      transport: "long-connection",
    })
    const { ctx } = makeCtx()
    await adapter.start(ctx)
    // Give any (incorrectly-started) async transport loop a tick to fire.
    await new Promise((r) => setTimeout(r, 20))
    // Skipped cleanly: health is 'down' and the Rust WS open command never ran.
    expect(adapter.health().state).toBe("down")
    const openCalls = mockInvoke.mock.calls.filter(
      ([cmd]: [string]) => cmd === "connectors_lark_ws_open"
    )
    expect(openCalls).toHaveLength(0)
  })

  it("start() is idempotent (second call is no-op)", async () => {
    const adapter = makeAdapter()
    const { ctx } = makeCtx()
    await adapter.start(ctx)
    await adapter.start(ctx)
    expect(adapter.health().state).toBe("running")
    await adapter.stop()
  })

  it("start() drives long-connection events and emits parsed events", async () => {
    const session = createFakeLongConnSession()
    mockListen.mockImplementation(session.listenImpl)

    mockInvoke.mockImplementation(async (cmd: string) => {
      // The long-connection handshake + protobuf framing now live in Rust; the
      // TS side only opens a handle and listens on the lark-ws event channel.
      if (cmd === "connectors_lark_ws_open") return "lark-ws-x"
      if (cmd === "connectors_lark_ws_close") return undefined
      return undefined
    })

    const adapter = createLarkAdapter({
      id: "lark-evt",
      displayName: "Event Test Bot",
      appId: async () => "cli_app_evt",
      appSecret: async () => "secret-evt",
      verificationToken: async () => "token-evt",
      selfBotOpenId: "ou_bot_evt",
      transport: "long-connection",
    })

    const { ctx, emitted } = makeCtx()
    await adapter.start(ctx)

    await session.waitForListeners()

    session.push({
      schema: "2.0",
      header: { event_id: "evt_001", event_type: "im.message.receive_v1" },
      event: {
        sender: { sender_id: { open_id: "ou_user_001" } },
        message: {
          message_id: "om_evt_001",
          chat_id: "oc_chat_001",
          chat_type: "p2p",
          message_type: "text",
          content: '{"text":"hello from lark"}',
          create_time: "1714900000000",
        },
      },
    })

    await new Promise((r) => setTimeout(r, 30))
    await adapter.stop()

    expect(emitted.length).toBeGreaterThanOrEqual(1)
    expect(emitted[0].platform).toBe("lark")
    expect(emitted[0].messageId).toBe("om_evt_001")
  }, 15000)

  it("maps a bot-menu (快捷指令) click to its configured action", async () => {
    const session = createFakeLongConnSession()
    mockListen.mockImplementation(session.listenImpl)

    const adapter = createLarkAdapter({
      id: "lark-menu",
      displayName: "Menu Test Bot",
      appId: async () => "cli_menu",
      appSecret: async () => "secret-menu",
      verificationToken: async () => "token-menu",
      selfBotOpenId: "ou_bot_menu",
      quickCommands: [{ triggerKey: "agenda", action: { type: "slash", value: "/agenda today" } }],
      transport: "long-connection",
    })

    const { ctx, emitted } = makeCtx()
    await adapter.start(ctx)
    await session.waitForListeners()

    session.push({
      schema: "2.0",
      header: { event_id: "evt_menu_1", event_type: "application.bot.menu_v6" },
      event: {
        operator: { operator_id: { open_id: "ou_user_777" } },
        event_key: "agenda",
      },
    })

    await new Promise((r) => setTimeout(r, 30))
    await adapter.stop()

    expect(emitted.length).toBeGreaterThanOrEqual(1)
    expect(emitted[0].plainText).toBe("/agenda today")
    expect(emitted[0].conversationRef.channelId).toBe("ou_user_777")
  }, 15000)

  it("send() acquires TAT and calls Lark API", async () => {
    // Use fresh appId/appSecret so the cache won't already have a token
    const adapter = createLarkAdapter({
      id: "lark-send-test",
      displayName: "Send Test Bot",
      appId: async () => "cli_send_unique",
      appSecret: async () => "secret_send_unique",
      verificationToken: async () => "token",
      selfBotOpenId: "ou_bot",
      transport: "long-connection",
    })

    mockInvoke
      .mockResolvedValueOnce(makeTatOkResp("t-send-tat")) // TAT fetch
      .mockResolvedValueOnce(makeSendOkResp()) // message send

    const req = {
      conversationRef: {
        platform: "lark" as const,
        adapterId: "lark-send-test",
        channelId: "oc_chat_001",
      },
      segments: [{ type: "text" as const, text: "Hello Lark" }],
      metadata: { idempotencyKey: "k1" },
    }

    const result = await adapter.send(req)
    expect(result.ok).toBe(true)

    const httpCalls = mockInvoke.mock.calls.filter(
      ([cmd]: [string]) => cmd === "connectors_http_request"
    )
    expect(httpCalls.length).toBeGreaterThanOrEqual(2)

    const sendCall = httpCalls[1]
    const reqPayload = (sendCall[1] as { req: { url: string; headers: Record<string, string> } })
      .req
    expect(reqPayload.url).toContain("/im/v1/messages")
    expect(reqPayload.headers["Authorization"]).toContain("Bearer t-send-tat")
  })

  it("setTyping() is a no-op (returns without calling API)", async () => {
    const adapter = makeAdapter()
    await adapter.setTyping!("lark:lark-1:oc_chat_001", true)
    const httpCalls = mockInvoke.mock.calls.filter(
      ([cmd]: [string]) => cmd === "connectors_http_request"
    )
    expect(httpCalls).toHaveLength(0)
  })

  it("fetchHistory() returns an empty async iterable", async () => {
    const adapter = makeAdapter()
    const events: unknown[] = []
    for await (const evt of adapter.fetchHistory!("lark:lark-1:oc_chat_001", {})) {
      events.push(evt)
    }
    expect(events).toHaveLength(0)
  })

  it("refreshCredentials() resolves without error", async () => {
    const adapter = makeAdapter()
    await expect(adapter.refreshCredentials!()).resolves.toBeUndefined()
  })
})
