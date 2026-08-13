import { invoke } from "@tauri-apps/api/core"
import { gateInboundEvent } from "@/lib/connectors/at-gate"
import { createMatrixAdapter } from "./index"
import type { AdapterContext, NormalizedInboundEvent } from "@/types/connectors"
import type { OutboundRequest } from "@/types/connectors/outbound"
import type { MatrixTimelineEvent } from "./parse"

const mockE2EEInitialize = jest.fn(async () => undefined)
const mockE2EEClose = jest.fn(async () => undefined)
const mockE2EEReceiveSync = jest.fn(async () => undefined)
const mockE2EEPrepareRoomEvent = jest.fn(
  async (_roomId: string, eventType: string, content: unknown) => ({ eventType, content })
)
const mockE2EEDecryptOrQueue = jest.fn(async (_roomId: string, event: MatrixTimelineEvent) => event)
const mockE2EEIsRoomEncrypted = jest.fn(async () => false)

jest.mock("./e2ee", () => ({
  MatrixE2EERuntime: jest.fn().mockImplementation(() => ({
    initialize: mockE2EEInitialize,
    close: mockE2EEClose,
    receiveSync: mockE2EEReceiveSync,
    prepareRoomEvent: mockE2EEPrepareRoomEvent,
    decryptOrQueue: mockE2EEDecryptOrQueue,
    isRoomEncrypted: mockE2EEIsRoomEncrypted,
    canAdvanceCursor: () => true,
  })),
}))

// Deterministic gate: defaults to pass-through (the no-gate-configured
// behavior); individual tests flip it to assert gate-first ordering.
jest.mock("@/lib/connectors/at-gate", () => ({
  gateInboundEvent: jest.fn(async () => true),
}))

// The adapter reads/writes the persisted sync cursor through the Dexie CRUD
// layer — mock it so node-env tests need no IndexedDB and can assert writes.
jest.mock("@/lib/db/adapter-instances", () => ({
  getAdapterInstance: jest.fn(async () => undefined),
  updateAdapterInstance: jest.fn(async () => undefined),
}))

import { getAdapterInstance, updateAdapterInstance } from "@/lib/db/adapter-instances"

const mockInvoke = invoke as jest.Mock
const mockGate = gateInboundEvent as jest.Mock
const mockGetInstance = getAdapterInstance as jest.Mock
const mockUpdateInstance = updateAdapterInstance as jest.Mock

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

