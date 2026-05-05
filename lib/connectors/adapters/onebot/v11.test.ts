import { parseV11Event, type OneBotV11Event } from "./v11"

const ADAPTER_ID = "ob-test"

function makeBase(): OneBotV11Event {
  return {
    time: 1700000000,
    self_id: 100000,
    post_type: "message",
    message_type: "private",
    message_id: 1001,
    user_id: 200001,
    sender: { user_id: 200001, nickname: "Alice" },
    message: [{ type: "text", data: { text: "hello" } }],
  }
}

describe("parseV11Event", () => {
  it("returns null for non-message post_types", () => {
    const event: OneBotV11Event = { ...makeBase(), post_type: "notice" }
    expect(parseV11Event(ADAPTER_ID, event)).toBeNull()
  })

  it("parses private text message", () => {
    const event = makeBase()
    const result = parseV11Event(ADAPTER_ID, event)
    expect(result).not.toBeNull()
    expect(result!.platform).toBe("onebot")
    expect(result!.adapterId).toBe(ADAPTER_ID)
    expect(result!.selfId).toBe("100000")
    expect(result!.messageId).toBe("1001")
    expect(result!.channel.kind).toBe("private")
    expect(result!.sender.remoteUserId).toBe("200001")
    expect(result!.sender.displayName).toBe("Alice")
    expect(result!.plainText).toBe("hello")
    expect(result!.mentions.selfMentioned).toBe(false)
    expect(result!.timestamp).toBe(1700000000 * 1000)
  })

  it("parses group text message", () => {
    const event: OneBotV11Event = {
      ...makeBase(),
      message_type: "group",
      group_id: 300001,
      message: [{ type: "text", data: { text: "group hello" } }],
    }
    const result = parseV11Event(ADAPTER_ID, event)
    expect(result).not.toBeNull()
    expect(result!.channel.kind).toBe("group")
    expect(result!.channel.platformChannelId).toBe("300001")
    expect(result!.conversationKey).toContain("g:300001")
  })

  it("detects @mention of self (selfMentioned=true)", () => {
    const event: OneBotV11Event = {
      ...makeBase(),
      message_type: "group",
      group_id: 300001,
      self_id: 100000,
      message: [
        { type: "at", data: { qq: "100000" } },
        { type: "text", data: { text: " please help" } },
      ],
    }
    const result = parseV11Event(ADAPTER_ID, event)
    expect(result).not.toBeNull()
    expect(result!.mentions.selfMentioned).toBe(true)
    expect(result!.mentions.users).toContain("100000")
  })

  it("sets replyTo when a reply segment is present", () => {
    const event: OneBotV11Event = {
      ...makeBase(),
      message_type: "group",
      group_id: 300001,
      message: [
        { type: "reply", data: { id: "5555" } },
        { type: "text", data: { text: "yes" } },
      ],
    }
    const result = parseV11Event(ADAPTER_ID, event)
    expect(result).not.toBeNull()
    expect(result!.replyTo).toBeDefined()
    expect(result!.replyTo!.messageId).toBe("5555")
  })

  it("handles CQ-code string messages", () => {
    const event: OneBotV11Event = {
      ...makeBase(),
      message: "[CQ:at,qq=100000] hi bot",
    }
    const result = parseV11Event(ADAPTER_ID, event)
    expect(result).not.toBeNull()
    expect(result!.mentions.selfMentioned).toBe(true)
  })

  it("uses sender card name if present", () => {
    const event: OneBotV11Event = {
      ...makeBase(),
      sender: { user_id: 200001, nickname: "Alice", card: "Alice (Work)" },
    }
    const result = parseV11Event(ADAPTER_ID, event)
    expect(result!.sender.displayName).toBe("Alice (Work)")
  })

  it("returns null for meta_event", () => {
    const event: OneBotV11Event = { ...makeBase(), post_type: "meta_event" }
    expect(parseV11Event(ADAPTER_ID, event)).toBeNull()
  })
})
