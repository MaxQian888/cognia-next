import type { OutboundRequest } from "@/types/connectors/outbound"
import type { MessageSegment } from "@/types/connectors/segment"
import {
  __resetQQMsgSeqForTesting,
  buildQQContent,
  decodeQQMessageId,
  encodeQQMessageId,
  parseQQEmojiType,
  QQ_MAX_PASSIVE_REPLIES,
  QQ_PASSIVE_WINDOW_MS,
  QQ_TYPING_INPUT_SECONDS,
  qqPassiveMsgSeq,
  qqPassiveReplyCount,
  registerQQPassiveReply,
  serializeDelete,
  serializeOutbound,
  serializeOutboundParts,
  serializeReaction,
  serializeTyping,
} from "./serialize"
import type { QQScene } from "./parse"

function req(
  scene: QQScene | undefined,
  sceneId: string | undefined,
  segments: MessageSegment[],
  extra: Partial<OutboundRequest> = {},
  msgId?: string,
  receivedAt?: number
): OutboundRequest {
  return {
    conversationRef: {
      platform: "qq-official",
      adapterId: "qq-1",
      scene,
      sceneId,
      msgId,
      ...(receivedAt !== undefined ? { receivedAt } : {}),
    },
    segments,
    metadata: { idempotencyKey: "k" },
    ...extra,
  }
}

const HI: MessageSegment[] = [{ type: "text", text: "hi" }]

beforeEach(() => {
  __resetQQMsgSeqForTesting()
})

describe("buildQQContent", () => {
  it("flattens text/markdown/media into plain text", () => {
    expect(
      buildQQContent([
        { type: "text", text: "a" },
        { type: "markdown", md: "**b**" },
        { type: "image", url: "https://e/p.png" },
      ])
    ).toBe("a\n**b**\n[image] https://e/p.png")
  })
})

describe("serializeOutbound", () => {
  it("preflights every multipart reply without spending slots or dropping trailing text", () => {
    const input = req(
      "group",
      "GO",
      [
        { type: "image", url: "https://cdn.example.org/a.png" },
        { type: "text", text: "after image" },
      ],
      {},
      "m1"
    )
    const preview = serializeOutboundParts(input, false)
    expect(qqPassiveReplyCount("m1")).toBe(0)
    expect(preview.map((part) => part.payload.msg_type)).toEqual([7, 0])
    expect(preview[1].payload.content).toBe("after image")
    expect(serializeOutboundParts(input)).toEqual(preview)
    expect(qqPassiveReplyCount("m1")).toBe(2)
    expect(serializeOutboundParts(input)).toEqual(preview)
    expect(qqPassiveReplyCount("m1")).toBe(2)
  })
  it("rejects an over-cap multipart message atomically", () => {
    const input = req(
      "group",
      "GO",
      Array.from({ length: 6 }, (_, i) => ({
        type: "image" as const,
        url: `https://cdn.example.org/${i}.png`,
      })),
      {},
      "m1"
    )
    expect(() => serializeOutboundParts(input)).toThrow("5-reply")
    expect(qqPassiveReplyCount("m1")).toBe(0)
  })
  it("rejects non-public URLs, non-SILK voice, unsupported channel video, and empty input", () => {
    expect(() =>
      serializeOutboundParts(
        req("group", "GO", [{ type: "image", url: "http://127.0.0.1/x" }], {}, "m1")
      )
    ).toThrow("public")
    expect(() =>
      serializeOutboundParts(
        req(
          "group",
          "GO",
          [{ type: "voice", url: "https://cdn.example.org/x", mimeType: "audio/mpeg" }],
          {},
          "m1"
        )
      )
    ).toThrow("SILK")
    expect(() =>
      serializeOutboundParts(
        req("channel", "CH", [{ type: "video", url: "https://cdn.example.org/x" }], {}, "m1")
      )
    ).toThrow("does not support")
    expect(() => serializeOutboundParts(req("group", "GO", [], {}, "m1"))).toThrow("empty")
  })
  it.each(["group", "c2c", "channel", "direct"] as const)(
    "rejects removed proactive sends in %s",
    (scene) => {
      expect(() => serializeOutbound(req(scene, "target", HI))).toThrow("proactive")
    }
  )
  it("addresses a group message and threads the inbound msg_id as a passive reply", () => {
    const call = serializeOutbound(req("group", "GO", HI, {}, "m1"))
    expect(call).toEqual({
      path: "/v2/groups/GO/messages",
      payload: { content: "hi", msg_type: 0, msg_id: "m1", msg_seq: qqPassiveMsgSeq("k") },
    })
  })

  it("addresses a c2c message", () => {
    const call = serializeOutbound(req("c2c", "UO", HI, {}, "m2"))
    expect(call?.path).toBe("/v2/users/UO/messages")
    expect(call?.payload.msg_type).toBe(0)
    expect(call?.payload.msg_seq).toBe(qqPassiveMsgSeq("k"))
  })

  it("addresses a channel message without msg_type or msg_seq", () => {
    const call = serializeOutbound(req("channel", "CH", HI, {}, "m3"))
    expect(call?.path).toBe("/channels/CH/messages")
    expect(call?.payload).not.toHaveProperty("msg_type")
    expect(call?.payload).not.toHaveProperty("msg_seq")
    expect(call?.payload.msg_id).toBe("m3")
  })

  it("addresses a direct (dms) message", () => {
    const call = serializeOutbound(req("direct", "GUILD", HI, {}, "direct-msg"))
    expect(call?.path).toBe("/dms/GUILD/messages")
  })

  it("prefers an explicit replyTo over the captured msg_id", () => {
    const call = serializeOutbound(
      req("group", "GO", HI, { replyTo: { messageId: "explicit" } }, "captured")
    )
    expect(call?.payload.msg_id).toBe("explicit")
  })
  it("does not age an explicit different reply id using the captured message timestamp", () => {
    expect(
      serializeOutbound(req("group", "GO", HI, { replyTo: { messageId: "different" } }, "old", 1))
        ?.payload.msg_id
    ).toBe("different")
  })

  it("returns null for an unaddressable ref", () => {
    expect(serializeOutbound(req(undefined, undefined, [{ type: "text", text: "x" }]))).toBeNull()
  })
})

