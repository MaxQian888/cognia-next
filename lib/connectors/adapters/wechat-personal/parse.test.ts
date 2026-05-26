import { parseIlinkMessage, type WechatPersonalConversationRef } from "./parse"
import { ILINK_ITEM, ILINK_MSG, type IlinkMessage } from "./protocol"

const ADP = "wx1"

function msg(over: Partial<IlinkMessage>): IlinkMessage {
  return {
    from_user_id: "alice@im.wechat",
    to_user_id: "bot@im.bot",
    message_type: ILINK_MSG.fromUser,
    context_token: "ctx-1",
    session_id: "s1",
    item_list: [{ type: ILINK_ITEM.text, text_item: { text: "hi bot" } }],
    ...over,
  }
}

describe("parseIlinkMessage", () => {
  it("normalises an inbound user text message as a private DM", () => {
    const ev = parseIlinkMessage(ADP, msg({}), 5000)
    expect(ev).not.toBeNull()
    expect(ev!.platform).toBe("wechat-personal")
    expect(ev!.channel.kind).toBe("private")
    expect(ev!.segments).toEqual([{ type: "text", text: "hi bot" }])
    expect(ev!.conversationKey).toBe("wechat-personal:wx1:alice@im.wechat")
    expect(ev!.selfId).toBe("bot@im.bot")
    const ref = ev!.conversationRef as WechatPersonalConversationRef
    expect(ref).toMatchObject({ userId: "alice@im.wechat", contextToken: "ctx-1", sessionId: "s1" })
  })

  it("ignores bot-direction messages", () => {
    expect(parseIlinkMessage(ADP, msg({ message_type: ILINK_MSG.fromBot }))).toBeNull()
  })

  it("ignores messages missing a context_token", () => {
    expect(parseIlinkMessage(ADP, msg({ context_token: "" }))).toBeNull()
  })

  it("parses an image item and keeps the aes_key on raw", () => {
    const ev = parseIlinkMessage(
      ADP,
      msg({
        item_list: [{ type: ILINK_ITEM.image, image_item: { url: "https://cdn/i", aes_key: "k" } }],
      })
    )
    expect(ev!.segments).toEqual([{ type: "image", url: "https://cdn/i" }])
    expect((ev!.raw as IlinkMessage).item_list![0].image_item?.aes_key).toBe("k")
  })

  it("returns null when no item produces content", () => {
    expect(parseIlinkMessage(ADP, msg({ item_list: [] }))).toBeNull()
  })
})
