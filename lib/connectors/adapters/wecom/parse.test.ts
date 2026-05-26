import { parseWeComMessage, buildWeComConversationRef } from "./parse"
import type { WeComInboundMsgBody } from "./protocol"

const SELF = "aibot_self"
const ADP = "wecom_1"

function body(over: Partial<WeComInboundMsgBody>): WeComInboundMsgBody {
  return {
    msgid: "m1",
    aibotid: SELF,
    chatid: "c1",
    chattype: "single",
    from: { userid: "u_alice", name: "Alice" },
    msgtype: "text",
    text: { content: "hello bot" },
    ...over,
  }
}

describe("parseWeComMessage", () => {
  it("parses a single-chat text message as a private DM (not mention-gated)", () => {
    const ev = parseWeComMessage(ADP, SELF, body({}), "r1", 1000)
    expect(ev).not.toBeNull()
    expect(ev!.platform).toBe("wecom")
    expect(ev!.channel.kind).toBe("private")
    expect(ev!.mentions.selfMentioned).toBe(false)
    expect(ev!.segments).toEqual([{ type: "text", text: "hello bot" }])
    expect(ev!.plainText).toBe("hello bot")
    expect(ev!.conversationKey).toBe("wecom:wecom_1:c1")
    expect(ev!.sender.remoteUserId).toBe("u_alice")
    expect(ev!.timestamp).toBe(1000)
  })

  it("treats group messages as @-mentioned (WeCom only pushes group msgs on mention)", () => {
    const ev = parseWeComMessage(ADP, SELF, body({ chattype: "group", chatid: "grp1" }), "r2")
    expect(ev!.channel.kind).toBe("group")
    expect(ev!.mentions.selfMentioned).toBe(true)
  })

  it("carries reqId + msgid + chat addressing on the conversationRef", () => {
    const ev = parseWeComMessage(ADP, SELF, body({}), "r1")
    const ref = ev!.conversationRef as ReturnType<typeof buildWeComConversationRef>
    expect(ref).toMatchObject({
      platform: "wecom",
      adapterId: ADP,
      chatId: "c1",
      chatType: "single",
      userId: "u_alice",
      reqId: "r1",
      sourceMsgId: "m1",
    })
  })

  it("parses an image message into an image segment", () => {
    const ev = parseWeComMessage(
      ADP,
      SELF,
      body({ msgtype: "image", text: undefined, image: { url: "https://cdn/x", aeskey: "k" } }),
      "r"
    )
    expect(ev!.segments).toEqual([{ type: "image", url: "https://cdn/x" }])
    // aeskey survives on raw for the media resolver.
    expect((ev!.raw as WeComInboundMsgBody).image?.aeskey).toBe("k")
  })

  it("parses a voice message with a transcript", () => {
    const ev = parseWeComMessage(
      ADP,
      SELF,
      body({
        msgtype: "voice",
        text: undefined,
        voice: { url: "https://cdn/v", transcript: "spoken words" },
      }),
      "r"
    )
    expect(ev!.segments).toEqual([
      { type: "voice", url: "https://cdn/v", transcript: "spoken words" },
    ])
  })

  it("parses a file message with name + mime guessed from ext", () => {
    const ev = parseWeComMessage(
      ADP,
      SELF,
      body({
        msgtype: "file",
        text: undefined,
        file: { url: "https://cdn/f", filename: "report.pdf", fileext: "pdf" },
      }),
      "r"
    )
    expect(ev!.segments[0]).toMatchObject({
      type: "file",
      name: "report.pdf",
      mimeType: "application/pdf",
    })
  })

  it("parses a mixed message into ordered text + image segments", () => {
    const ev = parseWeComMessage(
      ADP,
      SELF,
      body({
        msgtype: "mixed",
        text: undefined,
        mixed: {
          msg_item: [
            { msgtype: "text", text: { content: "look:" } },
            { msgtype: "image", image: { url: "https://cdn/i" } },
          ],
        },
      }),
      "r"
    )
    expect(ev!.segments).toEqual([
      { type: "text", text: "look:" },
      { type: "image", url: "https://cdn/i" },
    ])
  })

  it("returns null when the body has no renderable content", () => {
    expect(
      parseWeComMessage(ADP, SELF, body({ msgtype: "text", text: { content: "" } }), "r")
    ).toBeNull()
    expect(parseWeComMessage(ADP, SELF, body({ msgid: "", chatid: "" }), "r")).toBeNull()
  })
})