function adapter(selfId = "@bot:matrix.org", deviceId = "DEVICE") {
  return createMatrixAdapter({
    id: "mx-1",
    displayName: "Matrix Bot",
    homeserver: "https://matrix.org",
    accessToken: async () => "tok",
    selfId,
    deviceId,
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
    mockGetInstance.mockReset()
    mockGetInstance.mockResolvedValue(undefined)
    mockUpdateInstance.mockReset()
    mockUpdateInstance.mockResolvedValue(undefined)
    mockE2EEInitialize.mockClear()
    mockE2EEClose.mockClear()
    mockE2EEReceiveSync.mockClear()
    mockE2EEPrepareRoomEvent.mockReset()
    mockE2EEPrepareRoomEvent.mockImplementation(async (_roomId, eventType, content) => ({
      eventType,
      content,
    }))
    mockE2EEDecryptOrQueue.mockReset()
    mockE2EEDecryptOrQueue.mockImplementation(async (_roomId, event) => event)
    mockE2EEIsRoomEncrypted.mockReset()
    mockE2EEIsRoomEncrypted.mockResolvedValue(false)
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
      await new Promise(() => undefined)
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
      await new Promise(() => undefined)
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
      await new Promise(() => undefined)
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

  it("send() PUTs an m.room.message and returns the roomId|eventId composite", async () => {
    mockInvoke.mockResolvedValue(httpResp(200, { event_id: "$sent" }))
    const res = await adapter().send(sendReq([{ type: "text", text: "hello" }]))
    expect(res.ok).toBe(true)
    // Composite id round-trips into delete()/addReaction()/edit().
    expect(res.platformMessageId).toBe("!r:matrix.org|$sent")
    const req = mockInvoke.mock.calls[0][1].req
    expect(req.method).toBe("PUT")
    expect(req.url).toContain(
      "/rooms/" + encodeURIComponent("!r:matrix.org") + "/send/m.room.message/"
    )
    expect(req.url).toContain(encodeURIComponent("idem-1:0"))
  })

  it("send() uploads image segments and sends native m.image events", async () => {
    mockInvoke.mockImplementation(async (cmd: string, _args: Record<string, unknown>) => {
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
      msgtype: "m.notice",
      body: "[image] https://example.com/pic.png",
      format: "org.matrix.custom.html",
      formatted_body: '<a href="https://example.com/pic.png">[image]</a>',
    })
  })

  it("send() does NOT leak non-http source urls when the upload fails", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "connectors_media_upload") throw new Error("media repo down")
      if (cmd === "connectors_http_request") return httpResp(200, { event_id: "$fail" })
      throw new Error(`unexpected command ${cmd}`)
    })

    const res = await adapter().send(
      sendReq([
        {
          type: "file",
          url: "asset://localhost/Users/me/secret.pdf",
          name: "secret.pdf",
          mimeType: "application/pdf",
          sizeBytes: 1,
        },
      ])
    )

    expect(res.ok).toBe(true)
    const sendCall = mockInvoke.mock.calls.find(
      ([cmd, args]) =>
        cmd === "connectors_http_request" &&
        String((args as { req: { url: string } }).req.url).includes("/send/m.room.message/")
    )!
    const body = JSON.parse((sendCall[1] as { req: { body: string } }).req.body)
    expect(body).toEqual({
      msgtype: "m.notice",
      body: "[attachment upload failed: secret.pdf]",
    })
    expect(JSON.stringify(body)).not.toContain("asset://")
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

  it("encrypts messages, edits, reactions, and encrypted media through one send boundary", async () => {
    mockE2EEPrepareRoomEvent.mockImplementation(async (_roomId, _eventType, content) => ({
      eventType: "m.room.encrypted",
      content: { ciphertext: JSON.stringify(content) },
    }))
    mockE2EEIsRoomEncrypted.mockResolvedValue(true)
    const encryptedFile = {
      url: "mxc://matrix.org/encrypted",
      key: { kty: "oct" },
      iv: "iv",
      hashes: { sha256: "digest" },
      v: "v2",
    }
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "connectors_matrix_encrypted_media_upload") {
        return { contentUri: encryptedFile.url, file: encryptedFile }
      }
      if (cmd === "connectors_http_request") return httpResp(200, { event_id: "$sent" })
      throw new Error(`unexpected command ${cmd}`)
    })
    const a = adapter()

    await a.send(sendReq([{ type: "text", text: "message" }]))
    await a.edit!("$orig", sendReq([{ type: "text", text: "edit" }]))
    await a.addReaction!("!r:matrix.org|$orig", "👍")
    await a.send(sendReq([{ type: "image", url: "https://example.com/a.png", alt: "encrypted" }]))

    expect(mockE2EEPrepareRoomEvent.mock.calls.map(([, eventType]) => eventType)).toEqual([
      "m.room.message",
      "m.room.message",
      "m.reaction",
      "m.room.message",
    ])
    expect(mockInvoke).toHaveBeenCalledWith(
      "connectors_matrix_encrypted_media_upload",
      expect.objectContaining({
        req: expect.objectContaining({ contentType: "application/octet-stream" }),
      })
    )
    const sends = mockInvoke.mock.calls.filter(
      ([cmd, args]) =>
        cmd === "connectors_http_request" &&
        String((args as { req: { url: string } }).req.url).includes("/send/")
    )
    expect(sends).toHaveLength(4)
    for (const [, args] of sends) {
      expect((args as { req: { url: string } }).req.url).toContain("/send/m.room.encrypted/")
    }
    expect(mockE2EEPrepareRoomEvent.mock.calls[3][2]).toMatchObject({ file: encryptedFile })
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

  it("edit() PUTs an m.replace content with a stable idempotency-derived txn", async () => {
    mockInvoke.mockResolvedValue(httpResp(200, { event_id: "$edit" }))
    const res = await adapter().edit!("$orig", sendReq([{ type: "text", text: "fixed" }]))
    expect(res.ok).toBe(true)
    expect(res.platformMessageId).toBe("!r:matrix.org|$edit")
    const req = mockInvoke.mock.calls[0][1].req
    // Retries must dedup server-side: txn derives from the idempotency key.
    expect(req.url).toContain(encodeURIComponent("idem-1:edit"))
    const body = JSON.parse(req.body)
    expect(body["m.relates_to"]).toEqual({ rel_type: "m.replace", event_id: "$orig" })
  })

  it("edit() accepts the roomId|eventId composite and targets its room", async () => {
    mockInvoke.mockResolvedValue(httpResp(200, { event_id: "$edit2" }))
    const res = await adapter().edit!(
      "!other:matrix.org|$orig",
      sendReq([{ type: "text", text: "fixed" }])
    )
    expect(res.ok).toBe(true)
    const req = mockInvoke.mock.calls[0][1].req
    expect(req.url).toContain("/rooms/" + encodeURIComponent("!other:matrix.org") + "/send/")
    const body = JSON.parse(req.body)
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

  it("setTyping() targets the FULL room id (room ids contain colons)", async () => {
    mockInvoke.mockResolvedValue(httpResp(200, {}))
    await adapter().setTyping!("matrix:mx-1:!r:matrix.org", true)
    const req = mockInvoke.mock.calls[0][1].req
    expect(req.url).toContain(
      "/rooms/" +
        encodeURIComponent("!r:matrix.org") +
        "/typing/" +
        encodeURIComponent("@bot:matrix.org")
    )
    expect(JSON.parse(req.body)).toEqual({ typing: true, timeout: 30000 })
  })

  it("setTyping() strips a thread suffix from the conversation key", async () => {
    mockInvoke.mockResolvedValue(httpResp(200, {}))
    await adapter().setTyping!("matrix:mx-1:!r:matrix.org:$threadRoot", true)
    const req = mockInvoke.mock.calls[0][1].req
    expect(req.url).toContain("/rooms/" + encodeURIComponent("!r:matrix.org") + "/typing/")
  })

  it("addReaction() follows the 2-arg bus contract and returns a ReactionRef", async () => {
    mockInvoke.mockResolvedValue(httpResp(200, { event_id: "$reaction" }))
    const ref = await adapter().addReaction!("!r:matrix.org|$target", "👍")
    expect(ref).toEqual({ reactionId: "$reaction" })
    const req = mockInvoke.mock.calls[0][1].req
    expect(req.method).toBe("PUT")
    expect(req.url).toContain("/rooms/" + encodeURIComponent("!r:matrix.org") + "/send/m.reaction/")
    expect(JSON.parse(req.body)).toEqual({
      "m.relates_to": { rel_type: "m.annotation", event_id: "$target", key: "👍" },
    })
  })

  it("addReaction() rejects a bare (non-composite) message id", async () => {
    await expect(adapter().addReaction!("$bare", "👍")).rejects.toThrow("roomId")
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it("removeReaction() redacts the reaction event id", async () => {
    mockInvoke.mockResolvedValue(httpResp(200, { event_id: "$redaction" }))
    await adapter().removeReaction!("!r:matrix.org|$target", "$reaction")
    const req = mockInvoke.mock.calls[0][1].req
    expect(req.method).toBe("PUT")
    expect(req.url).toContain(
      "/rooms/" +
        encodeURIComponent("!r:matrix.org") +
        "/redact/" +
        encodeURIComponent("$reaction") +
        "/"
    )
  })

  it("removeReaction() throws without a reactionId", async () => {
    await expect(adapter().removeReaction!("!r:matrix.org|$target", "")).rejects.toThrow(
      "reactionId"
    )
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it("decrypts encrypted timeline events before parsing and emitting", async () => {
    let n = 0
    mockE2EEDecryptOrQueue.mockImplementation(async (_roomId, event) => ({
      ...event,
      type: "m.room.message",
      content: { msgtype: "m.text", body: `decrypted ${event.event_id}` },
    }))
    mockInvoke.mockImplementation(async () => {
      n += 1
      const encrypted = (id: string): MatrixTimelineEvent => ({
        type: "m.room.encrypted",
        event_id: id,
        sender: "@alice:matrix.org",
        origin_server_ts: 1,
        content: {},
      })
      if (n === 1) return syncResp("s1", {})
      if (n === 2)
        return syncResp("s2", {
          "!enc:matrix.org": { timeline: { events: [encrypted("$e1"), encrypted("$e2")] } },
        })
      if (n === 3)
        return syncResp("s3", {
          "!enc:matrix.org": { timeline: { events: [encrypted("$e3")] } },
        })
      await new Promise(() => undefined)
      return syncResp("s4", {})
    })

    const a = adapter()
    const { ctx, emitted } = makeCtx()
    await a.start(ctx)
    await until(() => n >= 4)
    await until(() => emitted.length === 3)
    expect(emitted.map((event) => event.plainText)).toEqual([
      "decrypted $e1",
      "decrypted $e2",
      "decrypted $e3",
    ])
    await a.stop()
  })

  it("fails closed without detailed whoami identity and never starts sync", async () => {
    const a = adapter("")
    const { ctx } = makeCtx()
    await a.start(ctx)
    expect(a.health()).toMatchObject({ state: "degraded", reason: "missing_device_identity" })
    expect(mockInvoke).not.toHaveBeenCalled()
    await a.stop()
  })

  it("fails closed when detailed whoami omits the device identity", async () => {
    const a = adapter("@bot:matrix.org", "")
    const { ctx } = makeCtx()
    await a.start(ctx)
    expect(a.health()).toMatchObject({ state: "degraded", reason: "missing_device_identity" })
    expect(mockE2EEInitialize).not.toHaveBeenCalled()
    await a.stop()
  })

  it("flips health to degraded/auth_failed when the sync token is rejected", async () => {
    mockInvoke.mockResolvedValue(
      httpResp(401, { errcode: "M_UNKNOWN_TOKEN", error: "Invalid access token" })
    )
    const a = adapter()
    const { ctx } = makeCtx()
    await a.start(ctx)
    await until(() => a.health().state === "degraded")
    expect(a.health()).toMatchObject({ state: "degraded", reason: "auth_failed" })
    await a.stop()
  })

  it("seeds /sync from the persisted cursor and persists new next_batch tokens", async () => {
    mockGetInstance.mockResolvedValue({
      id: "mx-1",
      settings: { homeserver: "https://matrix.org", syncSinceToken: "persisted-1" },
    })
    let n = 0
    mockInvoke.mockImplementation(async () => {
      n += 1
      if (n === 1)
        return syncResp("fresh-2", {
          "!r:matrix.org": {
            timeline: {
              events: [
                {
                  type: "m.room.message",
                  event_id: "$downtime",
                  sender: "@alice:matrix.org",
                  origin_server_ts: 1,
                  content: { msgtype: "m.text", body: "while you were away" },
                },
              ],
            },
          },
        })
      await new Promise(() => undefined)
      return syncResp("fresh-3", {})
    })

    const a = adapter()
    const { ctx, emitted } = makeCtx()
    await a.start(ctx)
    await until(() => emitted.length > 0)

    // Resumed from the persisted token — the first batch is downtime
    // catch-up traffic and is DELIVERED, not discarded.
    const firstReq = mockInvoke.mock.calls[0][1].req
    expect(firstReq.url).toContain("since=persisted-1")
    expect(emitted[0].plainText).toBe("while you were away")

    // The fresh next_batch is persisted with the settings MERGED.
    await until(() => mockUpdateInstance.mock.calls.length > 0)
    expect(mockUpdateInstance).toHaveBeenCalledWith("mx-1", {
      settings: { homeserver: "https://matrix.org", syncSinceToken: "fresh-2" },
    })
    await a.stop()
  })

  it("stop() flushes the pending sync cursor", async () => {
    let n = 0
    mockInvoke.mockImplementation(async () => {
      n += 1
      if (n <= 2) return syncResp(`tok-${n}`, {})
      await new Promise(() => undefined)
      return syncResp("tok-x", {})
    })
    const a = adapter()
    const { ctx } = makeCtx()
    await a.start(ctx)
    await until(() => n >= 2)
    await a.stop()
    // First token persisted immediately; the remainder flushed by stop().
    const persistedTokens = mockUpdateInstance.mock.calls.map(
      ([, patch]) => (patch as { settings: { syncSinceToken?: string } }).settings.syncSinceToken
    )
    expect(persistedTokens).toContain("tok-1")
    expect(persistedTokens[persistedTokens.length - 1]).toBe("tok-2")
  })

  it("awaits shutdown and fences a late in-flight sync response", async () => {
    let resolveLate: ((value: ReturnType<typeof syncResp>) => void) | undefined
    const late = new Promise<ReturnType<typeof syncResp>>((resolve) => {
      resolveLate = resolve
    })
    let calls = 0
    mockInvoke.mockImplementation(async () => {
      calls += 1
      if (calls === 1) return syncResp("s1", {})
      return late
    })
    const a = adapter()
    const { ctx, emitted } = makeCtx()
    await a.start(ctx)
    await until(() => calls === 2)

    await a.stop()
    resolveLate?.(
      syncResp("s2", {
        "!r:matrix.org": { timeline: { events: [textEventForLateSync()] } },
      })
    )
    await Promise.resolve()

    expect(emitted).toHaveLength(0)
    expect(a.health().state).toBe("down")
  })
})

function textEventForLateSync(): MatrixTimelineEvent {
  return {
    type: "m.room.message",
    event_id: "$late",
    sender: "@alice:matrix.org",
    origin_server_ts: 1,
    content: { msgtype: "m.text", body: "must not emit" },
  }
}
