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
  it("notice with no detail_type → system event (G3.5 widened notice handling)", () => {
    // G3.5 widened notice handling — a notice with no detail_type is
    // surfaced as a system event tagged member_added by default. The
    // pre-G3.5 behaviour returned null; that contract changed with the
    // member-change projection.
    const event: OneBotV12Event = { ...makeBase(), type: "notice" }
    const r = parseV12Event(ADAPTER_ID, event)
    expect(r!.kind).toBe("system")
    expect(r!.systemKind).toBe("member_added")
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

  it("ignores message_sent (echo of bot's own outbound)", () => {
    const event: OneBotV12Event = { ...makeBase(), type: "message_sent" }
    expect(parseV12Event(ADAPTER_ID, event)).toBeNull()
  })

  it("group_message_delete notice maps to a kind=delete event", () => {
    const event: OneBotV12Event = {
      id: "evt-del-1",
      time: 1700000400,
      type: "notice",
      detail_type: "group_message_delete",
      group_id: "300001",
      user_id: "200001",
      message_id: "m-1001",
      self: { platform: "qq", user_id: "100000" },
    }
    const r = parseV12Event(ADAPTER_ID, event)
    expect(r).not.toBeNull()
    expect(r!.kind).toBe("delete")
    expect(r!.replacesMessageId).toBe("m-1001")
    expect(r!.channel.kind).toBe("group")
  })

  it("private_message_delete notice maps to kind=delete in a private chat", () => {
    const event: OneBotV12Event = {
      id: "evt-del-2",
      time: 1700000500,
      type: "notice",
      detail_type: "private_message_delete",
      user_id: "200001",
      message_id: "m-2002",
      self: { platform: "qq", user_id: "100000" },
    }
    const r = parseV12Event(ADAPTER_ID, event)
    expect(r).not.toBeNull()
    expect(r!.kind).toBe("delete")
    expect(r!.channel.kind).toBe("private")
  })

  it("group_member_increase → system event (G3.5)", () => {
    const event: OneBotV12Event = {
      id: "evt-other",
      time: 1700000600,
      type: "notice",
      detail_type: "group_member_increase",
      group_id: "300001",
      user_id: "200002",
      self: { platform: "qq", user_id: "100000" },
    }
    const r = parseV12Event(ADAPTER_ID, event)
    expect(r!.kind).toBe("system")
    expect(r!.systemKind).toBe("member_added")
    expect(r!.channel.kind).toBe("group")
  })

  it("group_member_decrease → system event member_removed", () => {
    const event: OneBotV12Event = {
      id: "evt-leave",
      time: 1700000700,
      type: "notice",
      detail_type: "group_member_decrease",
      group_id: "300001",
      user_id: "200003",
      self: { platform: "qq", user_id: "100000" },
    }
    const r = parseV12Event(ADAPTER_ID, event)
    expect(r!.systemKind).toBe("member_removed")
  })

  it("meta events still return null (heartbeat tick is too noisy)", () => {
    const event: OneBotV12Event = {
      id: "evt-meta",
      time: 1700000800,
      type: "meta",
      detail_type: "heartbeat",
      self: { platform: "qq", user_id: "100000" },
    }
    expect(parseV12Event(ADAPTER_ID, event)).toBeNull()
  })
})
