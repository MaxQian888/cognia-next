import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { createDiscordAdapter } from "./index"
import { discordNonce } from "./serialize"
import { getBus } from "@/lib/connectors/bus"
import type { AdapterContext, NormalizedInboundEvent } from "@/types/connectors"

// Isolate the interaction-callback dispatch — the adapter forwards
// INTERACTION_CREATE to `getBus().dispatchConnectorCallback`. Stable closure so
// the same mock is inspectable across calls.
jest.mock("@/lib/connectors/bus", () => {
  const dispatchConnectorCallback = jest.fn(async () => {})
  return { getBus: () => ({ dispatchConnectorCallback }) }
})

// Only override `resolveCallbackBinding` (the modal-open lookup); everything
// else in the shared toolkit stays real.
const mockResolveCallbackBinding = jest.fn()
jest.mock("@/lib/connectors/adapters/_shared/a2ui-mapper", () => ({
  ...jest.requireActual("@/lib/connectors/adapters/_shared/a2ui-mapper"),
  resolveCallbackBinding: (...args: unknown[]) => mockResolveCallbackBinding(...args),
}))

const mockInvoke = invoke as jest.Mock
const mockListen = listen as jest.Mock
const busDispatch = (getBus() as unknown as { dispatchConnectorCallback: jest.Mock })
  .dispatchConnectorCallback

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
  let closeHandler: ((event: { payload?: unknown }) => void) | null = null
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
      closeHandler = handler as (event: { payload?: unknown }) => void
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
    triggerClose(payload?: unknown) {
      closeHandler?.({ payload })
    },
  }
}

