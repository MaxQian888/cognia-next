import { parseDingTalkBotMessage, type DingTalkBotMessage } from "./parse"

function baseMsg(over: Partial<DingTalkBotMessage> = {}): DingTalkBotMessage {
  return {
    conversationId: "cid_1",
    conversationType: "1",
    senderId: "uid_1",
    senderNick: "张三",
    senderStaffId: "staff_1",
    robotCode: "ding_robot",
    msgId: "msg_1",
    createAt: 1700000000000,
    msgtype: "text",
    text: { content: "hello bot" },
    ...over,
  }
}

describe("parseDingTalkBotMessage", () => {
  it("parses a 1:1 text message into a private NormalizedInboundEvent", () => {
    const ev = parseDingTalkBotMessage("ad_1", "self_bot", baseMsg())
    expect(ev).not.toBeNull()
    expect(ev!.platform).toBe("dingtalk")
    expect(ev!.messageId).toBe("msg_1")
    expect(ev!.channel.kind).toBe("private")
    expect(ev!.plainText).toBe("hello bot")
    expect(ev!.segments).toEqual([{ type: "text", text: "hello bot" }])
    expect(ev!.sender.remoteUserId).toBe("staff_1")
    expect(ev!.sender.displayName).toBe("张三")
    expect(ev!.mentions.selfMentioned).toBe(true)
    expect(ev!.conversationKey).toBe("dingtalk:ad_1:cid_1")
    expect(ev!.conversationRef).toMatchObject({
      conversationType: "1",
      userId: "staff_1",
      openConversationId: "cid_1",
      robotCode: "ding_robot",
    })
    expect(ev!.timestamp).toBe(1700000000000)
  })

  it("marks group messages with kind=group", () => {
    const ev = parseDingTalkBotMessage("ad_1", "self", baseMsg({ conversationType: "2" }))
    expect(ev!.channel.kind).toBe("group")
  })

  it("falls back to senderId when staffId is absent", () => {
    const ev = parseDingTalkBotMessage(
      "ad_1",
      "self",
      baseMsg({ senderStaffId: undefined, senderId: "uid_only" })
    )
    expect(ev!.sender.remoteUserId).toBe("uid_only")
  })

  it("flattens richText to plain text", () => {
    const ev = parseDingTalkBotMessage(
      "ad_1",
      "self",
      baseMsg({
        msgtype: "richText",
        text: undefined,
        richText: [{ text: "hello " }, { text: "world" }, { type: "picture" }],
      })
    )
    expect(ev!.plainText).toBe("hello world[picture]")
  })

  it("uses the STT recognition for audio and bracket labels for other media", () => {
    const audio = parseDingTalkBotMessage(
      "ad_1",
      "self",
      baseMsg({ msgtype: "audio", text: undefined, content: { recognition: "spoken text" } })
    )
    expect(audio!.plainText).toBe("spoken text")
    const file = parseDingTalkBotMessage(
      "ad_1",
      "self",
      baseMsg({ msgtype: "file", text: undefined, content: { fileName: "a.pdf" } })
    )
    expect(file!.plainText).toBe("[file:a.pdf]")
    const pic = parseDingTalkBotMessage(
      "ad_1",
      "self",
      baseMsg({ msgtype: "picture", text: undefined })
    )
    expect(pic!.plainText).toBe("[picture]")
  })

  it("labels audio without recognition, video, and unknown msgtypes", () => {
    const audio = parseDingTalkBotMessage(
      "ad_1",
      "self",
      baseMsg({ msgtype: "audio", text: undefined, content: {} })
    )
    expect(audio!.plainText).toBe("[audio]")
    const video = parseDingTalkBotMessage(
      "ad_1",
      "self",
      baseMsg({ msgtype: "video", text: undefined })
    )
    expect(video!.plainText).toBe("[video]")
    const file = parseDingTalkBotMessage(
      "ad_1",
      "self",
      baseMsg({ msgtype: "file", text: undefined, content: {} })
    )
    expect(file!.plainText).toBe("[file]")
    const unknown = parseDingTalkBotMessage(
      "ad_1",
      "self",
      baseMsg({ msgtype: "weird", text: undefined })
    )
    expect(unknown!.plainText).toBe("[weird]")
    const noText = parseDingTalkBotMessage("ad_1", "self", baseMsg({ msgtype: "text", text: {} }))
    expect(noText!.plainText).toBe("")
  })

  it("returns null when required ids are missing", () => {
    expect(parseDingTalkBotMessage("ad_1", "self", baseMsg({ msgId: "" }))).toBeNull()
    expect(parseDingTalkBotMessage("ad_1", "self", baseMsg({ conversationId: "" }))).toBeNull()
  })

  it("defaults selfId to chatbotUserId and timestamp to now when absent", () => {
    const ev = parseDingTalkBotMessage(
      "ad_1",
      "",
      baseMsg({ chatbotUserId: "cbu", createAt: undefined })
    )
    expect(ev!.selfId).toBe("cbu")
    expect(typeof ev!.timestamp).toBe("number")
  })
})
