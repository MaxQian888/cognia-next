import { parseV12Event, type OneBotV12Event } from "./v12"

const ADAPTER_ID = "ob-v12-test"

function makeBase(): OneBotV12Event {
  return {
    id: "evt-001",
    time: 1700000000,
    type: "message",
    detail_type: "private",
    message_id: "m-1001",
    user_id: "200001",
    self: { platform: "qq", user_id: "100000" },
    sender: { user_id: "200001", nickname: "Bob" },
    message: [{ type: "text", data: { text: "hello v12" } }],
  }
}

describe("parseV12Event", () => {
  it("returns null for non-message event types", () => {
    const event: OneBotV12Event = { ...makeBase(), type: "notice" }
    expect(parseV12Event(ADAPTER_ID, event)).toBeNull()
  })

  it("parses private text message", () => {
    const result = parseV12Event(ADAPTER_ID, makeBase())
    expect(result).not.toBeNull()
    expect(result!.platform).toBe("onebot")
    expect(result!.adapterId).toBe(ADAPTER_ID)
    expect(result!.selfId).toBe("100000")
    expect(result!.messageId).toBe("m-1001")
    expect(result!.channel.kind).toBe("private")
    expect(result!.sender.remoteUserId).toBe("200001")
    expect(result!.sender.displayName).toBe("Bob")
    expect(result!.plainText).toBe("hello v12")
    expect(result!.mentions.selfMentioned).toBe(false)
    expect(result!.timestamp).toBe(1700000000 * 1000)
  })

  it("parses group text message", () => {
    const event: OneBotV12Event = {
      ...makeBase(),
      detail_type: "group",
      group_id: "300001",
      message: [{ type: "text", data: { text: "group hello v12" } }],
    }
    const result = parseV12Event(ADAPTER_ID, event)
    expect(result).not.toBeNull()
    expect(result!.channel.kind).toBe("group")
    expect(result!.channel.platformChannelId).toBe("300001")
    expect(result!.conversationKey).toContain("g:300001")
  })

  it("detects @mention of self using v12 mention segment", () => {
    const event: OneBotV12Event = {
      ...makeBase(),
      detail_type: "group",
      group_id: "300001",
      self: { platform: "qq", user_id: "100000" },
      message: [
        { type: "mention", data: { user_id: "100000" } },
        { type: "text", data: { text: " help me" } },
      ],
    }
    const result = parseV12Event(ADAPTER_ID, event)
    expect(result).not.toBeNull()
    expect(result!.mentions.selfMentioned).toBe(true)
    expect(result!.mentions.users).toContain("100000")
  })

  it("sets replyTo when a reply segment is present", () => {
    const event: OneBotV12Event = {
      ...makeBase(),
      detail_type: "group",
      group_id: "300001",
      message: [
        { type: "reply", data: { message_id: "m-999" } },
        { type: "text", data: { text: "ack" } },
      ],
    }
    const result = parseV12Event(ADAPTER_ID, event)
    expect(result).not.toBeNull()
    expect(result!.replyTo).toBeDefined()
    expect(result!.replyTo!.messageId).toBe("m-999")
  })

  it("returns null for meta event type", () => {
    const event: OneBotV12Event = { ...makeBase(), type: "meta" }
    expect(parseV12Event(ADAPTER_ID, event)).toBeNull()
  })
})
