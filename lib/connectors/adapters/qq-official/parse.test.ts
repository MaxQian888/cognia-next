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
  it.each(["PUBLIC_MESSAGE_DELETE", "MESSAGE_DELETE", "DIRECT_MESSAGE_DELETE"])(
    "normalizes the official %s recall notification",
    (t) => {
      const event = parseQQDispatch(ADAPTER, SELF, {
        op: 0,
        t,
        d: {
          message: {
            id: "parent",
            channel_id: "channel",
            guild_id: "guild",
            author: { id: "original-author" },
          },
          op_user: { id: "user" },
        },
      })
      expect(event).toMatchObject({
        kind: "delete",
        replacesMessageId: "parent",
        segments: [],
        plainText: "",
        sender: { remoteUserId: "user" },
      })
      expect(event?.conversationKey).toBe(
        `qq-official:${ADAPTER}:${t === "DIRECT_MESSAGE_DELETE" ? "guild" : "channel"}`
      )
    }
  )
  it("contains malformed timestamps without losing valid text", () => {
    expect(
      parseQQDispatch(
        ADAPTER,
        SELF,
        dispatch("C2C_MESSAGE_CREATE", {
          id: "bad-time",
          author: { user_openid: "user" },
          timestamp: { toString: null },
          content: "kept",
        } as never)
      )?.plainText
    ).toBe("kept")
  })
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

  it("stamps the local receipt time on the conversationRef for the passive window", () => {
    const before = Date.now()
    const out = parseQQDispatch(
      ADAPTER,
      SELF,
      dispatch("C2C_MESSAGE_CREATE", {
        id: "m-ts",
        content: "hi",
        author: { user_openid: "USER_OPENID" },
      })
    )
    const after = Date.now()
    const receivedAt = out!.conversationRef.receivedAt as number
    expect(receivedAt).toBeGreaterThanOrEqual(before)
    expect(receivedAt).toBeLessThanOrEqual(after)
  })

  it("maps image attachments to image segments with a plainText placeholder", () => {
    const out = parseQQDispatch(
      ADAPTER,
      SELF,
      dispatch("GROUP_AT_MESSAGE_CREATE", {
        id: "m-img",
        content: "",
        group_openid: "GO",
        author: { member_openid: "MO" },
        attachments: [
          {
            url: "gchat.qpic.cn/gchatpic/pic.jpg",
            content_type: "image/jpeg",
            filename: "pic.jpg",
            size: 1234,
            width: 640,
            height: 480,
          },
        ],
      })
    )
    expect(out!.segments).toEqual([
      {
        type: "image",
        url: "https://gchat.qpic.cn/gchatpic/pic.jpg",
        alt: "pic.jpg",
        mimeType: "image/jpeg",
        width: 640,
        height: 480,
      },
    ])
    // An image-only message no longer reaches the AI loop as empty text.
    expect(out!.plainText).toContain("[image]")
  })

  it("maps non-image attachments to file segments and keeps the text segment first", () => {
    const out = parseQQDispatch(
      ADAPTER,
      SELF,
      dispatch("C2C_MESSAGE_CREATE", {
        id: "m-file",
        content: "see attached",
        author: { user_openid: "UO" },
        attachments: [
          {
            url: "https://files.example/doc.pdf",
            content_type: "application/pdf",
            filename: "doc.pdf",
            size: 999,
          },
        ],
      })
    )
    expect(out!.segments).toEqual([
      { type: "text", text: "see attached" },
      {
        type: "file",
        url: "https://files.example/doc.pdf",
        name: "doc.pdf",
        mimeType: "application/pdf",
        sizeBytes: 999,
      },
    ])
    expect(out!.plainText).toContain("[file:doc.pdf]")
  })

  it("skips attachments without a url and defaults missing file metadata", () => {
    const out = parseQQDispatch(
      ADAPTER,
      SELF,
      dispatch("GROUP_AT_MESSAGE_CREATE", {
        id: "m-att",
        content: "",
        group_openid: "GO",
        attachments: [{ content_type: "image/png" }, { url: "cdn.example/blob" }],
      })
    )
    expect(out!.segments).toEqual([
      {
        type: "file",
        url: "https://cdn.example/blob",
        name: "attachment",
        mimeType: "application/octet-stream",
        sizeBytes: 0,
      },
    ])
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
it("preserves official voice/video attachments and message references", () => {
  const out = parseQQDispatch(
    ADAPTER,
    SELF,
    dispatch("C2C_MESSAGE_CREATE", {
      id: "m1",
      author: { user_openid: "u" },
      content: "reply",
      message_reference: { message_id: "previous" },
      attachments: [
        null,
        { url: "//cdn.example/voice", content_type: "voice" },
        { url: "cdn.example/video", content_type: "video/mp4" },
        { url: "javascript:alert(1)", content_type: "image/png" },
      ],
    } as unknown as NonNullable<QQDispatch["d"]>)
  )
  expect(out?.segments).toEqual([
    { type: "reply", messageId: "previous", snippet: "" },
    { type: "text", text: "reply" },
    { type: "voice", url: "https://cdn.example/voice", mimeType: undefined },
    { type: "video", url: "https://cdn.example/video", mimeType: "video/mp4" },
  ])
  expect(out?.replyTo).toEqual({ messageId: "previous", snippet: "" })
})

it.each(["AT_MESSAGE_CREATE", "DIRECT_MESSAGE_CREATE"])(
  "preserves actual author avatar for %s",
  (event) => {
    const url = "https://qqchannel-profile-1251316161.file.myqcloud.com/profile.png"
    const result = parseQQDispatch(
      ADAPTER,
      SELF,
      dispatch(event, {
        id: "portrait",
        channel_id: "channel",
        guild_id: "guild",
        content: "hello",
        author: { id: "opaque-user", avatar: url },
      })
    )
    expect(result?.sender).toMatchObject({
      remoteUserId: "opaque-user",
      remoteIdType: "channel_user",
      avatarUrl: url,
    })
  }
)

it("does not promote arbitrary group message fields or ARK content into an author portrait", () => {
  const result = parseQQDispatch(
    ADAPTER,
    SELF,
    dispatch("GROUP_AT_MESSAGE_CREATE", {
      id: "group",
      group_openid: "group-openid",
      content: "kept",
      author: { member_openid: "opaque", avatar: "https://q1.qlogo.cn/arbitrary" },
    })
  )
  expect(result?.sender.avatarUrl).toBeUndefined()
  expect(result?.sender.remoteIdType).toBe("group_openid")
})
