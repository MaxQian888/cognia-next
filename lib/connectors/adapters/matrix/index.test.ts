import { invoke } from "@tauri-apps/api/core"
import { createMatrixAdapter } from "./index"
import type { AdapterContext, NormalizedInboundEvent } from "@/types/connectors"
import type { OutboundRequest } from "@/types/connectors/outbound"
import type { MatrixTimelineEvent } from "./parse"

const mockInvoke = invoke as jest.Mock

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
  beforeEach(() => mockInvoke.mockReset())

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
