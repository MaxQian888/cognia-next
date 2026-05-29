jest.mock("@/lib/connectors/adapters/_shared/a2ui-mapper", () => ({
  resolveCallbackBinding: jest.fn(),
}))

import { resolveCallbackBinding } from "@/lib/connectors/adapters/_shared/a2ui-mapper"
import {
  parseMatrixEvent,
  parseMatrixReplyCorrelation,
  stripReplyFallback,
  type MatrixTimelineEvent,
} from "./parse"

const mockResolve = resolveCallbackBinding as jest.Mock
const ADAPTER = "mx-1"
const SELF = "@bot:matrix.org"
const ROOM = "!room:matrix.org"

function msg(
  partial: Partial<MatrixTimelineEvent> & { content: MatrixTimelineEvent["content"] }
): MatrixTimelineEvent {
  return {
    type: "m.room.message",
    event_id: "$evt1",
    sender: "@alice:matrix.org",
    origin_server_ts: 1700000000000,
    ...partial,
  }
}

describe("parseMatrixEvent", () => {
  it("parses a plain text message as a create event", () => {
    const ev = msg({ content: { msgtype: "m.text", body: "hello world" } })
    const out = parseMatrixEvent(ADAPTER, SELF, ROOM, ev)
    expect(out).not.toBeNull()
    expect(out!.kind).toBe("create")
    expect(out!.plainText).toBe("hello world")
    expect(out!.conversationKey).toBe(`matrix:${ADAPTER}:${ROOM}`)
    expect(out!.conversationRef).toMatchObject({
      platform: "matrix",
      roomId: ROOM,
      eventId: "$evt1",
    })
    expect(out!.sender.remoteUserId).toBe("@alice:matrix.org")
    expect(out!.sender.displayName).toBe("alice")
  })

  it("skips events authored by the bot itself", () => {
    const ev = msg({ sender: SELF, content: { msgtype: "m.text", body: "echo" } })
    expect(parseMatrixEvent(ADAPTER, SELF, ROOM, ev)).toBeNull()
  })

  it("parses an m.replace edit with new_content", () => {
    const ev = msg({
      event_id: "$edit1",
      content: {
        msgtype: "m.text",
        body: "* fixed",
        "m.new_content": { msgtype: "m.text", body: "fixed" },
        "m.relates_to": { rel_type: "m.replace", event_id: "$orig" },
      },
    })
    const out = parseMatrixEvent(ADAPTER, SELF, ROOM, ev)
    expect(out!.kind).toBe("edit")
    expect(out!.replacesMessageId).toBe("$orig")
    expect(out!.plainText).toBe("fixed")
  })

  it("parses a reaction as a system event", () => {
    const ev: MatrixTimelineEvent = {
      type: "m.reaction",
      event_id: "$react1",
      sender: "@alice:matrix.org",
      origin_server_ts: 1700000000000,
      content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$target", key: "👍" } },
    }
    const out = parseMatrixEvent(ADAPTER, SELF, ROOM, ev)
    expect(out!.kind).toBe("system")
    expect(out!.systemKind).toBe("reaction_added")
    expect(out!.replacesMessageId).toBe("$target")
    expect(out!.segments[0]).toEqual({ type: "emoji", code: "👍" })
  })

  it("parses a redaction as a delete event", () => {
    const ev: MatrixTimelineEvent = {
      type: "m.room.redaction",
      event_id: "$redact1",
      sender: "@alice:matrix.org",
      origin_server_ts: 1700000000000,
      content: {},
      redacts: "$gone",
    }
    const out = parseMatrixEvent(ADAPTER, SELF, ROOM, ev)
    expect(out!.kind).toBe("delete")
    expect(out!.replacesMessageId).toBe("$gone")
    expect(out!.segments).toEqual([])
  })

  it("maps media msgtypes to segments", () => {
    const img = parseMatrixEvent(
      ADAPTER,
      SELF,
      ROOM,
      msg({
        content: {
          msgtype: "m.image",
          body: "pic.png",
          url: "mxc://s/abc",
          info: { w: 10, h: 20 },
        },
      })
    )
    expect(img!.segments[0]).toMatchObject({
      type: "image",
      url: "mxc://s/abc",
      width: 10,
      height: 20,
    })

    const file = parseMatrixEvent(
      ADAPTER,
      SELF,
      ROOM,
      msg({
        content: {
          msgtype: "m.file",
          body: "doc",
          filename: "x.pdf",
          url: "mxc://s/f",
          info: { mimetype: "application/pdf", size: 99 },
        },
      })
    )
    expect(file!.segments[0]).toMatchObject({
      type: "file",
      name: "x.pdf",
      mimeType: "application/pdf",
      sizeBytes: 99,
    })

    const voice = parseMatrixEvent(
      ADAPTER,
      SELF,
      ROOM,
      msg({
        content: { msgtype: "m.audio", body: "v", url: "mxc://s/v", info: { duration: 5000 } },
      })
    )
    expect(voice!.segments[0]).toMatchObject({ type: "voice", durationSec: 5 })
  })

  it("captures reply target and strips the quote fallback", () => {
    const ev = msg({
      content: {
        msgtype: "m.text",
        body: "> <@bob:s> earlier\n\nmy reply",
        "m.relates_to": { "m.in_reply_to": { event_id: "$earlier" } },
      },
    })
    const out = parseMatrixEvent(ADAPTER, SELF, ROOM, ev)
    expect(out!.replyTo?.messageId).toBe("$earlier")
    expect(out!.plainText).toBe("my reply")
  })

  it("derives thread key + kind from m.thread relation", () => {
    const ev = msg({
      content: {
        msgtype: "m.text",
        body: "in thread",
        "m.relates_to": { rel_type: "m.thread", event_id: "$threadRoot" },
      },
    })
    const out = parseMatrixEvent(ADAPTER, SELF, ROOM, ev)
    expect(out!.channel.kind).toBe("thread")
    expect(out!.conversationKey).toBe(`matrix:${ADAPTER}:${ROOM}:$threadRoot`)
  })

  it("detects self-mention from m.mentions.user_ids", () => {
    const ev = msg({
      content: { msgtype: "m.text", body: "hey bot", "m.mentions": { user_ids: [SELF] } },
    })
    const out = parseMatrixEvent(ADAPTER, SELF, ROOM, ev)
    expect(out!.mentions.selfMentioned).toBe(true)
    expect(out!.mentions.users).toContain(SELF)
  })

  it("ignores already-redacted and unknown event types", () => {
    expect(
      parseMatrixEvent(
        ADAPTER,
        SELF,
        ROOM,
        msg({ unsigned: { redacted_because: {} }, content: { body: "x" } })
      )
    ).toBeNull()
    const member: MatrixTimelineEvent = {
      type: "m.room.member",
      event_id: "$m",
      sender: "@a:s",
      origin_server_ts: 1,
      content: {},
    }
    expect(parseMatrixEvent(ADAPTER, SELF, ROOM, member)).toBeNull()
  })
})

