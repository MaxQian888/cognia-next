import type { OutboundRequest } from "@/types/connectors/outbound"
import type { MessageSegment } from "@/types/connectors/segment"
import { buildWechatContent, serializeOutbound } from "./serialize"

function req(openId: string | undefined, segments: MessageSegment[]): OutboundRequest {
  return {
    conversationRef: { platform: "wechat-oa", adapterId: "wxoa-1", openId },
    segments,
    metadata: { idempotencyKey: "k" },
  }
}

describe("buildWechatContent", () => {
  it("preserves mention IDs and rejects opaque cards", () => {
    expect(buildWechatContent([{ type: "mention", userId: "u" }])).toBe("@u")
    expect(buildWechatContent([{ type: "location", lat: 1, lon: 2 }])).toBe("Location: 1,2")
    expect(() =>
      buildWechatContent([{ type: "card", card: { kind: "unknown", payload: {} } }])
    ).toThrow(/opaque/)
  })
  it("flattens segments into text", () => {
    expect(
      buildWechatContent([
        { type: "text", text: "a" },
        { type: "image", url: "https://e/p.png" },
      ])
    ).toBe("a\n[image] https://e/p.png")
  })
})

describe("serializeOutbound", () => {
  it("builds a 客服 text message addressed to the openId", () => {
    expect(serializeOutbound(req("oUser", [{ type: "text", text: "hi" }]))).toEqual({
      touser: "oUser",
      msgtype: "text",
      text: { content: "hi" },
    })
  })

  it("returns null without an openId", () => {
    expect(serializeOutbound(req(undefined, [{ type: "text", text: "x" }]))).toBeNull()
  })
})
