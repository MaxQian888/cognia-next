import { listen } from "@tauri-apps/api/event"
import { createOneBotAdapter } from "./index"
import type { AdapterContext, NormalizedInboundEvent } from "@/types/connectors"
import { __resetOneBotVariantCacheForTesting } from "./parse"

// Mock the generic WS client commands so the forward-ws path doesn't invoke
// Tauri. The reverse-ws path (default in most tests) never touches these.
jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsOnebotSend: jest.fn(),
  connectorsWsOpen: jest.fn().mockResolvedValue("fw-1"),
  connectorsWsSend: jest.fn().mockResolvedValue(undefined),
  connectorsWsClose: jest.fn().mockResolvedValue(undefined),
}))
import { connectorsOnebotSend, connectorsWsOpen } from "@/lib/connectors/tauri/commands"

// Identity + impl probes persist through the adapter-instances repo — mock it
// so the on-connect writes are observable without touching Dexie.
jest.mock("@/lib/db/adapter-instances", () => ({
  updateAdapterInstance: jest.fn().mockResolvedValue(undefined),
  getAdapterInstance: jest.fn().mockResolvedValue(undefined),
}))
import { updateAdapterInstance } from "@/lib/db/adapter-instances"

// The inbound media pass is inert off-desktop anyway; mocked so the DEPS the
// adapter hands it are observable — which address the download floor is
// widened to is a security decision made here.
jest.mock("./inbound-media", () => ({
  enrichOneBotInboundMedia: jest.fn().mockResolvedValue(undefined),
}))
import { enrichOneBotInboundMedia } from "./inbound-media"