describe("qqPassiveMsgSeq", () => {
  it("is deterministic, positive and inside the 16-bit range", () => {
    const seq = qqPassiveMsgSeq("job-1")
    expect(seq).toBe(qqPassiveMsgSeq("job-1"))
    expect(Number.isInteger(seq)).toBe(true)
    expect(seq).toBeGreaterThanOrEqual(1)
    expect(seq).toBeLessThanOrEqual(65535)
    expect(qqPassiveMsgSeq("job-1")).not.toBe(qqPassiveMsgSeq("job-2"))
  })
})

describe("serializeOutbound — msg_seq", () => {
  const withKey = (key: string, msgId = "m1", scene: QQScene = "group", sceneId = "GO") =>
    req(scene, sceneId, HI, { metadata: { idempotencyKey: key } }, msgId)

  it("derives msg_seq from the idempotency key so distinct replies get distinct seqs", () => {
    const first = serializeOutbound(withKey("job-a"))
    const second = serializeOutbound(withKey("job-b"))
    const third = serializeOutbound(withKey("job-c"))
    expect(first?.payload.msg_seq).toBe(qqPassiveMsgSeq("job-a"))
    expect(second?.payload.msg_seq).toBe(qqPassiveMsgSeq("job-b"))
    expect(third?.payload.msg_seq).toBe(qqPassiveMsgSeq("job-c"))
    expect(new Set([first, second, third].map((c) => c?.payload.msg_seq)).size).toBe(3)
  })

  it("a retry (same idempotency key) re-sends the same msg_id + msg_seq pair", () => {
    const first = serializeOutbound(withKey("job-a"))
    const retry = serializeOutbound(withKey("job-a"))
    expect(retry?.payload).toEqual(first?.payload)
    expect(qqPassiveReplyCount("m1")).toBe(1)
  })

  it("keeps independent reply counts per msg_id", () => {
    serializeOutbound(withKey("job-a", "m1"))
    serializeOutbound(withKey("job-b", "m1"))
    const other = serializeOutbound(withKey("job-c", "m2", "c2c", "UO"))
    expect(other?.payload.msg_seq).toBe(qqPassiveMsgSeq("job-c"))
    expect(qqPassiveReplyCount("m1")).toBe(2)
    expect(qqPassiveReplyCount("m2")).toBe(1)
  })

  it("rejects a sixth distinct passive reply without removing its context", () => {
    for (let i = 1; i <= QQ_MAX_PASSIVE_REPLIES; i++) {
      const call = serializeOutbound(withKey(`job-${i}`))
      expect(call?.payload.msg_seq).toBe(qqPassiveMsgSeq(`job-${i}`))
    }
    expect(() => serializeOutbound(withKey("job-6"))).toThrow("5-reply")
    // The rejected job does not consume a slot; a retry of an earlier job still passes.
    expect(qqPassiveReplyCount("m1")).toBe(QQ_MAX_PASSIVE_REPLIES)
    expect(serializeOutbound(withKey("job-1"))?.payload.msg_seq).toBe(qqPassiveMsgSeq("job-1"))
  })

  it("falls back to a per-send synthetic key when the request has no idempotency key", () => {
    const first = serializeOutbound(withKey("", "m1"))
    const second = serializeOutbound(withKey("", "m1"))
    expect(first?.payload.msg_id).toBe("m1")
    expect(second?.payload.msg_id).toBe("m1")
    expect(first?.payload.msg_seq).not.toBe(second?.payload.msg_seq)
    expect(qqPassiveReplyCount("m1")).toBe(2)
  })

  it("evicts the oldest msg_ids when the bounded map overflows", () => {
    serializeOutbound(withKey("job-a", "evict-me"))
    // Push 300 other msg_ids through — "evict-me" falls off the front.
    for (let i = 0; i < 300; i++) {
      serializeOutbound(withKey(`job-${i}`, `other-${i}`))
    }
    expect(qqPassiveReplyCount("evict-me")).toBe(0)
    serializeOutbound(withKey("job-z", "evict-me"))
    expect(qqPassiveReplyCount("evict-me")).toBe(1)
  })

  it("refreshes recency on reuse so hot msg_ids survive eviction", () => {
    serializeOutbound(withKey("job-a", "hot"))
    for (let i = 0; i < 299; i++) {
      serializeOutbound(withKey(`job-${i}`, `filler-${i}`))
    }
    // Touch "hot" again — moves it to the back of the eviction queue.
    serializeOutbound(withKey("job-b", "hot"))
    expect(qqPassiveReplyCount("hot")).toBe(2)
    for (let i = 0; i < 200; i++) {
      serializeOutbound(withKey(`job2-${i}`, `filler2-${i}`))
    }
    serializeOutbound(withKey("job-c", "hot"))
    expect(qqPassiveReplyCount("hot")).toBe(3)
  })

  it("registerQQPassiveReply is idempotent per key and counts distinct keys", () => {
    expect(registerQQPassiveReply("mx", "k1")).toBe(1)
    expect(registerQQPassiveReply("mx", "k1")).toBe(1)
    expect(registerQQPassiveReply("mx", "k2")).toBe(2)
    expect(qqPassiveReplyCount("mx")).toBe(2)
  })
})

