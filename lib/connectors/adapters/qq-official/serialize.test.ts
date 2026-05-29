import type { OutboundRequest } from "@/types/connectors/outbound"
import type { MessageSegment } from "@/types/connectors/segment"
import { buildQQContent, serializeOutbound } from "./serialize"
import type { QQScene } from "./parse"

function req(
  scene: QQScene | undefined,
  sceneId: string | undefined,
  segments: MessageSegment[],
  extra: Partial<OutboundRequest> = {},
  msgId?: string
): OutboundRequest {
  return {
    conversationRef: { platform: "qq-official", adapterId: "qq-1", scene, sceneId, msgId },
    segments,
    metadata: { idempotencyKey: "k" },
    ...extra,
  }
}

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
    const call = serializeOutbound(req("group", "GO", [{ type: "text", text: "hi" }], {}, "m1"))
    expect(call).toEqual({
      path: "/v2/groups/GO/messages",
      payload: { content: "hi", msg_type: 0, msg_id: "m1" },
    })
  })

  it("addresses a c2c message", () => {
    const call = serializeOutbound(req("c2c", "UO", [{ type: "text", text: "hi" }], {}, "m2"))
    expect(call?.path).toBe("/v2/users/UO/messages")
    expect(call?.payload.msg_type).toBe(0)
  })

  it("addresses a channel message without msg_type", () => {
    const call = serializeOutbound(req("channel", "CH", [{ type: "text", text: "hi" }], {}, "m3"))
    expect(call?.path).toBe("/channels/CH/messages")
    expect(call?.payload).not.toHaveProperty("msg_type")
    expect(call?.payload.msg_id).toBe("m3")
  })

  it("addresses a direct (dms) message", () => {
    const call = serializeOutbound(req("direct", "GUILD", [{ type: "text", text: "hi" }]))
    expect(call?.path).toBe("/dms/GUILD/messages")
  })

  it("prefers an explicit replyTo over the captured msg_id", () => {
    const call = serializeOutbound(
      req(
        "group",
        "GO",
        [{ type: "text", text: "hi" }],
        { replyTo: { messageId: "explicit" } },
        "captured"
      )
    )
    expect(call?.payload.msg_id).toBe("explicit")
  })

  it("returns null for an unaddressable ref", () => {
    expect(serializeOutbound(req(undefined, undefined, [{ type: "text", text: "x" }]))).toBeNull()
  })
})