const mockListen = listen as jest.Mock
const mockOnebotSend = connectorsOnebotSend as jest.Mock
const mockUpdateAdapter = updateAdapterInstance as jest.Mock
const mockWsOpen = connectorsWsOpen as jest.Mock
const mockEnrichMedia = enrichOneBotInboundMedia as jest.Mock

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

  function trigger(topic: string, payload: string) {
    const handlers = listeners.get(topic) ?? []
    for (const h of handlers) h({ payload })
  }

  return { listenImpl, trigger }
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
  mockOnebotSend.mockReset()
  mockUpdateAdapter.mockClear()
  __resetOneBotVariantCacheForTesting()
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

  it("health() stays 'starting' after start() until the transport opens", async () => {
    const bus = createEventBus()
    mockListen.mockImplementation(bus.listenImpl)
    respondByAction(bus, "ob-start", {})

    const adapter = makeAdapter("ob-start")
    const { ctx } = makeCtx()
    await adapter.start(ctx)
    // No client has connected yet — claiming "running" here was the bug.
    expect(adapter.health().state).toBe("starting")

    bus.trigger("connectors://onebot/ob-start/open", "")
    expect(adapter.health().state).toBe("running")
    await adapter.stop()
  })

  it("health() degrades when the connection closes after opening", async () => {
    const bus = createEventBus()
    mockListen.mockImplementation(bus.listenImpl)
    respondByAction(bus, "ob-close", {})

    const adapter = makeAdapter("ob-close")
    const { ctx } = makeCtx()
    await adapter.start(ctx)
    bus.trigger("connectors://onebot/ob-close/open", "")
    expect(adapter.health().state).toBe("running")
    bus.trigger("connectors://onebot/ob-close/close", "")
    expect(adapter.health().state).toBe("degraded")
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

    // Mock the native command to respond immediately with a success response.
    mockOnebotSend.mockImplementation(async (_adapterId: string, payload: string) => {
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
    expect(mockOnebotSend).toHaveBeenCalledWith(
      "ob-send",
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

  it("only trusts the forward-ws address while the transport is dialling it", async () => {
    // A `forwardWsUrl` left on the config after a switch back to reverse-ws is
    // not an address anything is talking to. Handing it to the media pass would
    // keep the LAN download exception open with no connection behind it.
    const bus = createEventBus()
    mockListen.mockImplementation(bus.listenImpl)
    mockEnrichMedia.mockClear()

    const v11Msg = {
      time: 1700000000,
      self_id: 100000,
      post_type: "message",
      message_type: "private",
      message_id: 1001,
      user_id: 200001,
      sender: { user_id: 200001, nickname: "Alice" },
      message: [{ type: "text", data: { text: "hi" } }],
    }

    const stale = createOneBotAdapter({
      id: "ob-stale-fwd",
      displayName: "T",
      selfBotUin: "100000",
      transportMode: "reverse-ws",
      forwardWsUrl: "ws://192.168.1.9:3001",
    })
    await stale.start(makeCtx().ctx)
    bus.trigger("connectors://onebot/ob-stale-fwd/event", JSON.stringify(v11Msg))
    await new Promise((r) => setTimeout(r, 20))
    expect(mockEnrichMedia).toHaveBeenCalledWith(expect.anything(), {})
    await stale.stop()

    mockEnrichMedia.mockClear()
    const live = createOneBotAdapter({
      id: "ob-live-fwd",
      displayName: "T",
      selfBotUin: "100000",
      transportMode: "forward-ws",
      forwardWsUrl: "ws://192.168.1.9:3001",
    })
    await live.start(makeCtx().ctx)
    // Forward-ws reads from the WS connection id `connectorsWsOpen` returned.
    bus.trigger("connectors://ws/fw-1/message", JSON.stringify(v11Msg))
    await new Promise((r) => setTimeout(r, 20))
    expect(mockEnrichMedia).toHaveBeenCalledWith(expect.anything(), {
      forwardWsUrl: "ws://192.168.1.9:3001",
    })
    await live.stop()
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

// ---------------------------------------------------------------------------
// identity probe (get_login_info on connect)
// ---------------------------------------------------------------------------

/**
 * Respond to every outbound RPC on the send channel by action, so probes and
 * forward fetches resolve immediately (and never leave a 10s timeout pending).
 * Actions listed in `failedActions` get a `status:"failed"` response (how a
 * v12 upstream answers a v11-only action like get_version_info).
 */
function respondByAction(
  bus: ReturnType<typeof createEventBus>,
  id: string,
  byAction: Record<string, unknown>,
  failedActions: string[] = []
) {
  mockOnebotSend.mockImplementation(async (_adapterId: string, payload: string) => {
    const call = JSON.parse(payload) as { echo: string; action: string }
    const failed = failedActions.includes(call.action)
    const data = byAction[call.action] ?? {}
    setTimeout(() => {
      bus.trigger(
        `connectors://onebot/${id}/response`,
        JSON.stringify(
          failed
            ? { status: "failed", retcode: 1404, data: null, echo: call.echo }
            : { status: "ok", retcode: 0, data, echo: call.echo }
        )
      )
    }, 1)
  })
}

describe("createOneBotAdapter — identity probe", () => {
  it("writes lastWhoamiResult from get_login_info on connect", async () => {
    const bus = createEventBus()
    mockListen.mockImplementation(bus.listenImpl)
    respondByAction(bus, "ob-whoami", {
      get_login_info: { user_id: 100000, nickname: "MyBot" },
      get_version_info: { app_name: "NapCat.Onebot", app_version: "2.0" },
    })

    const adapter = createOneBotAdapter({ id: "ob-whoami", displayName: "T", selfBotUin: "100000" })
    const { ctx } = makeCtx()
    await adapter.start(ctx)

    // Fire the open handshake — probes ride it.
    bus.trigger("connectors://onebot/ob-whoami/open", "")
    await new Promise((r) => setTimeout(r, 30))

    expect(mockUpdateAdapter).toHaveBeenCalledWith(
      "ob-whoami",
      expect.objectContaining({
        lastWhoamiResult: { botName: "MyBot", appId: "100000", openId: "100000" },
        lastWhoamiAt: expect.any(Number),
      })
    )
    await adapter.stop()
  })

  it("infers v12 on a fresh connect (real frame order: open BEFORE any event) when get_version_info fails", async () => {
    const bus = createEventBus()
    mockListen.mockImplementation(bus.listenImpl)
    // A v12 upstream rejects the v11-only get_version_info action; the probe
    // chain must fall back to get_self_info instead of firing get_login_info
    // into the void.
    respondByAction(
      bus,
      "ob-v12fresh",
      { get_self_info: { user_id: 100000, user_displayname: "V12 Bot" } },
      ["get_version_info", "get_login_info"]
    )

    const adapter = createOneBotAdapter({
      id: "ob-v12fresh",
      displayName: "T",
      selfBotUin: "100000",
    })
    const { ctx } = makeCtx()
    await adapter.start(ctx)

    // Real order: the socket opens first; no inbound event has revealed the
    // variant yet (currentVariant === null).
    bus.trigger("connectors://onebot/ob-v12fresh/open", "")
    await new Promise((r) => setTimeout(r, 30))

    const loginCall = mockOnebotSend.mock.calls.find((c) => String(c[1]).includes("get_login_info"))
    expect(loginCall).toBeUndefined()
    const selfInfoCall = mockOnebotSend.mock.calls.find((c) =>
      String(c[1]).includes("get_self_info")
    )
    expect(selfInfoCall).toBeDefined()
    expect(mockUpdateAdapter).toHaveBeenCalledWith(
      "ob-v12fresh",
      expect.objectContaining({
        lastWhoamiResult: { botName: "V12 Bot", appId: "100000", openId: "100000" },
      })
    )
    await adapter.stop()
  })

  it("uses get_self_info directly when the v12 variant is already cached (reconnect)", async () => {
    const bus = createEventBus()
    mockListen.mockImplementation(bus.listenImpl)
    respondByAction(bus, "ob-v12who", {
      get_self_info: { user_id: 100000, user_displayname: "V12 Bot" },
      get_version_info: { app_name: "NapCat", app_version: "2.0" },
    })

    const adapter = createOneBotAdapter({ id: "ob-v12who", displayName: "T", selfBotUin: "100000" })
    const { ctx } = makeCtx()
    await adapter.start(ctx)

    // Reconnect scenario: a v12 message from the previous connection already
    // seeded the variant cache; the re-open probe must use it as-is.
    const v12Msg = {
      id: "evt-1",
      time: 1700000000,
      type: "message",
      detail_type: "private",
      message_id: "m-1",
      user_id: "200001",
      self: { platform: "qq", user_id: "100000" },
      sender: { user_id: "200001", nickname: "Bob" },
      message: [{ type: "text", data: { text: "hi" } }],
    }
    bus.trigger("connectors://onebot/ob-v12who/event", JSON.stringify(v12Msg))
    await new Promise((r) => setTimeout(r, 10))

    bus.trigger("connectors://onebot/ob-v12who/open", "")
    await new Promise((r) => setTimeout(r, 30))

    const call = mockOnebotSend.mock.calls.find((c) => String(c[1]).includes("get_self_info"))
    expect(call).toBeDefined()
    expect(mockUpdateAdapter).toHaveBeenCalledWith(
      "ob-v12who",
      expect.objectContaining({
        lastWhoamiResult: { botName: "V12 Bot", appId: "100000", openId: "100000" },
      })
    )
    await adapter.stop()
  })

  it("retries the other variant's identity action once when the hinted probe yields nothing", async () => {
    const bus = createEventBus()
    mockListen.mockImplementation(bus.listenImpl)
    // get_version_info answers ok (hints v11) but get_login_info fails — the
    // probe must retry with get_self_info instead of giving up.
    respondByAction(
      bus,
      "ob-retry",
      {
        get_version_info: { app_name: "SomeImpl", app_version: "1.0" },
        get_self_info: { user_id: 100000, user_name: "Fallback Bot" },
      },
      ["get_login_info"]
    )

    const adapter = createOneBotAdapter({ id: "ob-retry", displayName: "T", selfBotUin: "100000" })
    const { ctx } = makeCtx()
    await adapter.start(ctx)

    bus.trigger("connectors://onebot/ob-retry/open", "")
    await new Promise((r) => setTimeout(r, 30))

    expect(mockUpdateAdapter).toHaveBeenCalledWith(
      "ob-retry",
      expect.objectContaining({
        lastWhoamiResult: { botName: "Fallback Bot", appId: "100000", openId: "100000" },
      })
    )
    await adapter.stop()
  })

  it("grants set_msg_emoji_like to an LLOneBot upstream via the impl probe", async () => {
    const bus = createEventBus()
    mockListen.mockImplementation(bus.listenImpl)
    respondByAction(bus, "ob-llob", {
      get_version_info: { app_name: "LLOneBot", app_version: "3.34" },
      get_login_info: { user_id: 100000, nickname: "LL" },
    })

    const adapter = createOneBotAdapter({ id: "ob-llob", displayName: "T", selfBotUin: "100000" })
    const { ctx } = makeCtx()
    await adapter.start(ctx)

    bus.trigger("connectors://onebot/ob-llob/open", "")
    await new Promise((r) => setTimeout(r, 30))

    expect(mockUpdateAdapter).toHaveBeenCalledWith(
      "ob-llob",
      expect.objectContaining({
        implMetadata: {
          impl: "llonebot",
          version: "3.34",
          features: ["set_msg_emoji_like"],
        },
      })
    )
    await adapter.stop()
  })

  it("warns when the reported UIN differs from the configured selfBotUin", async () => {
    const bus = createEventBus()
    mockListen.mockImplementation(bus.listenImpl)
    respondByAction(bus, "ob-mismatch", {
      get_login_info: { user_id: 100000, nickname: "MyBot" },
      get_version_info: { app_name: "NapCat", app_version: "2.0" },
    })

    const adapter = createOneBotAdapter({ id: "ob-mismatch", displayName: "T", selfBotUin: "999" })
    const { ctx } = makeCtx()
    await adapter.start(ctx)

    bus.trigger("connectors://onebot/ob-mismatch/open", "")
    await new Promise((r) => setTimeout(r, 30))

    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining("identity mismatch"))
    await adapter.stop()
  })
})

// ---------------------------------------------------------------------------
// merged-forward (inbound get_forward_msg enrichment + outbound forwardMessage)
// ---------------------------------------------------------------------------

describe("createOneBotAdapter — merged-forward", () => {
  it("resolves an inbound forward via get_forward_msg before emitting", async () => {
    const bus = createEventBus()
    mockListen.mockImplementation(bus.listenImpl)
    respondByAction(bus, "ob-fwd", {
      get_forward_msg: {
        messages: [
          {
            type: "node",
            data: { nickname: "Bob", content: [{ type: "text", data: { text: "hi" } }] },
          },
        ],
      },
    })

    const adapter = createOneBotAdapter({ id: "ob-fwd", displayName: "T", selfBotUin: "100000" })
    const { ctx, emitted } = makeCtx()
    await adapter.start(ctx)

    const v11Msg = {
      time: 1700000000,
      self_id: 100000,
      post_type: "message",
      message_type: "private",
      message_id: 1001,
      user_id: 200001,
      sender: { user_id: 200001, nickname: "Alice" },
      message: [{ type: "forward", data: { id: "fwd-1" } }],
    }
    bus.trigger("connectors://onebot/ob-fwd/event", JSON.stringify(v11Msg))
    await new Promise((r) => setTimeout(r, 40))

    expect(emitted.length).toBeGreaterThanOrEqual(1)
    expect(emitted[0].plainText).toContain("Bob: hi")
    await adapter.stop()
  })

  it("forwardMessage() sends a group merged-forward", async () => {
    const bus = createEventBus()
    mockListen.mockImplementation(bus.listenImpl)
    respondByAction(bus, "ob-fwdsend", { send_group_forward_msg: { message_id: 555 } })

    const adapter = createOneBotAdapter({
      id: "ob-fwdsend",
      displayName: "T",
      selfBotUin: "100000",
    })
    const { ctx } = makeCtx()
    await adapter.start(ctx)
    // RPCs are liveness-gated — a client must have connected.
    bus.trigger("connectors://onebot/ob-fwdsend/open", "")

    const result = await adapter.forwardMessage!({ messageIds: ["1", "2"], target: "g:300001" })

    expect(result.ok).toBe(true)
    expect(result.platformMessageId).toBe("555")
    expect(mockOnebotSend).toHaveBeenCalledWith(
      "ob-fwdsend",
      expect.stringContaining("send_group_forward_msg")
    )
    await adapter.stop()
  })

  it("forwardMessage() returns a validation error for an unrecognised target", async () => {
    const bus = createEventBus()
    mockListen.mockImplementation(bus.listenImpl)

    const adapter = makeAdapter("ob-fwdbad")
    const { ctx } = makeCtx()
    await adapter.start(ctx)

    const result = await adapter.forwardMessage!({ messageIds: ["1"], target: "weird" })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe("validation")
    await adapter.stop()
  })

  it("forwardMessage() surfaces a retryable error when the transport send fails", async () => {
    const bus = createEventBus()
    mockListen.mockImplementation(bus.listenImpl)
    // Reject the native command so sendToOneBot rejects immediately.
    mockOnebotSend.mockImplementation(async () => {
      throw new Error("socket down")
    })

    const adapter = makeAdapter("ob-fwderr")
    const { ctx } = makeCtx()
    await adapter.start(ctx)
    bus.trigger("connectors://onebot/ob-fwderr/open", "")

    const result = await adapter.forwardMessage!({ messageIds: ["1"], target: "g:1" })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe("platform_5xx")
    expect(result.error?.retryable).toBe(true)
    await adapter.stop()
  })

  it("forwardMessage() returns a validation error on a v12 upstream (v11-only extension)", async () => {
    const bus = createEventBus()
    mockListen.mockImplementation(bus.listenImpl)
    respondByAction(bus, "ob-fwdv12", {})

    const adapter = makeAdapter("ob-fwdv12")
    const { ctx } = makeCtx()
    await adapter.start(ctx)

    // Seed the v12 variant.
    const v12Msg = {
      id: "evt-1",
      time: 1700000000,
      type: "message",
      detail_type: "group",
      message_id: "m-1",
      user_id: "200001",
      group_id: "300001",
      self: { platform: "qq", user_id: "100000" },
      message: [{ type: "text", data: { text: "seed" } }],
    }
    bus.trigger("connectors://onebot/ob-fwdv12/event", JSON.stringify(v12Msg))
    await new Promise((r) => setTimeout(r, 20))

    const result = await adapter.forwardMessage!({ messageIds: ["1"], target: "g:300001" })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe("validation")
    expect(result.error?.retryable).toBe(false)
    expect(result.error?.message).toContain("merged-forward")
    await adapter.stop()
  })
})

// ---------------------------------------------------------------------------
// health lifecycle + activity tracking
// ---------------------------------------------------------------------------

describe("createOneBotAdapter — health & activity", () => {
  beforeEach(() => {
    mockWsOpen.mockReset()
  })

  it("forward-ws: degrades with reason 'connect_failed' after 3 consecutive failed dials", async () => {
    const bus = createEventBus()
    mockListen.mockImplementation(bus.listenImpl)
    mockWsOpen.mockRejectedValue(new Error("connection refused"))

    const adapter = createOneBotAdapter({
      id: "ob-nodial",
      displayName: "T",
      selfBotUin: "100000",
      transportMode: "forward-ws",
      forwardWsUrl: "ws://127.0.0.1:1",
      _backoffBaseMs: 1,
    })
    const { ctx } = makeCtx()
    await adapter.start(ctx)

    // One failure so far — still starting, not yet degraded.
    expect(adapter.health().state).toBe("starting")

    // Failures 2 and 3 ride the (1ms-base) reconnect backoff.
    await new Promise((r) => setTimeout(r, 100))
    expect(adapter.health().state).toBe("degraded")
    expect(adapter.health().reason).toBe("connect_failed")

    await adapter.stop()
    expect(adapter.health().state).toBe("down")
  })

  it("refreshes lastActivityAt on heartbeat meta events", async () => {
    const bus = createEventBus()
    mockListen.mockImplementation(bus.listenImpl)
    respondByAction(bus, "ob-heart", {})

    const adapter = makeAdapter("ob-heart")
    const { ctx } = makeCtx()
    await adapter.start(ctx)
    expect(adapter.health().lastActivityAt).toBeUndefined()

    const heartbeat = {
      time: 1700000000,
      self_id: 100000,
      post_type: "meta_event",
      meta_event_type: "heartbeat",
    }
    bus.trigger("connectors://onebot/ob-heart/event", JSON.stringify(heartbeat))
    await new Promise((r) => setTimeout(r, 20))

    expect(adapter.health().lastActivityAt).toBeDefined()
    await adapter.stop()
  })

  it("refreshes lastActivityAt on a successful send", async () => {
    const bus = createEventBus()
    mockListen.mockImplementation(bus.listenImpl)
    respondByAction(bus, "ob-act", { send_private_msg: { message_id: 1 } })

    const adapter = makeAdapter("ob-act")
    const { ctx } = makeCtx()
    await adapter.start(ctx)
    bus.trigger("connectors://onebot/ob-act/open", "")
    const openActivity = adapter.health().lastActivityAt
    expect(openActivity).toBeDefined()

    await new Promise((r) => setTimeout(r, 15))
    const result = await adapter.send({
      conversationRef: { platform: "onebot", adapterId: "ob-act", chatKey: "p:200001" },
      segments: [{ type: "text", text: "ping" }],
      metadata: { idempotencyKey: "k-act" },
    })
    expect(result.ok).toBe(true)
    expect(adapter.health().lastActivityAt!).toBeGreaterThan(openActivity!)
    await adapter.stop()
  })

  it("send() surfaces the fast no-client failure as a retryable platform error", async () => {
    const bus = createEventBus()
    mockListen.mockImplementation(bus.listenImpl)
    mockOnebotSend.mockResolvedValue(undefined)

    const adapter = makeAdapter("ob-noclient")
    const { ctx } = makeCtx()
    await adapter.start(ctx)

    // No open / no event — the reverse-WS transport fails fast instead of
    // eating the 10s RPC timeout.
    const result = await adapter.send({
      conversationRef: { platform: "onebot", adapterId: "ob-noclient", chatKey: "p:200001" },
      segments: [{ type: "text", text: "ping" }],
      metadata: { idempotencyKey: "k-nc" },
    })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe("platform_5xx")
    expect(result.error?.message).toContain("no connected client")
    await adapter.stop()
  })

  it("send() returns a non-retryable validation error for v12 media (upload_file gap)", async () => {
    const bus = createEventBus()
    mockListen.mockImplementation(bus.listenImpl)
    respondByAction(bus, "ob-v12media", {})

    const adapter = makeAdapter("ob-v12media")
    const { ctx } = makeCtx()
    await adapter.start(ctx)

    const v12Msg = {
      id: "evt-1",
      time: 1700000000,
      type: "message",
      detail_type: "private",
      message_id: "m-1",
      user_id: "200001",
      self: { platform: "qq", user_id: "100000" },
      message: [{ type: "text", data: { text: "seed" } }],
    }
    bus.trigger("connectors://onebot/ob-v12media/event", JSON.stringify(v12Msg))
    await new Promise((r) => setTimeout(r, 20))

    const result = await adapter.send({
      conversationRef: { platform: "onebot", adapterId: "ob-v12media", chatKey: "p:200001" },
      segments: [{ type: "image", url: "https://x.com/a.png" }],
      metadata: { idempotencyKey: "k-v12m" },
    })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe("validation")
    expect(result.error?.retryable).toBe(false)
    expect(result.error?.message).toContain("requires upload_file")
    await adapter.stop()
  })

  it("enriches an inbound reply snippet via get_msg before emitting", async () => {
    const bus = createEventBus()
    mockListen.mockImplementation(bus.listenImpl)
    respondByAction(bus, "ob-replysnip", {
      get_msg: { message: [{ type: "text", data: { text: "original quoted text" } }] },
    })

    const adapter = makeAdapter("ob-replysnip")
    const { ctx, emitted } = makeCtx()
    await adapter.start(ctx)

    const v11Msg = {
      time: 1700000000,
      self_id: 100000,
      post_type: "message",
      message_type: "group",
      message_id: 1002,
      group_id: 300001,
      user_id: 200001,
      sender: { user_id: 200001, nickname: "Alice" },
      message: [
        { type: "reply", data: { id: "5555" } },
        { type: "text", data: { text: "ack" } },
      ],
    }
    bus.trigger("connectors://onebot/ob-replysnip/event", JSON.stringify(v11Msg))
    await new Promise((r) => setTimeout(r, 40))

    expect(emitted.length).toBeGreaterThanOrEqual(1)
    expect(emitted[0].replyTo).toEqual({ messageId: "5555", snippet: "original quoted text" })
    await adapter.stop()
  })
})

describe("createOneBotAdapter — identity probe edge cases", () => {
  it("does not write a whoami snapshot when get_login_info omits user_id", async () => {
    const bus = createEventBus()
    mockListen.mockImplementation(bus.listenImpl)
    respondByAction(bus, "ob-nouid", {
      get_login_info: { nickname: "Nameless" }, // no user_id
      get_version_info: { app_name: "NapCat", app_version: "2.0" },
    })

    const adapter = createOneBotAdapter({ id: "ob-nouid", displayName: "T", selfBotUin: "100000" })
    const { ctx } = makeCtx()
    await adapter.start(ctx)

    bus.trigger("connectors://onebot/ob-nouid/open", "")
    await new Promise((r) => setTimeout(r, 30))

    expect(mockUpdateAdapter).not.toHaveBeenCalledWith(
      "ob-nouid",
      expect.objectContaining({ lastWhoamiResult: expect.anything() })
    )
    await adapter.stop()
  })
})