describe("serializeOutbound — passive window expiry", () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it("keeps msg_id when the group window (5 min) has not elapsed", () => {
    const now = 1_000_000_000
    jest.spyOn(Date, "now").mockReturnValue(now)
    const call = serializeOutbound(req("group", "GO", HI, {}, "m1", now - 4 * 60_000))
    expect(call?.payload.msg_id).toBe("m1")
  })

  it("rejects replies once the group window has elapsed", () => {
    const now = 1_000_000_000
    jest.spyOn(Date, "now").mockReturnValue(now)
    expect(() =>
      serializeOutbound(req("group", "GO", HI, {}, "m1", now - QQ_PASSIVE_WINDOW_MS.group - 1))
    ).toThrow("reply window")
  })

  it("uses the 60-minute window for c2c", () => {
    const now = 1_000_000_000
    jest.spyOn(Date, "now").mockReturnValue(now)
    const fresh = serializeOutbound(req("c2c", "UO", HI, {}, "m1", now - 30 * 60_000))
    expect(fresh?.payload.msg_id).toBe("m1")
    expect(() => serializeOutbound(req("c2c", "UO", HI, {}, "m2", now - 61 * 60_000))).toThrow(
      "reply window"
    )
  })

  it("rejects an expired msg_id on channel sends too", () => {
    const now = 1_000_000_000
    jest.spyOn(Date, "now").mockReturnValue(now)
    expect(() => serializeOutbound(req("channel", "CH", HI, {}, "m3", now - 6 * 60_000))).toThrow(
      "reply window"
    )
  })

  it("treats refs without receivedAt as fresh (pre-existing rows)", () => {
    const call = serializeOutbound(req("group", "GO", HI, {}, "m1"))
    expect(call?.payload.msg_id).toBe("m1")
  })
})

describe("encodeQQMessageId / decodeQQMessageId", () => {
  it("round-trips every scene", () => {
    for (const scene of ["group", "c2c", "channel", "direct"] as const) {
      const id = encodeQQMessageId(scene, "S:1", "MSG")
      expect(id).toBe(`${scene}:S:1:MSG`)
      expect(decodeQQMessageId(id)).toEqual({ scene, sceneId: "S", id: "1:MSG" })
    }
    expect(decodeQQMessageId("channel:CH:m9")).toEqual({
      scene: "channel",
      sceneId: "CH",
      id: "m9",
    })
  })

  it("returns null for bare ids, unknown scenes and truncated composites", () => {
    expect(decodeQQMessageId("m9")).toBeNull()
    expect(decodeQQMessageId("guild:CH:m9")).toBeNull()
    expect(decodeQQMessageId("group:GO")).toBeNull()
    expect(decodeQQMessageId("group:GO:")).toBeNull()
    expect(decodeQQMessageId(":GO:m")).toBeNull()
    expect(decodeQQMessageId("group::m")).toBeNull()
  })
})

