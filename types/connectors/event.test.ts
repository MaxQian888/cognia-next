import { buildConversationKey, parseConversationKey, type NormalizedInboundEvent } from "./event"

describe("conversationKey", () => {
  it("formats and parses without thread", () => {
    const k = buildConversationKey("telegram", "tg-personal", "12345")
    expect(k).toBe("telegram:tg-personal:12345")
    expect(parseConversationKey(k)).toEqual({
      platform: "telegram",
      adapterId: "tg-personal",
      remoteChatId: "12345",
      threadId: undefined,
    })
  })

  it("formats and parses with thread", () => {
    const k = buildConversationKey("discord", "ds-main", "ch-1", "th-7")
    expect(k).toBe("discord:ds-main:ch-1:th-7")
    expect(parseConversationKey(k)).toEqual({
      platform: "discord",
      adapterId: "ds-main",
      remoteChatId: "ch-1",
      threadId: "th-7",
    })
  })

  it("rejects bad conversation keys", () => {
    expect(() => parseConversationKey("nope")).toThrow(/conversationKey/)
  })

  it("typed event compiles", () => {
    const ev: NormalizedInboundEvent = {
      platform: "telegram",
      adapterId: "tg-1",
      selfId: "bot",
      messageId: "m1",
      conversationRef: { platform: "telegram", adapterId: "tg-1", chatId: 1 },
      conversationKey: "telegram:tg-1:1",
      sender: { id: "u-1", platform: "telegram", adapterId: "tg-1", remoteUserId: "1" },
      channel: { id: "1", kind: "private" },
      segments: [{ type: "text", text: "hi" }],
      plainText: "hi",
      mentions: { selfMentioned: false, users: [] },
      timestamp: 0,
      raw: {},
    }
    expect(ev.platform).toBe("telegram")
  })

  it("typed event accepts edit kind with replacesMessageId", () => {
    const ev: NormalizedInboundEvent = {
      platform: "discord",
      adapterId: "ds-1",
      selfId: "bot",
      messageId: "m2-edited",
      conversationRef: { platform: "discord", adapterId: "ds-1", channelId: "c1" },
      conversationKey: "discord:ds-1:c1",
      sender: { id: "u-1", platform: "discord", adapterId: "ds-1", remoteUserId: "u1" },
      channel: { id: "c1", kind: "channel" },
      segments: [{ type: "text", text: "hi (edited)" }],
      plainText: "hi (edited)",
      mentions: { selfMentioned: false, users: [] },
      timestamp: 0,
      raw: {},
      kind: "edit",
      replacesMessageId: "m1",
    }
    expect(ev.kind).toBe("edit")
    expect(ev.replacesMessageId).toBe("m1")
  })

  it("typed event accepts system kind for read-indicator", () => {
    const ev: NormalizedInboundEvent = {
      platform: "lark",
      adapterId: "lk-1",
      selfId: "bot",
      messageId: "ri-1",
      conversationRef: { platform: "lark", adapterId: "lk-1", chatId: "c1" },
      conversationKey: "lark:lk-1:c1",
      sender: { id: "u-1", platform: "lark", adapterId: "lk-1", remoteUserId: "u1" },
      channel: { id: "c1", kind: "private" },
      segments: [],
      plainText: "",
      mentions: { selfMentioned: false, users: [] },
      timestamp: 0,
      raw: {},
      kind: "system",
      systemKind: "read_indicator",
    }
    expect(ev.kind).toBe("system")
    expect(ev.systemKind).toBe("read_indicator")
  })
})
