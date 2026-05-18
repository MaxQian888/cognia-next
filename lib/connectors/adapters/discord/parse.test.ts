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

  describe("MESSAGE_UPDATE produces an edit event", () => {
    it("returns kind=edit with replacesMessageId == message id", () => {
      const dispatch: DiscordDispatch = {
        t: "MESSAGE_UPDATE",
        op: 0,
        d: {
          id: "msg-edit-1",
          content: "edited content",
          channel_id: "ch-1",
          author: { id: "u-1", username: "alice" },
          timestamp: "2024-05-05T12:00:00.000000+00:00",
          attachments: [],
          mentions: [],
        },
      }
      const r = parseDiscordDispatch(ADAPTER_ID, SELF_ID, dispatch)
      expect(r).not.toBeNull()
      expect(r!.kind).toBe("edit")
      expect(r!.replacesMessageId).toBe("msg-edit-1")
      expect(r!.messageId).toBe("msg-edit-1")
      expect(r!.segments).toEqual([{ type: "text", text: "edited content" }])
    })

    it("preserves attachments on an edited message", () => {
      const dispatch: DiscordDispatch = {
        t: "MESSAGE_UPDATE",
        op: 0,
        d: {
          id: "msg-edit-2",
          content: "with image",
          channel_id: "ch-2",
          author: { id: "u-2", username: "bob" },
          timestamp: "2024-05-05T12:00:00.000000+00:00",
          attachments: [
            {
              id: "att-1",
              filename: "p.png",
              url: "https://cdn.discordapp.com/attachments/1/2/p.png",
              content_type: "image/png",
              width: 100,
              height: 100,
              size: 1024,
            },
          ],
          mentions: [],
        },
      }
      const r = parseDiscordDispatch(ADAPTER_ID, SELF_ID, dispatch)
      expect(r).not.toBeNull()
      expect(r!.kind).toBe("edit")
      expect(r!.segments[0]).toMatchObject({ type: "image" })
    })
  })

  describe("MESSAGE_DELETE produces a delete event", () => {
    it("returns kind=delete with replacesMessageId set", () => {
      const dispatch: DiscordDispatch = {
        t: "MESSAGE_DELETE",
        op: 0,
        d: {
          id: "msg-del-1",
          channel_id: "ch-1",
          guild_id: "g-1",
        },
      }
      const r = parseDiscordDispatch(ADAPTER_ID, SELF_ID, dispatch)
      expect(r).not.toBeNull()
      expect(r!.kind).toBe("delete")
      expect(r!.replacesMessageId).toBe("msg-del-1")
      expect(r!.segments).toEqual([])
      expect(r!.plainText).toBe("")
      // Discord doesn't send sender on delete events
      expect(r!.sender.remoteUserId).toBe("unknown")
    })

    it("uses thread channel kind when thread_id is present", () => {
      const dispatch: DiscordDispatch = {
        t: "MESSAGE_DELETE",
        op: 0,
        d: {
          id: "msg-del-2",
          channel_id: "ch-1",
          thread_id: "th-1",
        },
      }
      const r = parseDiscordDispatch(ADAPTER_ID, SELF_ID, dispatch)
      expect(r!.channel.kind).toBe("thread")
    })
  })

  describe("unsupported event types", () => {
    it("returns null for unknown dispatch type", () => {
      const dispatch: DiscordDispatch = {
        t: "GUILD_CREATE",
        op: 0,
        d: {},
      }
      expect(parseDiscordDispatch(ADAPTER_ID, SELF_ID, dispatch)).toBeNull()
    })
  })

  // A2.b — mention_roles parse (ADR-0009 v41).
  describe("role mentions (mention_roles)", () => {
    it("emits one mention segment with kind='role' per entry in mention_roles", () => {
      const dispatch: DiscordDispatch = {
        t: "MESSAGE_CREATE",
        op: 0,
        d: {
          id: "msg-roles-1",
          content: "Heads up @here",
          channel_id: "ch-1",
          guild_id: "g-1",
          author: { id: "u-1", username: "alice" },
          timestamp: "2026-05-18T00:00:00.000Z",
          attachments: [],
          mentions: [],
          mention_roles: ["role-eng", "role-pm"],
        },
      } as unknown as DiscordDispatch
      const event = parseDiscordDispatch(ADAPTER_ID, SELF_ID, dispatch)
      const roleSegments = event!.segments.filter(
        (s) => s.type === "mention" && (s as { kind?: string }).kind === "role"
      )
      expect(roleSegments).toHaveLength(2)
      const roleIds = roleSegments.map((s) => (s as { userId: string }).userId).sort()
      expect(roleIds).toEqual(["role-eng", "role-pm"])
    })

    it("emits no role mention segments when mention_roles is absent or empty", () => {
      const dispatch: DiscordDispatch = {
        t: "MESSAGE_CREATE",
        op: 0,
        d: {
          id: "msg-roles-2",
          content: "no roles here",
          channel_id: "ch-1",
          author: { id: "u-1", username: "alice" },
          timestamp: "2026-05-18T00:00:00.000Z",
          attachments: [],
          mentions: [],
        },
      } as unknown as DiscordDispatch
      const event = parseDiscordDispatch(ADAPTER_ID, SELF_ID, dispatch)
      const roleSegments = event!.segments.filter(
        (s) => s.type === "mention" && (s as { kind?: string }).kind === "role"
      )
      expect(roleSegments).toHaveLength(0)
    })
  })
})