/** Push HELLO + READY so the adapter reaches health()="running". */
async function driveReady(session: ReturnType<typeof createFakeGatewaySession>, selfId = "bot-id") {
  session.push({ op: 10, d: { heartbeat_interval: 100000 } })
  await new Promise((r) => setTimeout(r, 10))
  session.push({
    op: 0,
    t: "READY",
    s: 1,
    d: { user: { id: selfId }, session_id: "sess", resume_gateway_url: "wss://resume" },
  })
  await new Promise((r) => setTimeout(r, 10))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createDiscordAdapter", () => {
  beforeEach(() => {
    mockInvoke.mockReset()
    mockListen.mockReset()
    busDispatch.mockClear()
    mockResolveCallbackBinding.mockReset()
    mockResolveCallbackBinding.mockResolvedValue(undefined)
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
    expect(adapter.meta.transportModes).toContain("webhook")
    expect(adapter.meta.capabilities).toContain("send.text")
  })

  it("webhook mode subscribes to the webhook channel and opens no gateway socket", async () => {
    mockListen.mockResolvedValue(jest.fn())
    const adapter = createDiscordAdapter({
      id: "dc-wh",
      displayName: "Bot",
      botToken: async () => "T",
      selfId: "b",
      transportMode: "webhook",
    })
    const { ctx } = makeCtx()
    await adapter.start(ctx)

    const listenNames = mockListen.mock.calls.map(([n]: [string]) => n)
    expect(listenNames).toContain("connectors://webhook/dc-wh")
    const wsOpens = mockInvoke.mock.calls.filter(([cmd]: [string]) => cmd === "connectors_ws_open")
    expect(wsOpens).toHaveLength(0)
    expect(adapter.health().state).toBe("running")

    await adapter.stop()
    expect(adapter.health().state).toBe("down")
  })

  it("health() starts as 'starting'", () => {
    const adapter = makeAdapter()
    expect(adapter.health().state).toBe("starting")
  })

  it("health() stays 'starting' after start() until READY, then becomes 'running'", async () => {
    const session = createFakeGatewaySession()
    mockListen.mockImplementation(session.listenImpl)

    const adapter = makeAdapter()
    const { ctx } = makeCtx()
    await adapter.start(ctx)

    // Gateway socket opened but not authenticated yet — NOT healthy.
    await session.waitForListeners()
    expect(adapter.health().state).toBe("starting")

    await driveReady(session)
    expect(adapter.health().state).toBe("running")
    expect(adapter.health().reason).toBeUndefined()

    await adapter.stop()
  }, 10000)

  it("health() degrades with a reason after 3 consecutive failed connects", async () => {
    mockListen.mockResolvedValue(jest.fn())
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "connectors_ws_open") throw new Error("refused")
      return makeSendOkResp()
    })

    const adapter = createDiscordAdapter({
      id: "dc-degraded",
      displayName: "Bot",
      botToken: async () => "T",
      selfId: "b",
      _backoffBaseMs: 1,
    })
    const { ctx } = makeCtx()
    await adapter.start(ctx)

    await new Promise((r) => setTimeout(r, 300))
    const health = adapter.health()
    expect(health.state).toBe("degraded")
    expect(health.reason).toMatch(/consecutive failed connects/)

    await adapter.stop()
  }, 10000)

  it("health() goes 'down' with the close code in the reason on a fatal gateway close", async () => {
    const session = createFakeGatewaySession()
    mockListen.mockImplementation(session.listenImpl)

    const adapter = makeAdapter()
    const { ctx } = makeCtx()
    await adapter.start(ctx)
    await session.waitForListeners()
    await driveReady(session)
    expect(adapter.health().state).toBe("running")

    session.triggerClose({ code: 4014, reason: "Disallowed intent(s)." })
    await new Promise((r) => setTimeout(r, 50))

    const health = adapter.health()
    expect(health.state).toBe("down")
    expect(health.reason).toContain("4014")
    expect(health.reason).toContain("disallowed intents")

    await adapter.stop()
  }, 10000)

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

  it("send() uploads image/file media via connectors_discord_upload", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "connectors_discord_upload") return "uploaded-msg-id"
      return makeSendOkResp()
    })

    const adapter = makeAdapter()
    const req = {
      conversationRef: {
        platform: "discord" as const,
        adapterId: "dc-1",
        channelId: "channel-abc",
      },
      segments: [
        { type: "image" as const, url: "https://cdn/x/pic.png", alt: "pic" },
        {
          type: "file" as const,
          url: "https://cdn/x/report.pdf",
          name: "report.pdf",
          mimeType: "application/pdf",
          sizeBytes: 10,
        },
      ],
      metadata: { idempotencyKey: "k" },
    }

    const result = await adapter.send(req)
    expect(result.ok).toBe(true)
    expect(result.platformMessageId).toBe("uploaded-msg-id")

    const uploadCall = mockInvoke.mock.calls.find(
      ([cmd]: [string]) => cmd === "connectors_discord_upload"
    )
    expect(uploadCall).toBeDefined()
    const uploadReq = (
      uploadCall![1] as { req: { channelId: string; files: Array<{ filename: string }> } }
    ).req
    expect(uploadReq.channelId).toBe("channel-abc")
    // image filename derives from the URL basename; file uses seg.name.
    expect(uploadReq.files.map((f) => f.filename)).toEqual(["pic.png", "report.pdf"])
    // Platform idempotency: the media lane carries its own deterministic nonce.
    expect((uploadReq as { nonce?: string }).nonce).toBe(discordNonce("k", "media"))
  })

  it("send() stamps deterministic nonces on REST chunks and the voice lane", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "connectors_discord_upload") return "voice-msg-id"
      return makeSendOkResp("text-id")
    })

    const adapter = makeAdapter()
    const req = {
      conversationRef: {
        platform: "discord" as const,
        adapterId: "dc-1",
        channelId: "channel-abc",
      },
      segments: [
        { type: "voice" as const, url: "https://cdn/x/v.ogg", durationSec: 2 },
        { type: "text" as const, text: "after voice" },
      ],
      metadata: { idempotencyKey: "job-77" },
    }

    const first = await adapter.send(req)
    expect(first.ok).toBe(true)

    const uploadReq = (
      mockInvoke.mock.calls.find(([cmd]: [string]) => cmd === "connectors_discord_upload")![1] as {
        req: { nonce?: string; flags?: number }
      }
    ).req
    expect(uploadReq.flags).toBe(1 << 13)
    expect(uploadReq.nonce).toBe(discordNonce("job-77", "voice:0"))

    const restBody = JSON.parse(
      (
        mockInvoke.mock.calls.find(([cmd]: [string]) => cmd === "connectors_http_request")![1] as {
          req: { body: string }
        }
      ).req.body
    ) as { nonce?: string; enforce_nonce?: boolean }
    expect(restBody.nonce).toBe(discordNonce("job-77", 0))
    expect(restBody.enforce_nonce).toBe(true)

    // A retry of the same job re-posts identical nonces.
    mockInvoke.mockClear()
    await adapter.send(req)
    const retryUpload = (
      mockInvoke.mock.calls.find(([cmd]: [string]) => cmd === "connectors_discord_upload")![1] as {
        req: { nonce?: string }
      }
    ).req
    expect(retryUpload.nonce).toBe(uploadReq.nonce)
  })

  it("uploads a reply-only video with a fallback filename and threads the reply", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "connectors_discord_upload") return "vid-msg-id"
      return makeSendOkResp()
    })

    const adapter = makeAdapter()
    const req = {
      conversationRef: {
        platform: "discord" as const,
        adapterId: "dc-1",
        channelId: "channel-abc",
      },
      // Video with an extension-less URL → fallback filename; no text segment,
      // so the reply threads onto the media message.
      segments: [{ type: "video" as const, url: "https://cdn/x/clip" }],
      replyTo: { messageId: "orig-77" },
      metadata: { idempotencyKey: "k" },
    }

    const result = await adapter.send(req)
    expect(result.platformMessageId).toBe("vid-msg-id")

    const uploadReq = (
      mockInvoke.mock.calls.find(([cmd]: [string]) => cmd === "connectors_discord_upload")![1] as {
        req: { files: Array<{ filename: string }>; replyToMessageId?: string }
      }
    ).req
    expect(uploadReq.files[0].filename).toBe("video.mp4")
    expect(uploadReq.replyToMessageId).toBe("orig-77")
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

  it("pinMessage PUTs the current /channels/:channel/messages/pins/:message endpoint", async () => {
    mockInvoke.mockResolvedValue(makeTypingOkResp())

    const adapter = makeAdapter()
    await adapter.pinMessage!("discord:dc-1:channel-xyz", "channel-abc:msg-42")

    const httpCalls = mockInvoke.mock.calls.filter(
      ([cmd]: [string]) => cmd === "connectors_http_request"
    )
    const reqPayload = (httpCalls[0][1] as { req: { url: string; method: string } }).req
    expect(reqPayload.url).toContain("/channels/channel-abc/messages/pins/msg-42")
    expect(reqPayload.method).toBe("PUT")
  })

  it("pinMessage falls back to the conversationKey channel for bare message ids", async () => {
    mockInvoke.mockResolvedValue(makeTypingOkResp())

    const adapter = makeAdapter()
    await adapter.pinMessage!("discord:dc-1:channel-xyz", "msg-42")

    const httpCalls = mockInvoke.mock.calls.filter(
      ([cmd]: [string]) => cmd === "connectors_http_request"
    )
    const reqPayload = (httpCalls[0][1] as { req: { url: string } }).req
    expect(reqPayload.url).toContain("/channels/channel-xyz/messages/pins/msg-42")
  })

  it("unpinMessage DELETEs /channels/:channel/messages/pins/:message from the composite id", async () => {
    mockInvoke.mockResolvedValue(makeTypingOkResp())

    const adapter = makeAdapter()
    await adapter.unpinMessage!("channel-abc:msg-42")

    const httpCalls = mockInvoke.mock.calls.filter(
      ([cmd]: [string]) => cmd === "connectors_http_request"
    )
    const reqPayload = (httpCalls[0][1] as { req: { url: string; method: string } }).req
    expect(reqPayload.url).toContain("/channels/channel-abc/messages/pins/msg-42")
    expect(reqPayload.method).toBe("DELETE")
  })

  it("unpinMessage throws on a bare (non-composite) message id", async () => {
    const adapter = makeAdapter()
    await expect(adapter.unpinMessage!("msg-42")).rejects.toThrow(/channelId:messageId/)
  })

  // ── delete (composite id contract) ─────────────────────────────────────────

  it("delete() throws on a bare message id instead of silently no-oping", async () => {
    const adapter = makeAdapter()
    await expect(adapter.delete!("msg-42")).rejects.toThrow(/channelId:messageId/)
    const httpCalls = mockInvoke.mock.calls.filter(
      ([cmd]: [string]) => cmd === "connectors_http_request"
    )
    expect(httpCalls).toHaveLength(0)
  })

  it("setPresenceStatus throws when the gateway is not connected", async () => {
    const adapter = makeAdapter()
    await expect(adapter.setPresenceStatus!({ text: "AI 1k" })).rejects.toThrow(/gateway/)
  })

  it("setTyping(on=false) is a no-op", async () => {
    const adapter = makeAdapter()
    await adapter.setTyping!("discord:dc-1:channel-xyz", false)

    const httpCalls = mockInvoke.mock.calls.filter(
      ([cmd]: [string]) => cmd === "connectors_http_request"
    )
    expect(httpCalls).toHaveLength(0)
  })

  // ── reactions (2-arg PlatformAdapter contract) ─────────────────────────────

  it("addReaction PUTs the reaction using the 'channel:message' composite id", async () => {
    mockInvoke.mockResolvedValue(makeTypingOkResp())

    const adapter = makeAdapter()
    const ref = await adapter.addReaction!("channel-abc:msg-42", "👍")

    const req = (
      mockInvoke.mock.calls.find(([cmd]: [string]) => cmd === "connectors_http_request")![1] as {
        req: { url: string; method: string }
      }
    ).req
    expect(req.method).toBe("PUT")
    expect(req.url).toContain("/channels/channel-abc/messages/msg-42/reactions/")
    expect(req.url).toContain("%F0%9F%91%8D") // 👍 URL-encoded
    expect(req.url).toContain("/@me")
    // Discord reactions have no id — the emoji round-trips as reactionId.
    expect(ref).toEqual({ reactionId: "👍" })
  })

  it("removeReaction DELETEs the reaction via the returned reactionId", async () => {
    mockInvoke.mockResolvedValue(makeTypingOkResp())

    const adapter = makeAdapter()
    await adapter.removeReaction!("channel-abc:msg-42", "👍")

    const req = (
      mockInvoke.mock.calls.find(([cmd]: [string]) => cmd === "connectors_http_request")![1] as {
        req: { url: string; method: string }
      }
    ).req
    expect(req.method).toBe("DELETE")
    expect(req.url).toContain("/channels/channel-abc/messages/msg-42/reactions/")
  })

  it("addReaction throws when the message id lacks a channel prefix", async () => {
    const adapter = makeAdapter()
    await expect(adapter.addReaction!("msg-42", "👍")).rejects.toThrow(/channelId:messageId/)
  })

  // ── interaction ACK (the fix that unbreaks A2UI buttons) ───────────────────

  it("ACKs an INTERACTION_CREATE within 3s and dispatches the callback", async () => {
    const session = createFakeGatewaySession()
    mockListen.mockImplementation(session.listenImpl)

    const adapter = createDiscordAdapter({
      id: "dc-int",
      displayName: "Bot",
      botToken: async () => "T",
      selfId: "bot-id",
    })
    const { ctx } = makeCtx()
    await adapter.start(ctx)
    await session.waitForListeners()

    session.push({ op: 10, d: { heartbeat_interval: 100000 } })
    await new Promise((r) => setTimeout(r, 20))

    session.push({
      op: 0,
      t: "INTERACTION_CREATE",
      s: 2,
      d: {
        type: 3, // MESSAGE_COMPONENT
        id: "int-1",
        token: "int-token",
        application_id: "app-1",
        channel_id: "chan-1",
        member: { user: { id: "user-1", username: "Bob" } },
        data: { custom_id: "a2ui:s:c:click", component_type: 2 },
      },
    })
    await new Promise((r) => setTimeout(r, 20))
    await adapter.stop()

    const ackReq = mockInvoke.mock.calls
      .filter(([cmd]: [string]) => cmd === "connectors_http_request")
      .map(
        ([, a]: [string, unknown]) =>
          (a as { req: { url: string; method: string; body?: string } }).req
      )
      .find((r) => r.url.includes("/interactions/int-1/int-token/callback"))
    expect(ackReq).toBeDefined()
    expect(ackReq!.method).toBe("POST")
    expect(JSON.parse(ackReq!.body!)).toEqual({ type: 6 })

    expect(busDispatch).toHaveBeenCalledTimes(1)
  }, 10000)

  it("answers a modal_open component click with an InteractionResponse type 9, no dispatch", async () => {
    mockResolveCallbackBinding.mockResolvedValueOnce({
      kind: "modal_open",
      payload: {
        title: "Feedback",
        inputs: [{ customId: "name", label: "Name", style: 1, required: true }],
      },
    })

    const session = createFakeGatewaySession()
    mockListen.mockImplementation(session.listenImpl)

    const adapter = createDiscordAdapter({
      id: "dc-modal",
      displayName: "Bot",
      botToken: async () => "T",
      selfId: "b",
    })
    const { ctx } = makeCtx()
    await adapter.start(ctx)
    await session.waitForListeners()

    session.push({ op: 10, d: { heartbeat_interval: 100000 } })
    await new Promise((r) => setTimeout(r, 20))

    session.push({
      op: 0,
      t: "INTERACTION_CREATE",
      s: 2,
      d: {
        type: 3,
        id: "int-9",
        token: "tok9",
        channel_id: "c1",
        member: { user: { id: "u1", username: "U" } },
        data: { custom_id: "a2ui:s:root:submit", component_type: 2 },
      },
    })
    await new Promise((r) => setTimeout(r, 20))
    await adapter.stop()

    const ackReq = mockInvoke.mock.calls
      .filter(([cmd]: [string]) => cmd === "connectors_http_request")
      .map(([, a]: [string, unknown]) => (a as { req: { url: string; body?: string } }).req)
      .find((r) => r.url.includes("/interactions/int-9/tok9/callback"))
    expect(ackReq).toBeDefined()
    const body = JSON.parse(ackReq!.body!) as {
      type: number
      data: { title: string; components: Array<{ components: Array<Record<string, unknown>> }> }
    }
    expect(body.type).toBe(9)
    expect(body.data.title).toBe("Feedback")
    expect(body.data.components[0].components[0]).toMatchObject({ type: 4, custom_id: "name" })

    // A modal OPEN must not dispatch a callback — the submit will, separately.
    expect(busDispatch).not.toHaveBeenCalled()
  }, 10000)

  it("ACKs a MODAL_SUBMIT (type 5) and dispatches the submitted values", async () => {
    const session = createFakeGatewaySession()
    mockListen.mockImplementation(session.listenImpl)

    const adapter = createDiscordAdapter({
      id: "dc-ms",
      displayName: "Bot",
      botToken: async () => "T",
      selfId: "b",
    })
    const { ctx } = makeCtx()
    await adapter.start(ctx)
    await session.waitForListeners()

    session.push({ op: 10, d: { heartbeat_interval: 100000 } })
    await new Promise((r) => setTimeout(r, 20))

    session.push({
      op: 0,
      t: "INTERACTION_CREATE",
      s: 2,
      d: {
        type: 5, // MODAL_SUBMIT
        id: "int-5",
        token: "tok5",
        channel_id: "c1",
        member: { user: { id: "u1", username: "U" } },
        data: {
          custom_id: "a2ui:s:root:submit",
          components: [{ components: [{ custom_id: "name", value: "Jane" }] }],
        },
      },
    })
    await new Promise((r) => setTimeout(r, 20))
    await adapter.stop()

    const ackReq = mockInvoke.mock.calls
      .filter(([cmd]: [string]) => cmd === "connectors_http_request")
      .map(([, a]: [string, unknown]) => (a as { req: { url: string; body?: string } }).req)
      .find((r) => r.url.includes("/interactions/int-5/tok5/callback"))
    expect(JSON.parse(ackReq!.body!)).toEqual({ type: 6 })
    expect(busDispatch).toHaveBeenCalledTimes(1)
  }, 10000)

  it("forwards the configured intents bitmask to the gateway IDENTIFY", async () => {
    const session = createFakeGatewaySession()
    mockListen.mockImplementation(session.listenImpl)

    const adapter = createDiscordAdapter({
      id: "dc-intents",
      displayName: "Bot",
      botToken: async () => "T",
      selfId: "bot-id",
      intents: 4096,
    })
    const { ctx } = makeCtx()
    await adapter.start(ctx)
    await session.waitForListeners()

    session.push({ op: 10, d: { heartbeat_interval: 100000 } })
    await new Promise((r) => setTimeout(r, 20))
    await adapter.stop()

    const identify = mockInvoke.mock.calls
      .filter(([cmd]: [string]) => cmd === "connectors_ws_send")
      .map(
        ([, a]: [string, unknown]) =>
          JSON.parse((a as { data: string }).data) as { op: number; d?: { intents?: number } }
      )
      .find((f) => f.op === 2)
    expect(identify?.d?.intents).toBe(4096)
  }, 10000)

  // ── self-echo guard (gateway → emit path) ──────────────────────────────────

  it("does not emit the bot's own MESSAGE_CREATE echo, but emits other users' messages", async () => {
    const session = createFakeGatewaySession()
    mockListen.mockImplementation(session.listenImpl)

    const adapter = createDiscordAdapter({
      id: "dc-echo",
      displayName: "Bot",
      botToken: async () => "T",
      selfId: "bot-self-id",
    })
    const { ctx, emitted } = makeCtx()
    await adapter.start(ctx)
    await session.waitForListeners()
    session.push({ op: 10, d: { heartbeat_interval: 100000 } })
    await new Promise((r) => setTimeout(r, 20))

    const baseMsg = {
      content: "hello",
      channel_id: "chan-1",
      timestamp: "2026-07-14T00:00:00.000Z",
      attachments: [],
      mentions: [],
    }
    // The bot's own echo — must be dropped.
    session.push({
      op: 0,
      t: "MESSAGE_CREATE",
      s: 1,
      d: { ...baseMsg, id: "echo-1", author: { id: "bot-self-id", username: "me", bot: true } },
    })
    // A real user message — must be emitted.
    session.push({
      op: 0,
      t: "MESSAGE_CREATE",
      s: 2,
      d: { ...baseMsg, id: "user-1-msg", author: { id: "user-1", username: "Alice" } },
    })
    await new Promise((r) => setTimeout(r, 30))
    await adapter.stop()

    expect(emitted.map((e) => e.messageId)).toEqual(["user-1-msg"])
  }, 10000)

  // ── outbound error mapping (429 / 4xx / 5xx) ───────────────────────────────

  function makeTextReq() {
    return {
      conversationRef: {
        platform: "discord" as const,
        adapterId: "dc-1",
        channelId: "chan-1",
      },
      segments: [{ type: "text" as const, text: "hi" }],
      metadata: { idempotencyKey: "k" },
    }
  }

  it("maps 429 to rate_limited with retryAfterMs from the JSON body (seconds → ms)", async () => {
    mockInvoke.mockResolvedValue({
      status: 429,
      headers: { "Retry-After": "3" },
      body: JSON.stringify({ message: "You are being rate limited.", retry_after: 1.5 }),
    })

    const adapter = makeAdapter()
    const result = await adapter.send(makeTextReq())
    expect(result.ok).toBe(false)
    expect(result.error).toMatchObject({
      code: "rate_limited",
      retryable: true,
      retryAfterMs: 1500,
    })
  })

  it("falls back to the Retry-After header when the 429 body has no retry_after", async () => {
    mockInvoke.mockResolvedValue({
      status: 429,
      headers: { "retry-after": "2" },
      body: "slow down",
    })

    const adapter = makeAdapter()
    const result = await adapter.send(makeTextReq())
    expect(result.error).toMatchObject({ code: "rate_limited", retryAfterMs: 2000 })
  })

  it("maps 401/403 to auth_failed, not retryable", async () => {
    mockInvoke.mockResolvedValue({ status: 403, headers: {}, body: '{"message":"Missing Access"}' })

    const adapter = makeAdapter()
    const result = await adapter.send(makeTextReq())
    expect(result.error).toMatchObject({ code: "auth_failed", retryable: false })
  })

  it("maps other 4xx to platform_4xx, not retryable (no more infinite 400 retries)", async () => {
    mockInvoke.mockResolvedValue({
      status: 400,
      headers: {},
      body: '{"message":"Invalid Form Body"}',
    })

    const adapter = makeAdapter()
    const result = await adapter.send(makeTextReq())
    expect(result.error).toMatchObject({ code: "platform_4xx", retryable: false })
  })

  it("keeps 5xx retryable as platform_5xx (send and edit)", async () => {
    mockInvoke.mockResolvedValue({ status: 502, headers: {}, body: "bad gateway" })

    const adapter = makeAdapter()
    const sendResult = await adapter.send(makeTextReq())
    expect(sendResult.error).toMatchObject({ code: "platform_5xx", retryable: true })

    const editResult = await adapter.edit!("msg-1", makeTextReq())
    expect(editResult.error).toMatchObject({ code: "platform_5xx", retryable: true })
  })

  it("edit() maps auth failures too", async () => {
    mockInvoke.mockResolvedValue({ status: 401, headers: {}, body: '{"message":"Unauthorized"}' })

    const adapter = makeAdapter()
    const result = await adapter.edit!("msg-1", makeTextReq())
    expect(result.error).toMatchObject({ code: "auth_failed", retryable: false })
  })

  // ── fetchHistory pagination (before/after are mutually exclusive) ──────────

  function makeHistMsg(id: string) {
    return {
      id,
      content: `msg ${id}`,
      channel_id: "chan-h",
      author: { id: "user-1", username: "Alice" },
      timestamp: "2026-07-14T00:00:00.000Z",
      attachments: [],
      mentions: [],
    }
  }

  function historyUrls(): string[] {
    return mockInvoke.mock.calls
      .filter(([cmd]: [string]) => cmd === "connectors_http_request")
      .map(([, a]: [string, unknown]) => (a as { req: { url: string } }).req.url)
      .filter((u) => u.includes("/channels/chan-h/messages?"))
  }

  it("fetchHistory default walks backward with a before cursor only", async () => {
    const pages = [
      [makeHistMsg("300"), makeHistMsg("200")], // newest-first
      [],
    ]
    let call = 0
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd !== "connectors_http_request") return undefined
      return { status: 200, headers: {}, body: JSON.stringify(pages[call++] ?? []) }
    })

    const adapter = makeAdapter()
    const events = []
    for await (const e of adapter.fetchHistory!("discord:dc-1:chan-h", {})) events.push(e)

    expect(events.map((e) => e.messageId)).toEqual(["300", "200"])
    const urls = historyUrls()
    expect(urls).toHaveLength(2)
    expect(urls[0]).not.toContain("before=")
    expect(urls[0]).not.toContain("after=")
    expect(urls[1]).toContain("before=200")
    expect(urls[1]).not.toContain("after=")
  })

  it("fetchHistory with opts.after walks forward, advancing after to the newest id and never sending before", async () => {
    const pages = [
      [makeHistMsg("300"), makeHistMsg("200")], // ids > after=100
      [],
    ]
    let call = 0
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd !== "connectors_http_request") return undefined
      return { status: 200, headers: {}, body: JSON.stringify(pages[call++] ?? []) }
    })

    const adapter = makeAdapter()
    const events = []
    for await (const e of adapter.fetchHistory!("discord:dc-1:chan-h", { after: "100" })) {
      events.push(e)
    }

    expect(events).toHaveLength(2)
    const urls = historyUrls()
    expect(urls).toHaveLength(2)
    expect(urls[0]).toContain("after=100")
    expect(urls[0]).not.toContain("before=")
    expect(urls[1]).toContain("after=300")
    expect(urls[1]).not.toContain("before=")
  })

  it("fetchHistory keeps the bot's own messages (self-echo guard does not apply to history)", async () => {
    const selfMsg = {
      ...makeHistMsg("55"),
      author: { id: "bot-self-id", username: "me", bot: true },
    }
    let served = false
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd !== "connectors_http_request") return undefined
      const body = served ? "[]" : JSON.stringify([selfMsg])
      served = true
      return { status: 200, headers: {}, body }
    })

    const adapter = makeAdapter()
    const events = []
    for await (const e of adapter.fetchHistory!("discord:dc-1:chan-h", {})) events.push(e)

    expect(events.map((e) => e.messageId)).toEqual(["55"])
  })

  // ── modal binding lookup deadline (3s ACK protection) ──────────────────────

  it("falls back to the deferred ACK when the modal binding lookup hangs", async () => {
    // Never-resolving Dexie lookup — the deadline must win.
    mockResolveCallbackBinding.mockReturnValueOnce(new Promise(() => {}))

    const session = createFakeGatewaySession()
    mockListen.mockImplementation(session.listenImpl)

    const adapter = createDiscordAdapter({
      id: "dc-slow",
      displayName: "Bot",
      botToken: async () => "T",
      selfId: "b",
    })
    const { ctx } = makeCtx()
    await adapter.start(ctx)
    await session.waitForListeners()

    session.push({ op: 10, d: { heartbeat_interval: 100000 } })
    await new Promise((r) => setTimeout(r, 20))

    session.push({
      op: 0,
      t: "INTERACTION_CREATE",
      s: 2,
      d: {
        type: 3,
        id: "int-slow",
        token: "tok-slow",
        channel_id: "c1",
        member: { user: { id: "u1", username: "U" } },
        data: { custom_id: "a2ui:s:c:click", component_type: 2 },
      },
    })
    // Deadline is 1500ms — wait past it for the fallback ACK + dispatch.
    await new Promise((r) => setTimeout(r, 1800))
    await adapter.stop()

    const ackReq = mockInvoke.mock.calls
      .filter(([cmd]: [string]) => cmd === "connectors_http_request")
      .map(([, a]: [string, unknown]) => (a as { req: { url: string; body?: string } }).req)
      .find((r) => r.url.includes("/interactions/int-slow/tok-slow/callback"))
    expect(ackReq).toBeDefined()
    expect(JSON.parse(ackReq!.body!)).toEqual({ type: 6 })
    expect(busDispatch).toHaveBeenCalledTimes(1)
  }, 10000)
})
