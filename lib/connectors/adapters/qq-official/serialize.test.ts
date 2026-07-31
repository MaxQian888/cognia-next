import type { OutboundRequest } from "@/types/connectors/outbound"
import type { MessageSegment } from "@/types/connectors/segment"
import {
  __resetQQMsgSeqForTesting,
  buildQQContent,
  QQ_PASSIVE_WINDOW_MS,
  serializeOutbound,
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
  it("addresses a group message and threads the inbound msg_id as a passive reply", () => {
    const call = serializeOutbound(req("group", "GO", HI, {}, "m1"))
    expect(call).toEqual({
      path: "/v2/groups/GO/messages",
      payload: { content: "hi", msg_type: 0, msg_id: "m1", msg_seq: 1 },
    })
  })

  it("addresses a c2c message", () => {
    const call = serializeOutbound(req("c2c", "UO", HI, {}, "m2"))
    expect(call?.path).toBe("/v2/users/UO/messages")
    expect(call?.payload.msg_type).toBe(0)
    expect(call?.payload.msg_seq).toBe(1)
  })

  it("addresses a channel message without msg_type or msg_seq", () => {
    const call = serializeOutbound(req("channel", "CH", HI, {}, "m3"))
    expect(call?.path).toBe("/channels/CH/messages")
    expect(call?.payload).not.toHaveProperty("msg_type")
    expect(call?.payload).not.toHaveProperty("msg_seq")
    expect(call?.payload.msg_id).toBe("m3")
  })

  it("addresses a direct (dms) message", () => {
    const call = serializeOutbound(req("direct", "GUILD", HI))
    expect(call?.path).toBe("/dms/GUILD/messages")
  })

  it("prefers an explicit replyTo over the captured msg_id", () => {
    const call = serializeOutbound(
      req("group", "GO", HI, { replyTo: { messageId: "explicit" } }, "captured")
    )
    expect(call?.payload.msg_id).toBe("explicit")
  })

  it("returns null for an unaddressable ref", () => {
    expect(serializeOutbound(req(undefined, undefined, [{ type: "text", text: "x" }]))).toBeNull()
  })
})

describe("serializeOutbound — msg_seq", () => {
  it("increments msg_seq for consecutive replies to the same msg_id", () => {
    const first = serializeOutbound(req("group", "GO", HI, {}, "m1"))
    const second = serializeOutbound(req("group", "GO", HI, {}, "m1"))
    const third = serializeOutbound(req("group", "GO", HI, {}, "m1"))
    expect(first?.payload.msg_seq).toBe(1)
    expect(second?.payload.msg_seq).toBe(2)
    expect(third?.payload.msg_seq).toBe(3)
  })

  it("keeps independent counters per msg_id", () => {
    serializeOutbound(req("group", "GO", HI, {}, "m1"))
    serializeOutbound(req("group", "GO", HI, {}, "m1"))
    const other = serializeOutbound(req("c2c", "UO", HI, {}, "m2"))
    expect(other?.payload.msg_seq).toBe(1)
  })

  it("drops msg_id past the 5-reply cap so the send degrades to proactive", () => {
    for (let i = 1; i <= 5; i++) {
      const call = serializeOutbound(req("group", "GO", HI, {}, "m1"))
      expect(call?.payload.msg_seq).toBe(i)
    }
    const sixth = serializeOutbound(req("group", "GO", HI, {}, "m1"))
    expect(sixth?.payload).not.toHaveProperty("msg_id")
    expect(sixth?.payload).not.toHaveProperty("msg_seq")
    expect(sixth?.payload.content).toBe("hi")
  })

  it("evicts the oldest counters when the bounded map overflows", () => {
    serializeOutbound(req("group", "GO", HI, {}, "evict-me"))
    // Push 300 other msg_ids through — "evict-me" falls off the front.
    for (let i = 0; i < 300; i++) {
      serializeOutbound(req("group", "GO", HI, {}, `other-${i}`))
    }
    const again = serializeOutbound(req("group", "GO", HI, {}, "evict-me"))
    expect(again?.payload.msg_seq).toBe(1)
  })

  it("refreshes recency on reuse so hot msg_ids survive eviction", () => {
    serializeOutbound(req("group", "GO", HI, {}, "hot"))
    for (let i = 0; i < 299; i++) {
      serializeOutbound(req("group", "GO", HI, {}, `filler-${i}`))
    }
    // Touch "hot" again — moves it to the back of the eviction queue.
    expect(serializeOutbound(req("group", "GO", HI, {}, "hot"))?.payload.msg_seq).toBe(2)
    for (let i = 0; i < 200; i++) {
      serializeOutbound(req("group", "GO", HI, {}, `filler2-${i}`))
    }
    expect(serializeOutbound(req("group", "GO", HI, {}, "hot"))?.payload.msg_seq).toBe(3)
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

  it("omits msg_id and msg_seq once the group window has elapsed", () => {
    const now = 1_000_000_000
    jest.spyOn(Date, "now").mockReturnValue(now)
    const call = serializeOutbound(
      req("group", "GO", HI, {}, "m1", now - QQ_PASSIVE_WINDOW_MS.group - 1)
    )
    expect(call?.payload).not.toHaveProperty("msg_id")
    expect(call?.payload).not.toHaveProperty("msg_seq")
  })

  it("uses the 60-minute window for c2c", () => {
    const now = 1_000_000_000
    jest.spyOn(Date, "now").mockReturnValue(now)
    const fresh = serializeOutbound(req("c2c", "UO", HI, {}, "m1", now - 30 * 60_000))
    expect(fresh?.payload.msg_id).toBe("m1")
    const stale = serializeOutbound(req("c2c", "UO", HI, {}, "m2", now - 61 * 60_000))
    expect(stale?.payload).not.toHaveProperty("msg_id")
  })

  it("drops an expired msg_id on channel sends too", () => {
    const now = 1_000_000_000
    jest.spyOn(Date, "now").mockReturnValue(now)
    const call = serializeOutbound(req("channel", "CH", HI, {}, "m3", now - 6 * 60_000))
    expect(call?.payload).not.toHaveProperty("msg_id")
  })

  it("treats refs without receivedAt as fresh (pre-existing rows)", () => {
    const call = serializeOutbound(req("group", "GO", HI, {}, "m1"))
    expect(call?.payload.msg_id).toBe("m1")
  })
})