describe("stripReplyFallback", () => {
  it("removes the quote block and separator", () => {
    expect(stripReplyFallback("> <@a:s> old\n> more\n\nnew text")).toBe("new text")
  })
  it("returns the original when there is no quote block", () => {
    expect(stripReplyFallback("plain")).toBe("plain")
  })
})

describe("parseMatrixReplyCorrelation", () => {
  beforeEach(() => mockResolve.mockReset())

  it("routes a reply to a bound surface as an input action", async () => {
    mockResolve.mockResolvedValue({
      kind: "force_reply",
      surfaceId: "surf-1",
      componentId: "field-1",
      conversationKey: `matrix:${ADAPTER}:${ROOM}`,
    })
    const ev = msg({
      sender: "@alice:matrix.org",
      content: {
        msgtype: "m.text",
        body: "my answer",
        "m.relates_to": { "m.in_reply_to": { event_id: "$surfaceEvt" } },
      },
    })
    const out = await parseMatrixReplyCorrelation(ADAPTER, SELF, ROOM, ev)
    expect(out).not.toBeNull()
    expect(out!.actionType).toBe("input")
    expect(out!.surfaceId).toBe("surf-1")
    expect(out!.value).toBe("my answer")
    expect(mockResolve).toHaveBeenCalledWith(ADAPTER, "$surfaceEvt")
  })

  it("returns null when there is no reply relation", async () => {
    const ev = msg({ content: { msgtype: "m.text", body: "no reply" } })
    expect(await parseMatrixReplyCorrelation(ADAPTER, SELF, ROOM, ev)).toBeNull()
    expect(mockResolve).not.toHaveBeenCalled()
  })

  it("returns null when the binding is not a force_reply", async () => {
    mockResolve.mockResolvedValue({ kind: "callback_query", surfaceId: "s" })
    const ev = msg({
      content: {
        msgtype: "m.text",
        body: "x",
        "m.relates_to": { "m.in_reply_to": { event_id: "$e" } },
      },
    })
    expect(await parseMatrixReplyCorrelation(ADAPTER, SELF, ROOM, ev)).toBeNull()
  })

  it("returns null for an expired binding", async () => {
    mockResolve.mockResolvedValue({ kind: "force_reply", surfaceId: "s", expiresAt: 1 })
    const ev = msg({
      content: {
        msgtype: "m.text",
        body: "x",
        "m.relates_to": { "m.in_reply_to": { event_id: "$e" } },
      },
    })
    expect(await parseMatrixReplyCorrelation(ADAPTER, SELF, ROOM, ev)).toBeNull()
  })
})
