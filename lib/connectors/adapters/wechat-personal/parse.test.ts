import {
  parseIlinkMessage,
  tryParseNumericCallback,
  type WechatPersonalConversationRef,
} from "./parse"
import { ILINK_ITEM, ILINK_MSG, type IlinkMessage } from "./protocol"
import { __resetNumericActionRegistryForTesting, setNumericAction } from "./numeric-action-registry"

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

  it("derives a messageId that is stable across redeliveries (no wall clock)", () => {
    const first = parseIlinkMessage(ADP, msg({}), 5000)
    const redelivered = parseIlinkMessage(ADP, msg({}), 99_999)
    expect(first!.messageId).toBe(redelivered!.messageId)
    expect(first!.messageId.startsWith("ctx-1:s1:")).toBe(true)
  })

  it("derives different messageIds when the same context_token carries different content", () => {
    const a = parseIlinkMessage(
      ADP,
      msg({ item_list: [{ type: ILINK_ITEM.text, text_item: { text: "one" } }] }),
      5000
    )
    const b = parseIlinkMessage(
      ADP,
      msg({ item_list: [{ type: ILINK_ITEM.text, text_item: { text: "two" } }] }),
      5000
    )
    expect(a!.messageId).not.toBe(b!.messageId)
  })
})

describe("tryParseNumericCallback", () => {
  const CONV = "wechat-personal:wx1:alice@im.wechat"
  beforeEach(() => {
    __resetNumericActionRegistryForTesting()
  })

  it("returns null when the text is not a single digit", () => {
    setNumericAction(CONV, 1, "a2ui:s:y:confirm")
    expect(
      tryParseNumericCallback(
        ADP,
        msg({ item_list: [{ type: ILINK_ITEM.text, text_item: { text: "hi" } }] })
      )
    ).toBeNull()
    expect(
      tryParseNumericCallback(
        ADP,
        msg({ item_list: [{ type: ILINK_ITEM.text, text_item: { text: "12" } }] })
      )
    ).toBeNull()
    expect(
      tryParseNumericCallback(
        ADP,
        msg({ item_list: [{ type: ILINK_ITEM.text, text_item: { text: "0" } }] })
      )
    ).toBeNull()
  })

  it("returns null when no live binding matches the digit", () => {
    expect(
      tryParseNumericCallback(
        ADP,
        msg({ item_list: [{ type: ILINK_ITEM.text, text_item: { text: "1" } }] })
      )
    ).toBeNull()
  })

  it("emits a ConnectorCallbackEvent and consumes the registry on a digit hit", () => {
    setNumericAction(CONV, 1, "a2ui:sfc1:yes:confirm")
    const ev = tryParseNumericCallback(
      ADP,
      msg({ item_list: [{ type: ILINK_ITEM.text, text_item: { text: " 1 " } }] }),
      9999
    )
    expect(ev).not.toBeNull()
    expect(ev!.triggerId).toBe("a2ui:sfc1:yes:confirm")
    expect(ev!.actionType).toBe("button")
    expect(ev!.value).toBe("1")
    expect(ev!.conversationKey).toBe(CONV)
    // Second tap on the same digit no longer fires.
    expect(
      tryParseNumericCallback(
        ADP,
        msg({ item_list: [{ type: ILINK_ITEM.text, text_item: { text: "1" } }] }),
        9999
      )
    ).toBeNull()
  })

  it("routes a wfapp:* registered binding through the same path", () => {
    setNumericAction(CONV, 2, "wfapp:bind1")
    const ev = tryParseNumericCallback(
      ADP,
      msg({ item_list: [{ type: ILINK_ITEM.text, text_item: { text: "2" } }] })
    )
    expect(ev!.triggerId).toBe("wfapp:bind1")
  })

  it("ignores bot-direction messages even when text is a digit", () => {
    setNumericAction(CONV, 1, "a2ui:s:y:confirm")
    expect(
      tryParseNumericCallback(
        ADP,
        msg({
          message_type: ILINK_MSG.fromBot,
          item_list: [{ type: ILINK_ITEM.text, text_item: { text: "1" } }],
        })
      )
    ).toBeNull()
  })
})
