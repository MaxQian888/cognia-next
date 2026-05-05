import { parseSlackEventCallback } from "./parse"
import type { SlackEventEnvelope } from "./parse"

import dmTextFixture from "./fixtures/dm-text.json"
import channelMentionFixture from "./fixtures/channel-mention.json"
import threadReplyFixture from "./fixtures/thread-reply.json"
import fileShareFixture from "./fixtures/file-share.json"

const ADAPTER_ID = "slack-adapter-1"
const SELF_ID = "USELF123"

describe("parseSlackEventCallback", () => {
  describe("DM text (dm-text.json)", () => {
    const envelope = dmTextFixture as SlackEventEnvelope
    const result = parseSlackEventCallback(ADAPTER_ID, SELF_ID, envelope)

    it("returns a non-null event", () => {
      expect(result).not.toBeNull()
    })

    it("maps platform to slack", () => {
      expect(result!.platform).toBe("slack")
    })

    it("maps messageId from event.ts", () => {
      expect(result!.messageId).toBe("1714900000.000100")
    })

    it("builds conversationKey for the channel (no thread)", () => {
      expect(result!.conversationKey).toBe(`slack:${ADAPTER_ID}:D111CHANNEL`)
    })

    it("channel kind is private (channel_type=im)", () => {
      expect(result!.channel.kind).toBe("private")
    })

    it("builds sender identity with slack: prefix", () => {
      expect(result!.sender.id).toBe("slack:U222USER")
      expect(result!.sender.platform).toBe("slack")
      expect(result!.sender.remoteUserId).toBe("U222USER")
    })

    it("produces a text segment from event.text", () => {
      expect(result!.segments).toEqual([{ type: "text", text: "Hello, bot!" }])
    })

    it("plainText matches event.text", () => {
      expect(result!.plainText).toBe("Hello, bot!")
    })

    it("no self mention detected (no <@USELF123> in text)", () => {
      expect(result!.mentions.selfMentioned).toBe(false)
    })

    it("timestamp is ms from ts float", () => {
      expect(result!.timestamp).toBe(1714900000000)
    })
  })

  describe("channel mention (channel-mention.json)", () => {
    const envelope = channelMentionFixture as SlackEventEnvelope
    const result = parseSlackEventCallback(ADAPTER_ID, SELF_ID, envelope)

    it("returns a non-null event", () => {
      expect(result).not.toBeNull()
    })

    it("channel kind is channel (channel_type=channel)", () => {
      expect(result!.channel.kind).toBe("channel")
    })

    it("selfMentioned is true when <@USELF123> appears in text", () => {
      expect(result!.mentions.selfMentioned).toBe(true)
    })

    it("mentions.users contains the bot user id", () => {
      expect(result!.mentions.users).toContain("USELF123")
    })
  })

  describe("thread reply (thread-reply.json)", () => {
    const envelope = threadReplyFixture as SlackEventEnvelope
    const result = parseSlackEventCallback(ADAPTER_ID, SELF_ID, envelope)

    it("returns a non-null event", () => {
      expect(result).not.toBeNull()
    })

    it("channel kind is thread", () => {
      expect(result!.channel.kind).toBe("thread")
    })

    it("conversationKey includes the thread_ts", () => {
      expect(result!.conversationKey).toBe(`slack:${ADAPTER_ID}:C555CHANNEL:1714900000.000100`)
    })
  })

  describe("file share (file-share.json)", () => {
    const envelope = fileShareFixture as SlackEventEnvelope
    const result = parseSlackEventCallback(ADAPTER_ID, SELF_ID, envelope)

    it("returns a non-null event", () => {
      expect(result).not.toBeNull()
    })

    it("first segment is image with correct url", () => {
      expect(result!.segments[0]).toMatchObject({
        type: "image",
        url: "https://files.slack.com/files-pri/T123ABC-F123FILE/photo.png",
      })
    })

    it("second segment is the text content", () => {
      expect(result!.segments[1]).toEqual({ type: "text", text: "Check out this image" })
    })

    it("has two segments total", () => {
      expect(result!.segments).toHaveLength(2)
    })
  })

  describe("unsupported subtypes", () => {
    it("returns null for bot_message subtype", () => {
      const envelope: SlackEventEnvelope = {
        type: "event_callback",
        event: {
          type: "message",
          channel: "C123",
          text: "I am a bot",
          ts: "1714900999.000000",
          subtype: "bot_message",
        },
      }
      expect(parseSlackEventCallback(ADAPTER_ID, SELF_ID, envelope)).toBeNull()
    })

    it("returns null for message_changed subtype", () => {
      const envelope: SlackEventEnvelope = {
        type: "event_callback",
        event: {
          type: "message",
          channel: "C123",
          ts: "1714900999.000000",
          subtype: "message_changed",
        },
      }
      expect(parseSlackEventCallback(ADAPTER_ID, SELF_ID, envelope)).toBeNull()
    })

    it("returns null for non-message event type", () => {
      const envelope: SlackEventEnvelope = {
        type: "event_callback",
        event: {
          type: "reaction_added",
          channel: "C123",
          ts: "1714900999.000000",
        },
      }
      expect(parseSlackEventCallback(ADAPTER_ID, SELF_ID, envelope)).toBeNull()
    })

    it("returns null for non-event_callback envelope type", () => {
      const envelope: SlackEventEnvelope = {
        type: "url_verification",
        event: {
          type: "message",
          channel: "C123",
          user: "U999",
          ts: "1714900999.000000",
        },
      }
      expect(parseSlackEventCallback(ADAPTER_ID, SELF_ID, envelope)).toBeNull()
    })
  })
})
