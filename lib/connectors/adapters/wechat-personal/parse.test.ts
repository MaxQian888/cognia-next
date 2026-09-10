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

  it("preserves official message identity, timestamp, nested CDN images and voice transcription", () => {
    const ev = parseIlinkMessage(
      ADP,
      msg({
        message_id: 12345,
        create_time_ms: 1700000000000,
        item_list: [
          { type: ILINK_ITEM.image, image_item: { media: { encrypt_query_param: "a+b/=" } } },
          { type: ILINK_ITEM.voice, voice_item: { text: "spoken words" } },
          {
            type: ILINK_ITEM.file,
            file_item: {
              media: { full_url: "https://cdn/file" },
              file_name: "report.pdf",
              len: "42",
            },
          },
        ],
      }),
      5000
    )
    expect(ev).toMatchObject({ messageId: "12345", timestamp: 1700000000000 })
    expect(ev!.segments).toEqual([
      {
        type: "image",
        url: "https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=a%2Bb%2F%3D",
      },
      { type: "text", text: "spoken words" },
      {
        type: "file",
        url: "https://cdn/file",
        name: "report.pdf",
        mimeType: "application/octet-stream",
        sizeBytes: 42,
      },
    ])
  })

  it("preserves quoted text and quoted media without inventing a replyable ID", () => {
    const ev = parseIlinkMessage(
      ADP,
      msg({
        item_list: [
          {
            type: ILINK_ITEM.text,
            text_item: { text: "describe this" },
            ref_msg: {
              title: "Alice",
              message_item: {
                type: ILINK_ITEM.image,
                image_item: { media: { full_url: "https://cdn/quote" } },
              },
            },
          },
          {
            type: ILINK_ITEM.text,
            text_item: { text: "and this" },
            ref_msg: {
              title: "Bob",
              message_item: { type: ILINK_ITEM.text, text_item: { text: "prior text" } },
            },
          },
        ],
      })
    )
    expect(ev!.segments).toEqual([
      { type: "reply", messageId: "", snippet: "Alice" },
      { type: "image", url: "https://cdn/quote" },
      { type: "text", text: "describe this" },
      { type: "reply", messageId: "", snippet: "Bob | prior text" },
      { type: "text", text: "and this" },
    ])
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

describe("official and legacy media variants", () => {
  it("preserves voice/video and safely normalizes absent or invalid file sizes", () => {
    const ev = parseIlinkMessage(
      ADP,
      msg({
        item_list: [
          {
            type: ILINK_ITEM.voice,
            voice_item: { url: "https://cdn/voice", transcript: "legacy" },
          },
          {
            type: ILINK_ITEM.voice,
            voice_item: { media: { full_url: "https://cdn/new" }, text: "new" },
          },
          { type: ILINK_ITEM.video, video_item: { url: "https://cdn/video" } },
          { type: ILINK_ITEM.file, file_item: { url: "https://cdn/file", len: "Infinity" } },
        ],
      })
    )
    expect(ev!.segments).toEqual([
      { type: "voice", url: "https://cdn/voice", transcript: "legacy" },
      { type: "voice", url: "https://cdn/new", transcript: "new" },
      { type: "video", url: "https://cdn/video" },
      {
        type: "file",
        url: "https://cdn/file",
        name: "file",
        mimeType: "application/octet-stream",
        sizeBytes: 0,
      },
    ])
  })
  it("ignores missing content, unsupported items and empty quote metadata", () => {
    for (const type of [1, 2, 3, 4, 5, 99])
      expect(parseIlinkMessage(ADP, msg({ item_list: [{ type, ref_msg: {} }] }))).toBeNull()
    expect(parseIlinkMessage(ADP, msg({ item_list: undefined }))).toBeNull()
    expect(parseIlinkMessage(ADP, msg({ from_user_id: "" }))).toBeNull()
  })
  it("does not consume numeric actions when a digit is part of a larger message", () => {
    const key = "wechat-personal:wx1:alice@im.wechat"
    for (const extra of [
      { type: ILINK_ITEM.text, text_item: { text: "please explain" } },
      { type: ILINK_ITEM.image, image_item: { url: "https://cdn/image" } },
    ]) {
      setNumericAction(key, 1, "action-1")
      expect(
        tryParseNumericCallback(
          ADP,
          msg({ item_list: [{ type: ILINK_ITEM.text, text_item: { text: "1" } }, extra] })
        )
      ).toBeNull()
    }
    expect(tryParseNumericCallback(ADP, msg({ item_list: undefined }))).toBeNull()
    expect(tryParseNumericCallback(ADP, msg({ from_user_id: "" }))).toBeNull()
    expect(tryParseNumericCallback(ADP, msg({ context_token: "" }))).toBeNull()
  })
})
