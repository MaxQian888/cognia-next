import { invoke } from "@tauri-apps/api/core"
import { gateInboundEvent } from "@/lib/connectors/at-gate"
import { createMatrixAdapter } from "./index"
import type { AdapterContext, NormalizedInboundEvent } from "@/types/connectors"
import type { OutboundRequest } from "@/types/connectors/outbound"
import type { MatrixTimelineEvent } from "./parse"

// Deterministic gate: defaults to pass-through (the no-gate-configured
// behavior); individual tests flip it to assert gate-first ordering.
jest.mock("@/lib/connectors/at-gate", () => ({
  gateInboundEvent: jest.fn(async () => true),
}))

const mockInvoke = invoke as jest.Mock
const mockGate = gateInboundEvent as jest.Mock

function httpResp(status: number, body: unknown) {
  return { status, headers: {}, body: typeof body === "string" ? body : JSON.stringify(body) }
}

function syncResp(
  nextBatch: string,
  joinRooms: Record<string, { timeline?: { events?: MatrixTimelineEvent[] } }>
) {
  return httpResp(200, { next_batch: nextBatch, rooms: { join: joinRooms } })
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
    adapterId: "mx-test",
  }
  return { ctx, emitted }
}

function adapter() {
  return createMatrixAdapter({
    id: "mx-1",
    displayName: "Matrix Bot",
    homeserver: "https://matrix.org",
    accessToken: async () => "tok",
    selfId: "@bot:matrix.org",
  })
}

function sendReq(
  segments: OutboundRequest["segments"],
  extra: Partial<OutboundRequest> = {}
): OutboundRequest {
  return {
    conversationRef: { platform: "matrix", adapterId: "mx-1", roomId: "!r:matrix.org" },
    segments,
    metadata: { idempotencyKey: "idem-1" },
    ...extra,
  }
}

