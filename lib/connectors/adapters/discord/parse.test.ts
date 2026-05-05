import { parseDiscordDispatch } from "./parse"
import type { DiscordDispatch } from "./parse"

import dmTextFixture from "./fixtures/dm-text.json"
import guildMentionFixture from "./fixtures/guild-mention.json"
import threadReplyFixture from "./fixtures/thread-reply.json"
import attachmentImageFixture from "./fixtures/attachment-image.json"

const ADAPTER_ID = "dc-adapter-1"
const SELF_ID = "987654321098765432"

describe("parseDiscordDispatch", () => {
  describe("DM plain text (dm-text.json)", () => {
    const dispatch = dmTextFixture as DiscordDispatch
    const result = parseDiscordDispatch(ADAPTER_ID, SELF_ID, dispatch)

    it("returns a non-null event", () => {
      expect(result).not.toBeNull()
    })

    it("maps platform to discord", () => {
      expect(result!.platform).toBe("discord")
    })

    it("maps messageId from d.id", () => {
      expect(result!.messageId).toBe("1234567890123456789")
    })

    it("builds conversationKey for the channel_id (no guild, private)", () => {
      expect(result!.conversationKey).toBe(`discord:${ADAPTER_ID}:9876543210987654321`)
    })

    it("channel kind is private (no guild_id)", () => {
      expect(result!.channel.kind).toBe("private")
    })

    it("builds sender identity with discord: prefix", () => {
      expect(result!.sender.id).toBe("discord:111111111111111111")
      expect(result!.sender.platform).toBe("discord")
      expect(result!.sender.remoteUserId).toBe("111111111111111111")
      expect(result!.sender.displayName).toBe("Alice Smith")
    })

    it("produces a text segment from content", () => {
      expect(result!.segments).toEqual([{ type: "text", text: "Hello, bot!" }])
    })

    it("plainText matches content", () => {
      expect(result!.plainText).toBe("Hello, bot!")
    })

    it("no replyTo", () => {
      expect(result!.replyTo).toBeUndefined()
    })

    it("selfMentioned is false (no self in mentions[])", () => {
      expect(result!.mentions.selfMentioned).toBe(false)
    })

    it("timestamp is parsed from ISO string", () => {
      expect(result!.timestamp).toBe(new Date("2024-05-05T12:00:00.000000+00:00").getTime())
    })
  })

  describe("guild message with @mention (guild-mention.json)", () => {
    const dispatch = guildMentionFixture as DiscordDispatch
    const result = parseDiscordDispatch(ADAPTER_ID, SELF_ID, dispatch)

    it("returns a non-null event", () => {
      expect(result).not.toBeNull()
    })

    it("conversationKey includes channel_id", () => {
      expect(result!.conversationKey).toBe(`discord:${ADAPTER_ID}:8876543210987654321`)
    })

    it("channel kind is group (has guild_id, no thread_id)", () => {
      expect(result!.channel.kind).toBe("group")
    })

    it("selfMentioned is true when selfId is in mentions[]", () => {
      const r = parseDiscordDispatch(
        ADAPTER_ID,
        "987654321098765432",
        guildMentionFixture as DiscordDispatch
      )
      expect(r!.mentions.selfMentioned).toBe(true)
    })

    it("mentions.users contains the mentioned user id", () => {
      const r = parseDiscordDispatch(
        ADAPTER_ID,
        "987654321098765432",
        guildMentionFixture as DiscordDispatch
      )
      expect(r!.mentions.users).toContain("987654321098765432")
    })
  })

  describe("thread reply (thread-reply.json)", () => {
    const dispatch = threadReplyFixture as DiscordDispatch
    const result = parseDiscordDispatch(ADAPTER_ID, SELF_ID, dispatch)

    it("returns a non-null event", () => {
      expect(result).not.toBeNull()
    })

    it("conversationKey includes thread_id as the channel segment", () => {
      // channel_id == thread_id in Discord thread messages
      expect(result!.conversationKey).toContain("5556543210987654321")
    })

    it("channel kind is thread", () => {
      expect(result!.channel.kind).toBe("thread")
    })

    it("sets replyTo.messageId from message_reference.message_id", () => {
      expect(result!.replyTo).toBeDefined()
      expect(result!.replyTo!.messageId).toBe("9999999999999999999")
    })
  })

  describe("attachment image (attachment-image.json)", () => {
    const dispatch = attachmentImageFixture as DiscordDispatch
    const result = parseDiscordDispatch(ADAPTER_ID, SELF_ID, dispatch)

    it("returns a non-null event", () => {
      expect(result).not.toBeNull()
    })

    it("first segment is image with correct url", () => {
      expect(result!.segments[0]).toMatchObject({
        type: "image",
        url: expect.stringContaining("cdn.discordapp.com"),
      })
    })

    it("second segment is the text content", () => {
      expect(result!.segments[1]).toEqual({ type: "text", text: "Check out this image!" })
    })

    it("has two segments total", () => {
      expect(result!.segments).toHaveLength(2)
    })
  })

  describe("unsupported event types", () => {
    it("returns null for MESSAGE_UPDATE", () => {
      const dispatch: DiscordDispatch = {
        t: "MESSAGE_UPDATE",
        op: 0,
        d: {
          id: "123",
          content: "edited",
          channel_id: "456",
          author: { id: "789", username: "user" },
          timestamp: "2024-05-05T12:00:00.000000+00:00",
          attachments: [],
          mentions: [],
        },
      }
      // TODO (Phase 2): handle MESSAGE_UPDATE as edit events
      expect(parseDiscordDispatch(ADAPTER_ID, SELF_ID, dispatch)).toBeNull()
    })

    it("returns null for unknown dispatch type", () => {
      const dispatch: DiscordDispatch = {
        t: "GUILD_CREATE",
        op: 0,
        d: {},
      }
      expect(parseDiscordDispatch(ADAPTER_ID, SELF_ID, dispatch)).toBeNull()
    })
  })
})
