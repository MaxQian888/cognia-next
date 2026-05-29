import { parseQQDispatch, stripChannelMention, type QQDispatch } from "./parse"

const ADAPTER = "qq-1"
const SELF = "bot-app-id"

function dispatch(t: string, d: QQDispatch["d"]): QQDispatch {
  return { t, op: 0, s: 1, d }
}

describe("stripChannelMention", () => {
  it("removes a leading channel @mention", () => {
    expect(stripChannelMention("<@!123456> hello there")).toBe("hello there")
    expect(stripChannelMention("<@987> hi")).toBe("hi")
  })
  it("leaves plain content untouched", () => {
    expect(stripChannelMention("just text")).toBe("just text")
  })
})

describe("parseQQDispatch", () => {
  it("parses a group @ message", () => {
    const out = parseQQDispatch(
      ADAPTER,
      SELF,
      dispatch("GROUP_AT_MESSAGE_CREATE", {
        id: "m1",
        content: "hi bot",
        group_openid: "GROUP_OPENID",
        author: { member_openid: "MEMBER_OPENID" },
        timestamp: "2024-05-05T12:00:00+00:00",
      })
    )
    expect(out).not.toBeNull()
    expect(out!.conversationRef).toMatchObject({
      scene: "group",
      sceneId: "GROUP_OPENID",
      msgId: "m1",
    })
    expect(out!.conversationKey).toBe(`qq-official:${ADAPTER}:GROUP_OPENID`)
    expect(out!.channel.kind).toBe("group")
    expect(out!.sender.remoteUserId).toBe("MEMBER_OPENID")
    expect(out!.mentions.selfMentioned).toBe(true)
    expect(out!.plainText).toBe("hi bot")
  })

  it("parses a C2C private message", () => {
    const out = parseQQDispatch(
      ADAPTER,
      SELF,
      dispatch("C2C_MESSAGE_CREATE", {
        id: "m2",
        content: "private hi",
        author: { user_openid: "USER_OPENID" },
      })
    )
    expect(out!.conversationRef).toMatchObject({ scene: "c2c", sceneId: "USER_OPENID" })
    expect(out!.channel.kind).toBe("private")
  })

  it("parses a guild channel @ message and strips the mention", () => {
    const out = parseQQDispatch(
      ADAPTER,
      SELF,
      dispatch("AT_MESSAGE_CREATE", {
        id: "m3",
        content: "<@!12345> channel hi",
        channel_id: "CHANNEL_1",
        guild_id: "GUILD_1",
        author: { id: "AUTHOR_1", username: "Bob" },
      })
    )
    expect(out!.conversationRef).toMatchObject({ scene: "channel", sceneId: "CHANNEL_1" })
    expect(out!.plainText).toBe("channel hi")
    expect(out!.sender.displayName).toBe("Bob")
  })

  it("parses a direct (dms) message", () => {
    const out = parseQQDispatch(
      ADAPTER,
      SELF,
      dispatch("DIRECT_MESSAGE_CREATE", {
        id: "m4",
        content: "dm hi",
        guild_id: "DMS_GUILD",
        author: { id: "AUTHOR_2" },
      })
    )
    expect(out!.conversationRef).toMatchObject({ scene: "direct", sceneId: "DMS_GUILD" })
    expect(out!.channel.kind).toBe("private")
  })

  it("returns null for unknown events or missing ids", () => {
    expect(parseQQDispatch(ADAPTER, SELF, dispatch("READY", { id: "x" }))).toBeNull()
    expect(
      parseQQDispatch(ADAPTER, SELF, dispatch("GROUP_AT_MESSAGE_CREATE", { content: "no id" }))
    ).toBeNull()
    expect(
      parseQQDispatch(ADAPTER, SELF, dispatch("GROUP_AT_MESSAGE_CREATE", { id: "m", content: "x" }))
    ).toBeNull() // missing group_openid
  })
})
