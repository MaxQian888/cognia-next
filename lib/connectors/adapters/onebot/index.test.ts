import { listen } from "@tauri-apps/api/event"
import { createOneBotAdapter } from "./index"
import * as serializer from "./serialize"
jest.mock("./serialize", () => {
  const actual = jest.requireActual("./serialize")
  return { ...actual, serializeOutboundV11: jest.fn(actual.serializeOutboundV11) }
})
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
import { getAdapterInstance, updateAdapterInstance } from "@/lib/db/adapter-instances"

// The inbound media pass is inert off-desktop anyway; mocked so the DEPS the
// adapter hands it are observable — which address the download floor is
// widened to is a security decision made here.
jest.mock("./inbound-media", () => ({
  enrichOneBotInboundMedia: jest.fn().mockResolvedValue(undefined),
}))
import { enrichOneBotInboundMedia } from "./inbound-media"
import { effectiveCapabilities } from "@/lib/connectors/effective-capabilities"

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

  it("leaves edit() and setTyping() absent (OneBot has neither API)", () => {
    const adapter = makeAdapter("ob-edit")
    expect(adapter.edit).toBeUndefined()
    expect(adapter.setTyping).toBeUndefined()
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

async function waitForIdentity(adapterId: string): Promise<void> {
  const deadline = Date.now() + 2000
  while (
    !mockUpdateAdapter.mock.calls.some(
      ([id, update]) => id === adapterId && update.lastWhoamiResult
    )
  ) {
    if (Date.now() >= deadline) throw new Error(`Identity probe did not settle: ${adapterId}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
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
      {
        get_self_info: { user_id: 100000, user_displayname: "V12 Bot" },
        get_supported_actions: ["upload_file", "send_message", "delete_message"],
      },
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
    await waitForIdentity("ob-v12fresh")

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
    expect(mockUpdateAdapter).toHaveBeenCalledWith(
      "ob-v12fresh",
      expect.objectContaining({
        implMetadata: expect.objectContaining({
          features: expect.arrayContaining(["upload_file"]),
        }),
      })
    )
    await adapter.delete!("message-1")
    expect(
      mockOnebotSend.mock.calls.some((call) =>
        String(call[1]).includes('"action":"delete_message"')
      )
    ).toBe(true)
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
    expect(JSON.parse(call![1]).self).toEqual(v12Msg.self)
    await adapter.delete!("message-2")
    const deletion = mockOnebotSend.mock.calls.find(
      (c) => JSON.parse(c[1]).action === "delete_message"
    )
    expect(JSON.parse(deletion![1]).self).toEqual(v12Msg.self)
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
    await waitForIdentity("ob-retry")

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

  it("forwardMessage() does not retry an ambiguous native send failure", async () => {
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
    expect(result.error?.code).toBe("delivery_unknown")
    expect(result.error?.retryable).toBe(false)
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

  it.each([true, false])(
    "v12 media respects upload_file discovery (supported=%s)",
    async (supported) => {
      const bus = createEventBus()
      mockListen.mockImplementation(bus.listenImpl)
      respondByAction(bus, "ob-v12media", {
        get_supported_actions: supported ? ["upload_file", "send_message"] : ["send_message"],
        upload_file: { file_id: "uploaded-1" },
        send_message: { message_id: "sent-1" },
      })

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
      if (supported) {
        expect(result).toMatchObject({ ok: true, platformMessageId: "sent-1" })
        const calls = mockOnebotSend.mock.calls.map((call) => JSON.parse(call[1]))
        expect(calls.map((call) => call.action)).toEqual([
          "get_supported_actions",
          "upload_file",
          "send_message",
        ])
        expect(calls[1].params).toEqual({ type: "url", name: "a.png", url: "https://x.com/a.png" })
        expect(calls[2].params.message).toEqual([
          { type: "image", data: { file_id: "uploaded-1" } },
        ])
      } else {
        expect(result.ok).toBe(false)
        expect(result.error?.code).toBe("validation")
        expect(result.error?.retryable).toBe(false)
        expect(result.error?.message).toContain("upload_file")
      }
      await adapter.stop()
    }
  )

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

describe("OneBot action acknowledgements", () => {
  it.each([
    ["g", 2, 50],
    ["p", 2, 50],
    ["g", 20, 20],
    ["p", 20, 20],
  ])("stops %s history after a %i-message terminal page (max=%i)", async (chatType, size, max) => {
    const bus = createEventBus()
    mockListen.mockImplementation(bus.listenImpl)
    const adapter = makeAdapter("history-terminal")
    await adapter.start(makeCtx().ctx)
    bus.trigger(
      "connectors://onebot/history-terminal/event",
      JSON.stringify({ post_type: "meta_event" })
    )
    const messages = Array.from({ length: size }, (_, index) => ({
      time: 1700000000 + index,
      self_id: 100000,
      post_type: "message",
      message_type: chatType === "g" ? "group" : "private",
      message_id: index + 1,
      message_seq: index + 1,
      user_id: 200001,
      ...(chatType === "g" ? { group_id: 300001 } : {}),
      sender: { user_id: 200001, nickname: "Alice" },
      message: [{ type: "text", data: { text: `history-${index}` } }],
    }))
    mockOnebotSend.mockImplementation(async (_id: string, payload: string) => {
      const call = JSON.parse(payload)
      bus.trigger(
        "connectors://onebot/history-terminal/response",
        JSON.stringify(
          mockOnebotSend.mock.calls.length === 1
            ? { status: "ok", retcode: 0, data: { messages }, echo: call.echo }
            : { status: "failed", retcode: 1200, message: "cursor exhausted", echo: call.echo }
        )
      )
    })
    try {
      const collected = []
      for await (const event of adapter.fetchHistory!(
        `onebot:history-terminal:${chatType}:${chatType === "g" ? "300001" : "200001"}`,
        { max }
      ))
        collected.push(event.messageId)
      expect(collected).toEqual(messages.map((message) => String(message.message_id)))
      expect(mockOnebotSend).toHaveBeenCalledTimes(1)
    } finally {
      await adapter.stop()
    }
  })

  it.each([
    ["g", "get_group_msg_history"],
    ["p", "get_friend_msg_history"],
  ])(
    "surfaces rejected %s history instead of returning an empty page",
    async (chatType, action) => {
      const bus = createEventBus()
      mockListen.mockImplementation(bus.listenImpl)
      const adapter = makeAdapter("history-reject")
      await adapter.start(makeCtx().ctx)
      bus.trigger(
        "connectors://onebot/history-reject/event",
        JSON.stringify({ post_type: "meta_event" })
      )
      mockOnebotSend.mockImplementation(async (_id: string, payload: string) => {
        const call = JSON.parse(payload)
        expect(call.action).toBe(action)
        bus.trigger(
          "connectors://onebot/history-reject/response",
          JSON.stringify({
            status: "failed",
            retcode: 1200,
            data: null,
            message: "fixture history denied",
            echo: call.echo,
          })
        )
      })
      try {
        await expect(
          (async () => {
            for await (const event of adapter.fetchHistory!(
              `onebot:history-reject:${chatType}:300001`,
              {}
            ))
              void event
          })()
        ).rejects.toMatchObject({
          name: "OneBotRpcError",
          code: "platform_4xx",
          message: expect.stringContaining("fixture history denied"),
          retryable: false,
        })
      } finally {
        await adapter.stop()
      }
    }
  )

  it("rejects an inconsistent success acknowledgement when fetching history", async () => {
    const bus = createEventBus()
    mockListen.mockImplementation(bus.listenImpl)
    const adapter = makeAdapter("history-unconfirmed")
    await adapter.start(makeCtx().ctx)
    bus.trigger(
      "connectors://onebot/history-unconfirmed/event",
      JSON.stringify({ post_type: "meta_event" })
    )
    mockOnebotSend.mockImplementation(async (_id: string, payload: string) => {
      const call = JSON.parse(payload)
      bus.trigger(
        "connectors://onebot/history-unconfirmed/response",
        JSON.stringify({ status: "ok", retcode: 1200, data: { messages: [] }, echo: call.echo })
      )
    })
    try {
      await expect(
        adapter.fetchHistory!("onebot:history-unconfirmed:g:300001", {})
          [Symbol.asyncIterator]()
          .next()
      ).rejects.toMatchObject({ name: "OneBotRpcError", code: "delivery_unknown" })
    } finally {
      await adapter.stop()
    }
  })

  it.each([
    [{ status: "failed", retcode: 1400, data: null, wording: "permission denied" }, "platform_4xx"],
    [{ status: "async", retcode: 1, data: null }, "delivery_unknown"],
    [{ status: "ok", retcode: 1400, data: { message_id: 9 } }, "delivery_unknown"],
    [{ status: "ok", retcode: 0, data: {} }, "delivery_unknown"],
  ])("does not report a rejected or unconfirmed send as delivered: %j", async (response, code) => {
    const bus = createEventBus()
    mockListen.mockImplementation(bus.listenImpl)
    const adapter = makeAdapter("ack")
    await adapter.start(makeCtx().ctx)
    bus.trigger("connectors://onebot/ack/event", JSON.stringify({ post_type: "meta_event" }))
    mockOnebotSend.mockImplementation(async (_id: string, payload: string) => {
      const call = JSON.parse(payload)
      bus.trigger(
        "connectors://onebot/ack/response",
        JSON.stringify({ ...response, echo: call.echo })
      )
    })
    const result = await adapter.send({
      conversationRef: { platform: "onebot", adapterId: "ack", chatKey: "p:200001" },
      segments: [{ type: "text", text: "hello" }],
      metadata: { idempotencyKey: "ack" },
    })
    expect(result).toMatchObject({ ok: false, error: { code, retryable: false } })
    await adapter.stop()
  })

  it("surfaces negative acknowledgements for forwards, deletes and both reaction operations", async () => {
    const bus = createEventBus()
    mockListen.mockImplementation(bus.listenImpl)
    const adapter = makeAdapter("reject")
    await adapter.start(makeCtx().ctx)
    bus.trigger("connectors://onebot/reject/event", JSON.stringify({ post_type: "meta_event" }))
    respondByAction(bus, "reject", {}, [
      "send_group_forward_msg",
      "delete_msg",
      "set_msg_emoji_like",
    ])
    ;(getAdapterInstance as jest.Mock).mockResolvedValue({
      implMetadata: { features: ["set_msg_emoji_like"] },
    })
    try {
      expect(await adapter.forwardMessage!({ messageId: "7", target: "g:123" })).toMatchObject({
        ok: false,
        error: { code: "platform_4xx", retryable: false },
      })
      await expect(adapter.delete!("7")).rejects.toThrow(/1404/)
      await expect(adapter.addReaction!("7", "1")).rejects.toThrow(/1404/)
      await expect(adapter.removeReaction!("7", "1")).rejects.toThrow(/1404/)
    } finally {
      ;(getAdapterInstance as jest.Mock).mockResolvedValue(undefined)
      await adapter.stop()
    }
  })
})

it("stops after partial delivery and forbids retrying already delivered parts", async () => {
  const bus = createEventBus()
  mockListen.mockImplementation(bus.listenImpl)
  const adapter = makeAdapter("partial")
  await adapter.start(makeCtx().ctx)
  bus.trigger("connectors://onebot/partial/event", JSON.stringify({ post_type: "meta_event" }))
  ;(serializer.serializeOutboundV11 as jest.Mock).mockReturnValueOnce([
    { action: "send_private_msg", echo: "part-1", params: {} },
    { action: "send_private_msg", echo: "part-2", params: {} },
    { action: "send_private_msg", echo: "part-3", params: {} },
  ])
  mockOnebotSend.mockImplementation(async (_id: string, payload: string) => {
    const call = JSON.parse(payload)
    bus.trigger(
      "connectors://onebot/partial/response",
      JSON.stringify({
        echo: call.echo,
        ...(call.echo === "part-1"
          ? { status: "ok", retcode: 0, data: { message_id: 19 } }
          : { status: "failed", retcode: 1400 }),
      })
    )
  })
  try {
    expect(
      await adapter.send({
        conversationRef: { platform: "onebot", adapterId: "partial", chatKey: "p:2" },
        segments: [{ type: "text", text: "parts" }],
        metadata: { idempotencyKey: "parts" },
      })
    ).toMatchObject({
      ok: false,
      platformMessageId: "19",
      error: { code: "delivery_unknown", retryable: false },
    })
    expect(mockOnebotSend).toHaveBeenCalledTimes(2)
  } finally {
    await adapter.stop()
  }
})

// SnowLuma v2.2.0: sanitized history rows, signed message-id anchors and extensions.
describe("SnowLuma wire contracts", () => {
  async function setupSnowLuma(id: string) {
    const bus = createEventBus()
    mockListen.mockImplementation(bus.listenImpl)
    respondByAction(bus, id, {
      get_version_info: {
        app_name: "SnowLuma",
        app_version: "2.2.0-node",
        protocol_version: "v11",
      },
      get_login_info: { user_id: 100000, nickname: "Snow fixture" },
    })
    const adapter = makeAdapter(id)
    const { ctx, emitted } = makeCtx()
    await adapter.start(ctx)
    bus.trigger(`connectors://onebot/${id}/open`, "")
    await new Promise((resolve) => setTimeout(resolve, 30))
    mockOnebotSend.mockClear()
    return { adapter, bus, emitted }
  }

  function historyRow(chatType: string, id: number, time: number, outgoing = false) {
    return {
      time,
      message_type: chatType === "g" ? "group" : "private",
      sub_type: chatType === "g" ? "normal" : "friend",
      message_id: id,
      real_id: id,
      message_seq: time + 90000,
      user_id: outgoing ? 100000 : 200001,
      ...(chatType === "g" ? { group_id: 300001 } : outgoing ? { target_id: 200001 } : {}),
      sender: { user_id: outgoing ? 100000 : 200001, nickname: outgoing ? "Self" : "Peer" },
      message: [{ type: "text", data: { text: `history-${id}` } }],
    }
  }

  function respondHistory(
    bus: ReturnType<typeof createEventBus>,
    id: string,
    page: (call: { action: string; params: Record<string, unknown> }) => unknown[]
  ) {
    mockOnebotSend.mockImplementation(async (_id: string, payload: string) => {
      const call = JSON.parse(payload)
      bus.trigger(
        `connectors://onebot/${id}/response`,
        JSON.stringify({
          status: "ok",
          retcode: 0,
          data: { messages: page(call) },
          echo: call.echo,
        })
      )
    })
  }

  it.each(["g", "p"])("normalizes sanitized %s history without live emission", async (chatType) => {
    const id = `snow-history-${chatType}`
    const { adapter, bus, emitted } = await setupSnowLuma(id)
    respondHistory(bus, id, () => [
      historyRow(chatType, -7, 10),
      historyRow(chatType, -8, 11, true),
    ])
    try {
      const events = []
      const chatId = chatType === "g" ? "300001" : "200001"
      for await (const event of adapter.fetchHistory!(`onebot:${id}:${chatType}:${chatId}`, {}))
        events.push(event)
      expect(events).toHaveLength(2)
      expect(events.map((event) => event.selfId)).toEqual(["100000", "100000"])
      expect(events.map((event) => event.sender.remoteUserId)).toEqual(["200001", "100000"])
      expect(
        events.every((event) => event.conversationKey === `onebot:${id}:${chatType}:${chatId}`)
      ).toBe(true)
      expect(events[1].channelData).toMatchObject({ onebotHistory: true })
      expect(events[1].conversationRef).toMatchObject({ chatKey: `${chatType}:${chatId}` })
      if (chatType === "p") expect(events[1].conversationRef.userId).toBe(200001)
      expect(emitted).toHaveLength(0)
    } finally {
      await adapter.stop()
    }
  })

  it.each(["g", "p"])(
    "paginates %s history using signed IDs and inclusive anchors",
    async (chatType) => {
      const id = `snow-pages-${chatType}`
      const { adapter, bus } = await setupSnowLuma(id)
      const first = Array.from({ length: 20 }, (_, i) => historyRow(chatType, -1000 - i, 100 + i))
      const second = Array.from({ length: 20 }, (_, i) => historyRow(chatType, -2000 - i, 80 + i))
      const calls: Record<string, unknown>[] = []
      respondHistory(bus, id, (call) => {
        calls.push(call.params)
        return calls.length === 1
          ? [...first].reverse()
          : calls.length === 2
            ? [first[0], ...second].reverse()
            : [second[0]]
      })
      try {
        const events = []
        for await (const event of adapter.fetchHistory!(
          `onebot:${id}:${chatType}:${chatType === "g" ? "300001" : "200001"}`,
          { max: 100 }
        ))
          events.push(event)
        expect(events).toHaveLength(40)
        expect(new Set(events.map((event) => event.messageId)).size).toBe(40)
        expect(calls.map((call) => call.message_id)).toEqual([undefined, -1000, -2000])
        expect(calls.map((call) => call.count)).toEqual([20, 21, 21])
        expect(calls.every((call) => call.message_seq === undefined)).toBe(true)
      } finally {
        await adapter.stop()
      }
    }
  )

  it("excludes an explicit anchor, stops repeated pages and respects max", async () => {
    const id = "snow-bounds"
    const { adapter, bus } = await setupSnowLuma(id)
    const page = Array.from({ length: 21 }, (_, i) => historyRow("g", -100 - i, 100 + i))
    respondHistory(bus, id, () => page)
    try {
      const events = []
      for await (const event of adapter.fetchHistory!(`onebot:${id}:g:300001`, {
        before: "-100",
        max: 50,
      }))
        events.push(event)
      expect(events).toHaveLength(20)
      expect(events.some((event) => event.messageId === "-100")).toBe(false)
      expect(mockOnebotSend).toHaveBeenCalledTimes(2)
      mockOnebotSend.mockClear()
      const limited = []
      for await (const event of adapter.fetchHistory!(`onebot:${id}:g:300001`, { max: 1 }))
        limited.push(event)
      expect(limited).toHaveLength(1)
      expect(mockOnebotSend).toHaveBeenCalledTimes(1)
    } finally {
      await adapter.stop()
    }
  })

  it.each(["g", "p"])("drops wrong-conversation %s history rows", async (chatType) => {
    const id = `snow-scope-${chatType}`
    const { adapter, bus } = await setupSnowLuma(id)
    respondHistory(bus, id, () => [
      historyRow(chatType, -1, 1),
      {
        ...historyRow(chatType, -2, 2),
        ...(chatType === "g" ? { group_id: 999 } : { user_id: 999 }),
      },
      { ...historyRow(chatType, -3, 3), post_type: "notice", notice_type: "group_recall" },
    ])
    try {
      const events = []
      for await (const event of adapter.fetchHistory!(
        `onebot:${id}:${chatType}:${chatType === "g" ? "300001" : "200001"}`,
        {}
      ))
        events.push(event)
      expect(events.map((event) => event.messageId)).toEqual(["-1"])
    } finally {
      await adapter.stop()
    }
  })

  it("exposes supported file/reaction features and sends add/remove/file actions", async () => {
    const id = "snow-features"
    const { adapter, bus } = await setupSnowLuma(id)
    try {
      const metadata = mockUpdateAdapter.mock.calls.find(
        (call) => call[0] === id && call[1].implMetadata
      )?.[1].implMetadata
      expect(metadata).toMatchObject({
        impl: "snowluma",
        features: expect.arrayContaining([
          "set_msg_emoji_like",
          "upload_group_file",
          "upload_private_file",
        ]),
      })
      expect(metadata.features).not.toContain("markdown-card")
      expect(
        effectiveCapabilities({ platform: "onebot", implMetadata: metadata }).capabilities
      ).toEqual(expect.arrayContaining(["send.reaction", "send.file"]))
      ;(getAdapterInstance as jest.Mock).mockResolvedValue({ implMetadata: metadata })
      const calls: { action: string; params: Record<string, unknown> }[] = []
      mockOnebotSend.mockImplementation(async (_id: string, payload: string) => {
        const call = JSON.parse(payload)
        calls.push(call)
        bus.trigger(
          `connectors://onebot/${id}/response`,
          JSON.stringify({ status: "ok", retcode: 0, data: { message_id: -9 }, echo: call.echo })
        )
      })
      await adapter.addReaction!("-7", "128077")
      await adapter.removeReaction!("-7", "128077")
      expect(
        await adapter.send({
          conversationRef: { platform: "onebot", adapterId: id, chatKey: "g:300001" },
          segments: [
            {
              type: "file",
              url: "https://example.com/file.txt",
              name: "file.txt",
              mimeType: "text/plain",
              sizeBytes: 4,
            },
          ],
          metadata: { idempotencyKey: "snow-file" },
        })
      ).toMatchObject({ ok: true, platformMessageId: "-9" })
      expect(calls).toMatchObject([
        { action: "set_msg_emoji_like", params: { message_id: -7, emoji_id: "128077", set: true } },
        {
          action: "set_msg_emoji_like",
          params: { message_id: -7, emoji_id: "128077", set: false },
        },
        {
          action: "send_group_msg",
          params: {
            group_id: 300001,
            message: [
              { type: "file", data: { file: "https://example.com/file.txt", name: "file.txt" } },
            ],
          },
        },
      ])
    } finally {
      await adapter.stop()
      ;(getAdapterInstance as jest.Mock).mockResolvedValue(undefined)
    }
  })
})

// A private C2C message_seq belongs to its sender, not to the whole conversation.
it("continues same-second SnowLuma private history across opposite sender sequences", async () => {
  const bus = createEventBus()
  mockListen.mockImplementation(bus.listenImpl)
  ;(getAdapterInstance as jest.Mock).mockResolvedValue({ implMetadata: { impl: "snowluma" } })
  const adapter = makeAdapter("snow-same-second")
  await adapter.start(makeCtx().ctx)
  bus.trigger(
    "connectors://onebot/snow-same-second/event",
    JSON.stringify({ post_type: "meta_event" })
  )
  const row = (id: number, seq: number, outgoing = false) => ({
    time: 100,
    message_type: "private",
    message_id: id,
    message_seq: seq,
    user_id: outgoing ? 100000 : 200001,
    ...(outgoing ? { target_id: 200001 } : {}),
    message: [{ type: "text", data: { text: String(id) } }],
  })
  const first = Array.from({ length: 20 }, (_, i) => row(-100 - i, 10 + i))
  const second = Array.from({ length: 20 }, (_, i) => row(-200 - i, 200 + i, true))
  const pages = [first, [...second, first[0]], [row(-300, 1), second[0]]]
  const calls: Record<string, unknown>[] = []
  mockOnebotSend.mockImplementation(async (_id: string, payload: string) => {
    const call = JSON.parse(payload)
    calls.push(call.params)
    bus.trigger(
      "connectors://onebot/snow-same-second/response",
      JSON.stringify({
        status: "ok",
        retcode: 0,
        data: { messages: pages[calls.length - 1] ?? [] },
        echo: call.echo,
      })
    )
  })
  try {
    const events = []
    for await (const event of adapter.fetchHistory!("onebot:snow-same-second:p:200001", {
      max: 41,
    }))
      events.push(event)
    expect(events).toHaveLength(41)
    expect(calls.map((call) => call.message_id)).toEqual([undefined, -100, -200])
    expect(events[40].messageId).toBe("-300")
  } finally {
    await adapter.stop()
    ;(getAdapterInstance as jest.Mock).mockResolvedValue(undefined)
  }
})

it("continues filtered short SnowLuma history pages until no new message remains", async () => {
  const bus = createEventBus()
  mockListen.mockImplementation(bus.listenImpl)
  ;(getAdapterInstance as jest.Mock).mockResolvedValue({ implMetadata: { impl: "snowluma" } })
  const adapter = makeAdapter("snow-filtered")
  await adapter.start(makeCtx().ctx)
  bus.trigger(
    "connectors://onebot/snow-filtered/event",
    JSON.stringify({ post_type: "meta_event" })
  )
  const row = (id: number) => ({
    time: id,
    message_type: "group",
    group_id: 300001,
    user_id: 200001,
    message_id: -id,
    message: [{ type: "text", data: { text: String(id) } }],
  })
  const pages = [[row(10), row(11)], [row(9), row(10)], [row(9)]]
  const calls: Record<string, unknown>[] = []
  mockOnebotSend.mockImplementation(async (_id: string, payload: string) => {
    const call = JSON.parse(payload)
    calls.push(call.params)
    bus.trigger(
      "connectors://onebot/snow-filtered/response",
      JSON.stringify({
        status: "ok",
        retcode: 0,
        data: { messages: pages[calls.length - 1] ?? [] },
        echo: call.echo,
      })
    )
  })
  try {
    const events = []
    for await (const event of adapter.fetchHistory!("onebot:snow-filtered:g:300001", {}))
      events.push(event)
    expect(events.map((event) => event.messageId)).toEqual(["-10", "-11", "-9"])
    expect(calls.map((call) => call.message_id)).toEqual([undefined, -10, -9])
  } finally {
    await adapter.stop()
    ;(getAdapterInstance as jest.Mock).mockResolvedValue(undefined)
  }
})

it("reaches older same-second private history when an overlapping page filters a recalled row", async () => {
  const bus = createEventBus()
  mockListen.mockImplementation(bus.listenImpl)
  ;(getAdapterInstance as jest.Mock).mockResolvedValue({ implMetadata: { impl: "snowluma" } })
  const adapter = makeAdapter("snow-filtered-tie")
  await adapter.start(makeCtx().ctx)
  bus.trigger(
    "connectors://onebot/snow-filtered-tie/event",
    JSON.stringify({ post_type: "meta_event" })
  )
  const canonical = Array.from({ length: 22 }, (_, i) => ({
    time: 100,
    message_type: "private",
    message_id: -100 - i,
    message_seq: i % 2 === 0 ? 10 + i : 200 + i,
    user_id: i % 2 === 0 ? 200001 : 100000,
    ...(i % 2 === 0 ? {} : { target_id: 200001 }),
    message: [{ type: "text", data: { text: String(i) } }],
  }))
  const calls: Record<string, unknown>[] = []
  mockOnebotSend.mockImplementation(async (_id: string, payload: string) => {
    const call = JSON.parse(payload)
    calls.push(call.params)
    const anchor =
      call.params.message_id === undefined
        ? 0
        : canonical.findIndex((row) => row.message_id === call.params.message_id)
    expect(anchor).toBeGreaterThanOrEqual(0)
    const messages = canonical
      .slice(anchor, anchor + call.params.count)
      .filter((row) => row.message_id !== -120)
    bus.trigger(
      "connectors://onebot/snow-filtered-tie/response",
      JSON.stringify({ status: "ok", retcode: 0, data: { messages }, echo: call.echo })
    )
  })
  try {
    const events = []
    for await (const event of adapter.fetchHistory!("onebot:snow-filtered-tie:p:200001", {
      max: 50,
    }))
      events.push(event)
    expect(events.map((event) => event.messageId)).toEqual(
      canonical.filter((row) => row.message_id !== -120).map((row) => String(row.message_id))
    )
    expect(calls.some((call) => call.message_id === -119)).toBe(true)
    expect(calls.length).toBeLessThan(50)
  } finally {
    await adapter.stop()
    ;(getAdapterInstance as jest.Mock).mockResolvedValue(undefined)
  }
})