describe("serializeDelete", () => {
  it("maps each scene to its recall endpoint (hidetip=false on guild scenes)", () => {
    expect(serializeDelete({ scene: "group", sceneId: "GO", id: "m1" })).toEqual({
      method: "DELETE",
      path: "/v2/groups/GO/messages/m1",
    })
    expect(serializeDelete({ scene: "c2c", sceneId: "UO", id: "m1" }).path).toBe(
      "/v2/users/UO/messages/m1"
    )
    expect(serializeDelete({ scene: "channel", sceneId: "CH", id: "m1" }).path).toBe(
      "/channels/CH/messages/m1?hidetip=false"
    )
    expect(serializeDelete({ scene: "direct", sceneId: "G", id: "m1" }).path).toBe(
      "/dms/G/messages/m1?hidetip=false"
    )
  })

  it("URL-encodes ids", () => {
    expect(serializeDelete({ scene: "group", sceneId: "a/b", id: "c d" }).path).toBe(
      "/v2/groups/a%2Fb/messages/c%20d"
    )
  })
})

describe("serializeReaction / parseQQEmojiType", () => {
  it("builds PUT for add and DELETE for remove on the channel reaction path", () => {
    expect(serializeReaction("CH", "m1", "1:4", "add")).toEqual({
      method: "PUT",
      path: "/channels/CH/messages/m1/reactions/1/4",
    })
    expect(serializeReaction("CH", "m1", "2:128512", "remove")).toEqual({
      method: "DELETE",
      path: "/channels/CH/messages/m1/reactions/2/128512",
    })
  })

  it("rejects emoji types that are not <type>:<id>", () => {
    expect(() => parseQQEmojiType("👍")).toThrow(/<type>:<id>/)
    expect(() => parseQQEmojiType(":4")).toThrow(/<type>:<id>/)
    expect(() => parseQQEmojiType("1:")).toThrow(/<type>:<id>/)
    expect(parseQQEmojiType("1:4")).toEqual({ type: "1", id: "4" })
  })
})

describe("serializeTyping", () => {
  it("builds the c2c input_notify passive reply", () => {
    expect(serializeTyping("UO", "in-1", 77)).toEqual({
      method: "POST",
      path: "/v2/users/UO/messages",
      payload: {
        msg_type: 6,
        input_notify: { input_type: 1, input_second: QQ_TYPING_INPUT_SECONDS },
        msg_id: "in-1",
        msg_seq: 77,
      },
    })
  })
})

describe("QQ text alternatives", () => {
  it.each(["group", "c2c", "channel", "direct"] as const)(
    "preserves mention, reply, poll and location in %s",
    (scene) => {
      const call = serializeOutbound(
        req(
          scene,
          "target",
          [
            { type: "mention", userId: "u", displayName: "Alice" },
            { type: "reply", messageId: "prior", snippet: "context" },
            { type: "poll", question: "Pick", options: ["A", "B"] },
            { type: "location", lat: 1, lon: 2, name: "Office" },
          ],
          {},
          "m1"
        )
      )
      expect(call?.payload.content).toBe("@Alice\n> context\nPick\n- A\n- B\n[location 1,2 Office]")
      expect(call?.downgrades).toEqual(
        ["mention", "reply", "poll", "location"].map((from) => ({
          from,
          to: "text",
          reason: `qq_${from}_text_alternative`,
        }))
      )
    }
  )
  it("rejects a trailing opaque card before reserving any multipart reply slot", () => {
    const input = req(
      "group",
      "target",
      [
        { type: "image", url: "https://example.com/a.jpg" },
        { type: "card", card: { kind: "custom", payload: { title: "opaque" } } },
      ],
      {},
      "m1"
    )
    expect(() => serializeOutboundParts(input)).toThrow(/opaque cards/)
    expect(qqPassiveReplyCount("m1")).toBe(0)
  })
  it("keeps text alternatives with native media and subsequent messages", () => {
    const input = req(
      "group",
      "target",
      [
        { type: "mention", userId: "u" },
        { type: "image", url: "https://example.com/a.jpg" },
        { type: "reply", messageId: "prior", snippet: "after" },
      ],
      {},
      "m1"
    )
    const calls = serializeOutboundParts(input)
    expect(calls[0]).toMatchObject({
      payload: { content: "@u", msg_type: 7 },
      upload: { payload: { file_type: 1 } },
      downgrades: [{ from: "mention" }],
    })
    expect(calls[1]).toMatchObject({
      payload: { content: "> after", msg_type: 0 },
      downgrades: [{ from: "reply" }],
    })
  })
})
