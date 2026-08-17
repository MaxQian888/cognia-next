// Adapter contract suite for Matrix — mirrors `telegram/contract.test.ts`.
//
// One `describe` per declared Capability: build adapter → mock the Tauri
// HTTP wrapper → call the adapter method → assert the outbound request shape
// (URL + body) matches the Matrix Client-Server API. Plus one "intentionally
// absent" case per mutation method the adapter does NOT declare, so a future
// stub cannot silently pretend to support it.

import { invoke } from "@tauri-apps/api/core"
import type { OutboundRequest } from "@/types/connectors/outbound"
import { createMatrixAdapter } from "./index"

// The adapter constructs its E2EE runtime eagerly; a passthrough stub lets
// send()/edit()/reactions reach the HTTP layer without a Rust crypto store.
jest.mock("./e2ee", () => ({
  MatrixE2EERuntime: jest.fn().mockImplementation(() => ({
    initialize: jest.fn(async () => undefined),
    close: jest.fn(async () => undefined),
    receiveSync: jest.fn(async () => undefined),
    prepareRoomEvent: jest.fn(async (_roomId: string, eventType: string, content: unknown) => ({
      eventType,
      content,
    })),
    decryptOrQueue: jest.fn(async (_roomId: string, event: unknown) => event),
    isRoomEncrypted: jest.fn(async () => false),
    canAdvanceCursor: () => true,
  })),
}))

const mockInvoke = invoke as jest.Mock
const ROOM = "!room:example.org"
const ROOM_ENC = encodeURIComponent(ROOM)

function okResp(body: unknown = { event_id: "$sent" }) {
  return { status: 200, headers: {}, body: JSON.stringify(body) }
}

function makeAdapter() {
  return createMatrixAdapter({
    id: "mx-contract",
    displayName: "Contract Matrix",
    homeserver: "https://matrix.example.org",
    accessToken: async () => "TOKEN",
    selfId: "@bot:example.org",
    deviceId: "DEVICE",
  })
}

function req(
  segments: OutboundRequest["segments"],
  extra: Partial<OutboundRequest> = {}
): OutboundRequest {
  return {
    conversationRef: { platform: "matrix", adapterId: "mx-contract", roomId: ROOM },
    segments,
    metadata: { idempotencyKey: "k-contract" },
    ...extra,
  }
}

function httpCalls(): Array<{ url: string; method: string; body: Record<string, unknown> }> {
  return mockInvoke.mock.calls
    .filter(([cmd]: [string]) => cmd === "connectors_http_request")
    .map((c) => {
      const r = (c[1] as { req: { url: string; method: string; body?: string } }).req
      return {
        url: r.url,
        method: r.method,
        body: r.body ? (JSON.parse(r.body) as Record<string, unknown>) : {},
      }
    })
}

function lastHttpCall() {
  const calls = httpCalls()
  expect(calls.length).toBeGreaterThan(0)
  return calls[calls.length - 1]
}