const until = async (pred: () => boolean, timeoutMs = 2000) => {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("until: timeout")
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe("createMatrixAdapter", () => {
  beforeEach(() => {
    mockInvoke.mockReset()
    mockGate.mockReset()
    mockGate.mockResolvedValue(true)
  })

  it("exposes correct meta and initial health", () => {
    const a = adapter()
    expect(a.id).toBe("mx-1")
    expect(a.meta.type).toBe("matrix")
    expect(a.meta.transportModes).toContain("longpoll")
    expect(a.meta.capabilities).toContain("send.markdown")
    expect(a.health().state).toBe("starting")
  })

  it("start() drives /sync and emits parsed events", async () => {
    let n = 0
    mockInvoke.mockImplementation(async () => {
      n += 1
      if (n === 1) return syncResp("s1", {})
      if (n === 2)
        return syncResp("s2", {
          "!r:matrix.org": {
            timeline: {
              events: [
                {
                  type: "m.room.message",
                  event_id: "$e1",
                  sender: "@alice:matrix.org",
                  origin_server_ts: 1,
                  content: { msgtype: "m.text", body: "hi bot" },
                },
              ],
            },
          },
        })
      await new Promise((r) => setTimeout(r, 50000))
      return syncResp("s3", {})
    })

    const a = adapter()
    const { ctx, emitted } = makeCtx()
    await a.start(ctx)
    await until(() => emitted.length > 0)
    expect(emitted[0].plainText).toBe("hi bot")
    expect(a.health().state).toBe("running")
    await a.stop()
    expect(a.health().state).toBe("down")
  })

  it("start() resolves Matrix mxc media URLs before emitting events", async () => {
    let syncCalls = 0
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "connectors_attachment_fetch") {
        return { localUrl: "missing-test-cache-path", remoteRef: "mxc://matrix.org/abc/def" }
      }

      syncCalls += 1
      if (syncCalls === 1) return syncResp("s1", {})
      if (syncCalls === 2)
        return syncResp("s2", {
          "!r:matrix.org": {
            timeline: {
              events: [
                {
                  type: "m.room.message",
                  event_id: "$img",
                  sender: "@alice:matrix.org",
                  origin_server_ts: 1,
                  content: {
                    msgtype: "m.image",
                    body: "pic.png",
                    url: "mxc://matrix.org/abc/def",
                    info: { mimetype: "image/png" },
                  },
                },
              ],
            },
          },
        })
      await new Promise((r) => setTimeout(r, 50000))
      return syncResp("s3", {})
    })

    const a = adapter()
    const { ctx, emitted } = makeCtx()
    await a.start(ctx)
    await until(() => emitted.length > 0)
    expect(emitted[0].segments[0]).toMatchObject({
      type: "image",
      url: "https://matrix.org/_matrix/client/v1/media/download/matrix.org/abc%2Fdef",
      rawUrl: "mxc://matrix.org/abc/def",
      mimeType: "image/png",
    })
    await a.stop()
  })

  it("start() gates events BEFORE fetching their media (no bystander downloads)", async () => {
    mockGate.mockResolvedValue(false) // e.g. mention-gate drops the event
    let syncCalls = 0
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "connectors_attachment_fetch") {
        throw new Error("media must not be fetched for a gated-out event")
      }
      syncCalls += 1
      if (syncCalls === 1) return syncResp("s1", {})
      if (syncCalls === 2)
        return syncResp("s2", {
          "!r:matrix.org": {
            timeline: {
              events: [
                {
                  type: "m.room.message",
                  event_id: "$img",
                  sender: "@alice:matrix.org",
                  origin_server_ts: 1,
                  content: {
                    msgtype: "m.image",
                    body: "pic.png",
                    url: "mxc://matrix.org/abc/def",
                    info: { mimetype: "image/png" },
                  },
                },
              ],
            },
          },
        })
      await new Promise((r) => setTimeout(r, 50000))
      return syncResp("s3", {})
    })

    const a = adapter()
    const { ctx, emitted } = makeCtx()
    await a.start(ctx)
    await until(() => mockGate.mock.calls.length > 0)
    // Give the pipeline a beat: the gate rejected the event, so neither an
    // attachment fetch nor an emit may follow.
    await new Promise((r) => setTimeout(r, 25))
    expect(emitted).toHaveLength(0)
    expect(
      mockInvoke.mock.calls.filter(([cmd]) => cmd === "connectors_attachment_fetch")
    ).toHaveLength(0)
    await a.stop()
  })

  it("send() PUTs an m.room.message and returns the event id", async () => {
    mockInvoke.mockResolvedValue(httpResp(200, { event_id: "$sent" }))
    const res = await adapter().send(sendReq([{ type: "text", text: "hello" }]))
    expect(res.ok).toBe(true)
    expect(res.platformMessageId).toBe("$sent")
    const req = mockInvoke.mock.calls[0][1].req
    expect(req.method).toBe("PUT")
    expect(req.url).toContain(
      "/rooms/" + encodeURIComponent("!r:matrix.org") + "/send/m.room.message/"
    )
    expect(req.url).toContain(encodeURIComponent("idem-1:0"))
  })

  it("send() uploads image segments and sends native m.image events", async () => {
    mockInvoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "connectors_media_upload") return "mxc://matrix.org/uploaded"
      if (cmd === "connectors_http_request") return httpResp(200, { event_id: "$img" })
      throw new Error(`unexpected command ${cmd}`)
    })

    const res = await adapter().send(
      sendReq([
        {
          type: "image",
          url: "https://example.com/pic.png",
          alt: "pic",
          width: 640,
          height: 480,
          mimeType: "image/png",
        },
      ])
    )

    expect(res.ok).toBe(true)
    expect(mockInvoke).toHaveBeenCalledWith("connectors_media_upload", {
      req: {
        uploadUrl: "https://matrix.org/_matrix/media/v3/upload?filename=pic",
        headers: { Authorization: "Bearer tok", "Content-Type": "image/png" },
        sourceUrl: "https://example.com/pic.png",
        contentType: "image/png",
      },
    })
    expect(mockInvoke).toHaveBeenCalledWith(
      "connectors_http_request",
      expect.objectContaining({
        req: expect.objectContaining({
          method: "PUT",
          url: expect.stringContaining("/send/m.room.message/"),
          body: JSON.stringify({
            msgtype: "m.image",
            body: "pic",
            url: "mxc://matrix.org/uploaded",
            info: { mimetype: "image/png", w: 640, h: 480 },
          }),
        }),
      })
    )
  })

  it("send() degrades a failed media upload to a link line instead of aborting", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "connectors_media_upload") throw new Error("media repo down")
      if (cmd === "connectors_http_request") return httpResp(200, { event_id: "$link" })
      throw new Error(`unexpected command ${cmd}`)
    })

    const res = await adapter().send(
      sendReq([{ type: "image", url: "https://example.com/pic.png", alt: "pic" }])
    )

    expect(res.ok).toBe(true)
    const sendCall = mockInvoke.mock.calls.find(
      ([cmd, args]) =>
        cmd === "connectors_http_request" &&
        String((args as { req: { url: string } }).req.url).includes("/send/m.room.message/")
    )!
    const body = JSON.parse((sendCall[1] as { req: { body: string } }).req.body)
    expect(body).toEqual({
      msgtype: "m.text",
      body: "[image] https://example.com/pic.png",
      format: "org.matrix.custom.html",
      formatted_body: '<a href="https://example.com/pic.png">[image]</a>',
    })
  })

  it("send() carries the thread relation on the uploaded media event", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "connectors_media_upload") return "mxc://matrix.org/uploaded"
      if (cmd === "connectors_http_request") return httpResp(200, { event_id: "$img" })
      throw new Error(`unexpected command ${cmd}`)
    })

    const res = await adapter().send({
      ...sendReq([{ type: "image", url: "https://example.com/pic.png", alt: "pic" }]),
      threadId: "$root",
    })

    expect(res.ok).toBe(true)
    const sendCall = mockInvoke.mock.calls.find(
      ([cmd, args]) =>
        cmd === "connectors_http_request" &&
        String((args as { req: { url: string } }).req.url).includes("/send/m.room.message/")
    )!
    const body = JSON.parse((sendCall[1] as { req: { body: string } }).req.body)
    expect(body.msgtype).toBe("m.image")
    expect(body["m.relates_to"]).toMatchObject({ rel_type: "m.thread", event_id: "$root" })
  })

  it("send() rejects a request without a roomId", async () => {
    const res = await adapter().send({
      conversationRef: { platform: "matrix", adapterId: "mx-1" },
      segments: [{ type: "text", text: "x" }],
      metadata: { idempotencyKey: "k" },
    })
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe("validation")
  })

  it("send() maps a 429 to rate_limited with retryAfterMs", async () => {
    mockInvoke.mockResolvedValue(
      httpResp(429, { errcode: "M_LIMIT_EXCEEDED", error: "slow down", retry_after_ms: 4200 })
    )
    const res = await adapter().send(sendReq([{ type: "text", text: "hi" }]))
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe("rate_limited")
    expect(res.error?.retryAfterMs).toBe(4200)
  })

  it("send() maps a 401 to a non-retryable auth_failed", async () => {
    mockInvoke.mockResolvedValue(httpResp(401, { errcode: "M_UNKNOWN_TOKEN", error: "bad token" }))
    const res = await adapter().send(sendReq([{ type: "text", text: "hi" }]))
    expect(res.error?.code).toBe("auth_failed")
    expect(res.error?.retryable).toBe(false)
  })

  it("edit() PUTs an m.replace content", async () => {
    mockInvoke.mockResolvedValue(httpResp(200, { event_id: "$edit" }))
    const res = await adapter().edit!("$orig", sendReq([{ type: "text", text: "fixed" }]))
    expect(res.ok).toBe(true)
    const body = JSON.parse(mockInvoke.mock.calls[0][1].req.body)
    expect(body["m.relates_to"]).toEqual({ rel_type: "m.replace", event_id: "$orig" })
  })

  it("delete() redacts when given a roomId|eventId composite", async () => {
    mockInvoke.mockResolvedValue(httpResp(200, { event_id: "$redact" }))
    await adapter().delete!("!r:matrix.org|$gone")
    const req = mockInvoke.mock.calls[0][1].req
    expect(req.url).toContain("/redact/" + encodeURIComponent("$gone") + "/")
  })

  it("delete() throws without the composite separator", async () => {
    await expect(adapter().delete!("$bareEventId")).rejects.toThrow("roomId")
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it("setTyping() PUTs a typing notification scoped to the bot", async () => {
    mockInvoke.mockResolvedValue(httpResp(200, {}))
    await adapter().setTyping!("matrix:mx-1:!r:matrix.org", true)
    const req = mockInvoke.mock.calls[0][1].req
    expect(req.url).toContain("/typing/" + encodeURIComponent("@bot:matrix.org"))
    expect(JSON.parse(req.body)).toEqual({ typing: true, timeout: 30000 })
  })
})