describe("Matrix adapter contract suite", () => {
  beforeEach(() => {
    mockInvoke.mockReset()
    mockInvoke.mockResolvedValue(okResp())
  })

  describe("send.text capability", () => {
    it("plain text becomes PUT /rooms/{room}/send/m.room.message/{txnId} with an m.notice body", async () => {
      const result = await makeAdapter().send(req([{ type: "text", text: "hello" }]))
      expect(result.ok).toBe(true)
      expect(result.platformMessageId).toBe(`${ROOM}|$sent`)
      const call = lastHttpCall()
      expect(call.method).toBe("PUT")
      expect(call.url).toContain(`/rooms/${ROOM_ENC}/send/m.room.message/`)
      // txnId = idempotency key + chunk index → remote_idempotent contract.
      expect(call.url).toContain(encodeURIComponent("k-contract:0"))
      expect(call.body).toMatchObject({ msgtype: "m.notice", body: "hello" })
      expect(call.body.formatted_body).toBeUndefined()
    })
  })

  describe("send.markdown capability", () => {
    it("markdown renders as org.matrix.custom.html formatted_body", async () => {
      await makeAdapter().send(req([{ type: "markdown", md: "**bold** text" }]))
      const call = lastHttpCall()
      expect(call.body.format).toBe("org.matrix.custom.html")
      expect(String(call.body.formatted_body)).toContain("<strong>bold</strong>")
      expect(String(call.body.body)).toContain("bold")
    })
  })

  describe("send.mention capability", () => {
    it("mention segments populate m.mentions.user_ids", async () => {
      await makeAdapter().send(
        req([
          { type: "mention", userId: "@alice:example.org", displayName: "Alice" },
          { type: "text", text: " ping" },
        ])
      )
      const call = lastHttpCall()
      expect(call.body["m.mentions"]).toEqual({ user_ids: ["@alice:example.org"] })
    })
  })

  describe("send.reply capability", () => {
    it("OutboundRequest.replyTo becomes m.relates_to.m.in_reply_to (bare event id)", async () => {
      await makeAdapter().send(
        req([{ type: "text", text: "re" }], { replyTo: { messageId: `${ROOM}|$orig` } })
      )
      const call = lastHttpCall()
      expect(call.body["m.relates_to"]).toEqual({ "m.in_reply_to": { event_id: "$orig" } })
    })
  })

  describe("send.thread capability", () => {
    it("OutboundRequest.threadId becomes an m.thread relation with the falling-back reply", async () => {
      await makeAdapter().send(req([{ type: "text", text: "in thread" }], { threadId: "$root" }))
      const call = lastHttpCall()
      expect(call.body["m.relates_to"]).toEqual({
        rel_type: "m.thread",
        event_id: "$root",
        is_falling_back: true,
        "m.in_reply_to": { event_id: "$root" },
      })
    })
  })

  describe("send.image / send.file / send.voice / send.video capabilities", () => {
    it.each([
      ["image", { type: "image" as const, url: "https://cdn/x.png" }, "m.image"],
      ["file", { type: "file" as const, url: "https://cdn/x.pdf", name: "x.pdf" }, "m.file"],
      ["voice", { type: "voice" as const, url: "https://cdn/x.ogg" }, "m.audio"],
      ["video", { type: "video" as const, url: "https://cdn/x.mp4" }, "m.video"],
    ])(
      "%s segment uploads to the media repo and sends the native room event",
      async (_n, seg, msgtype) => {
        mockInvoke.mockImplementation(async (cmd: string) => {
          if (cmd === "connectors_media_upload") return "mxc://example.org/uploaded"
          return okResp({ event_id: "$media" })
        })
        const result = await makeAdapter().send(req([seg as OutboundRequest["segments"][number]]))
        expect(result.ok).toBe(true)
        const upload = mockInvoke.mock.calls.find(
          ([cmd]: [string]) => cmd === "connectors_media_upload"
        )
        expect(upload).toBeDefined()
        const call = lastHttpCall()
        expect(call.url).toContain(`/rooms/${ROOM_ENC}/send/m.room.message/`)
        expect(call.body).toMatchObject({ msgtype, url: "mxc://example.org/uploaded" })
      }
    )
  })

  describe("send.a2ui capability", () => {
    it("a2ui surfaces render as HTML formatted_body with the plain-text mirror as body", async () => {
      await makeAdapter().send(
        req([
          {
            type: "a2ui",
            surfaceId: "s1",
            content: {
              root: "r",
              components: [{ id: "r", type: "Text", props: { text: "Hello surface" } }],
            } as never,
            plainTextMirror: "Hello surface",
          },
        ])
      )
      const call = lastHttpCall()
      expect(call.body.body).toBe("Hello surface")
      expect(call.body.format).toBe("org.matrix.custom.html")
      expect(String(call.body.formatted_body)).toContain("Hello surface")
    })
  })

  describe("edit capability", () => {
    it("edit() PUTs an m.replace relation with a stable idempotency-derived txn", async () => {
      mockInvoke.mockResolvedValue(okResp({ event_id: "$edit" }))
      const result = await makeAdapter().edit!(
        `${ROOM}|$orig`,
        req([{ type: "text", text: "fixed" }])
      )
      expect(result.ok).toBe(true)
      const call = lastHttpCall()
      expect(call.method).toBe("PUT")
      expect(call.url).toContain(`/rooms/${ROOM_ENC}/send/m.room.message/`)
      expect(call.url).toContain(encodeURIComponent("k-contract:edit"))
      expect(call.body["m.relates_to"]).toEqual({ rel_type: "m.replace", event_id: "$orig" })
      expect(call.body["m.new_content"]).toMatchObject({ body: "fixed" })
    })
  })

  describe("delete capability", () => {
    it("delete() redacts the event from the roomId|eventId composite", async () => {
      await makeAdapter().delete!(`${ROOM}|$gone`)
      const call = lastHttpCall()
      expect(call.method).toBe("PUT")
      expect(call.url).toContain(`/rooms/${ROOM_ENC}/redact/${encodeURIComponent("$gone")}/`)
    })

    it("delete() rejects a bare event id instead of guessing the room", async () => {
      await expect(makeAdapter().delete!("$bare")).rejects.toThrow(/roomId/)
      expect(httpCalls()).toHaveLength(0)
    })
  })

  describe("send.reaction capability", () => {
    it("addReaction() sends an m.reaction annotation and returns the reaction event id", async () => {
      mockInvoke.mockResolvedValue(okResp({ event_id: "$reaction" }))
      const ref = await makeAdapter().addReaction!(`${ROOM}|$target`, "👍")
      expect(ref).toEqual({ reactionId: "$reaction" })
      const call = lastHttpCall()
      expect(call.method).toBe("PUT")
      expect(call.url).toContain(`/rooms/${ROOM_ENC}/send/m.reaction/`)
      expect(call.body).toEqual({
        "m.relates_to": { rel_type: "m.annotation", event_id: "$target", key: "👍" },
      })
    })

    it("removeReaction() redacts the reaction event", async () => {
      await makeAdapter().removeReaction!(`${ROOM}|$target`, "$reaction")
      const call = lastHttpCall()
      expect(call.url).toContain(`/rooms/${ROOM_ENC}/redact/${encodeURIComponent("$reaction")}/`)
    })
  })

  describe("typing capability", () => {
    it("setTyping(on) PUTs /rooms/{room}/typing/{self} with a timeout, off clears it", async () => {
      const adapter = makeAdapter()
      await adapter.setTyping!(`matrix:mx-contract:${ROOM}`, true)
      let call = lastHttpCall()
      expect(call.method).toBe("PUT")
      expect(call.url).toContain(
        `/rooms/${ROOM_ENC}/typing/${encodeURIComponent("@bot:example.org")}`
      )
      expect(call.body).toEqual({ typing: true, timeout: 30000 })
      await adapter.setTyping!(`matrix:mx-contract:${ROOM}`, false)
      call = lastHttpCall()
      expect(call.body).toMatchObject({ typing: false })
    })
  })

  describe("history.fetch capability (intentionally absent)", () => {
    it("is NOT declared and neither fetchHistory nor fetchHistoryPage is implemented", () => {
      const adapter = makeAdapter()
      expect(adapter.meta.capabilities).not.toContain("history.fetch")
      expect(adapter.fetchHistory).toBeUndefined()
      expect(adapter.fetchHistoryPage).toBeUndefined()
    })
  })

  describe("forward / urgent / upload (intentionally absent)", () => {
    it("declares none of them and implements no method for them", () => {
      const adapter = makeAdapter()
      for (const cap of ["forward", "urgent", "upload"] as const) {
        expect(adapter.meta.capabilities).not.toContain(cap)
      }
      expect(adapter.forwardMessage).toBeUndefined()
      expect(adapter.sendUrgent).toBeUndefined()
      expect(adapter.uploadFile).toBeUndefined()
      expect(adapter.streamReply).toBeUndefined()
    })
  })
})
