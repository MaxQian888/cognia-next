import { parseTelegramUpdate } from "./parse"
import type { TelegramUpdate } from "./parse"

import privateMsgFixture from "./fixtures/private-message.json"
import groupMentionFixture from "./fixtures/group-mention.json"
import replyToBotFixture from "./fixtures/reply-to-bot.json"
import photoWithCaptionFixture from "./fixtures/photo-with-caption.json"
import forumThreadFixture from "./fixtures/forum-thread.json"
import editedMessageFixture from "./fixtures/edited-message.json"
import callbackQueryFixture from "./fixtures/callback-query.json"

const ADAPTER_ID = "tg-adapter-1"
const SELF_ID = "987654321"

describe("parseTelegramUpdate", () => {
  describe("private text DM", () => {
    const update = privateMsgFixture as TelegramUpdate
    const result = parseTelegramUpdate(ADAPTER_ID, SELF_ID, update)

    it("returns a non-null event", () => {
      expect(result).not.toBeNull()
    })

    it("maps platform to telegram", () => {
      expect(result!.platform).toBe("telegram")
    })

    it("maps messageId", () => {
      expect(result!.messageId).toBe("1001")
    })

    it("builds conversation key for private chat", () => {
      expect(result!.conversationKey).toBe(`telegram:${ADAPTER_ID}:111111111`)
    })

    it("builds sender identity with tg: prefix", () => {
      expect(result!.sender.id).toBe("tg:111111111:111111111")
      expect(result!.sender.platform).toBe("telegram")
      expect(result!.sender.remoteUserId).toBe("111111111")
      expect(result!.sender.displayName).toBe("Alice Smith")
    })

    it("channel kind is private", () => {
      expect(result!.channel.kind).toBe("private")
    })

    it("produces a text segment", () => {
      expect(result!.segments).toEqual([{ type: "text", text: "Hello, bot!" }])
    })

    it("plainText matches message text", () => {
      expect(result!.plainText).toBe("Hello, bot!")
    })

    it("no replyTo", () => {
      expect(result!.replyTo).toBeUndefined()
    })

    it("selfMentioned is false for DM without mention entity", () => {
      expect(result!.mentions.selfMentioned).toBe(false)
    })

    it("timestamp is date * 1000", () => {
      expect(result!.timestamp).toBe(1714900000 * 1000)
    })
  })

  describe("group text with @mention", () => {
    const update = groupMentionFixture as TelegramUpdate
    const result = parseTelegramUpdate(ADAPTER_ID, SELF_ID, update)

    it("returns a non-null event", () => {
      expect(result).not.toBeNull()
    })

    it("conversation key includes group chat id", () => {
      expect(result!.conversationKey).toBe(`telegram:${ADAPTER_ID}:-1001234567890`)
    })

    it("channel kind is group", () => {
      expect(result!.channel.kind).toBe("group")
    })

    it("mentions array contains the @mention text", () => {
      expect(result!.mentions.users).toContain("@mybot")
    })
  })

  describe("reply to bot's previous message", () => {
    const update = replyToBotFixture as TelegramUpdate
    const result = parseTelegramUpdate(ADAPTER_ID, SELF_ID, update)

    it("returns a non-null event", () => {
      expect(result).not.toBeNull()
    })

    it("sets replyTo.messageId", () => {
      expect(result!.replyTo).toBeDefined()
      expect(result!.replyTo!.messageId).toBe("999")
    })

    it("sets replyTo.snippet from replied message text", () => {
      expect(result!.replyTo!.snippet).toBe("You are welcome!")
    })

    it("selfMentioned is true when replying to bot's message", () => {
      expect(result!.mentions.selfMentioned).toBe(true)
    })
  })

  describe("photo with caption", () => {
    const update = photoWithCaptionFixture as TelegramUpdate
    const result = parseTelegramUpdate(ADAPTER_ID, SELF_ID, update)

    it("returns a non-null event", () => {
      expect(result).not.toBeNull()
    })

    it("first segment is image", () => {
      expect(result!.segments[0]).toMatchObject({
        type: "image",
        url: expect.stringContaining("tg://file/"),
      })
    })

    it("second segment is the caption text", () => {
      expect(result!.segments[1]).toEqual({ type: "text", text: "Check out this photo!" })
    })

    it("has two segments total", () => {
      expect(result!.segments).toHaveLength(2)
    })
  })

  describe("forum thread message", () => {
    const update = forumThreadFixture as TelegramUpdate
    const result = parseTelegramUpdate(ADAPTER_ID, SELF_ID, update)

    it("returns a non-null event", () => {
      expect(result).not.toBeNull()
    })

    it("conversationKey includes thread suffix", () => {
      expect(result!.conversationKey).toBe(`telegram:${ADAPTER_ID}:-1009876543210:42`)
    })

    it("channel kind is thread", () => {
      expect(result!.channel.kind).toBe("thread")
    })
  })

  describe("edited_message produces an edit event", () => {
    const update = editedMessageFixture as TelegramUpdate
    const result = parseTelegramUpdate(ADAPTER_ID, SELF_ID, update)

    it("returns a non-null event", () => {
      expect(result).not.toBeNull()
    })

    it("kind is edit", () => {
      expect(result!.kind).toBe("edit")
    })

    it("replacesMessageId points back to the original message_id", () => {
      // Telegram reuses message_id for edits — the field is the same value
      // as messageId, but downstream consumers (bus.ts) key off
      // replacesMessageId for the lookup so it must be set.
      expect(result!.replacesMessageId).toBe("1006")
      expect(result!.messageId).toBe("1006")
    })

    it("uses edit_date for the timestamp (not the original send date)", () => {
      expect(result!.timestamp).toBe(1714900600 * 1000)
    })

    it("carries the edited text in the segments", () => {
      expect(result!.segments).toEqual([{ type: "text", text: "Edited text message" }])
    })
  })

  describe("callback_query produces a synthetic create event", () => {
    const update = callbackQueryFixture as TelegramUpdate
    const result = parseTelegramUpdate(ADAPTER_ID, SELF_ID, update)

    it("returns a non-null event", () => {
      expect(result).not.toBeNull()
    })

    it("kind is create (treated as a fresh user turn)", () => {
      expect(result!.kind).toBe("create")
    })

    it("messageId is prefixed with tgcq: + the callback_query.id for dedup", () => {
      expect(result!.messageId).toBe("tgcq:4382bfdwdsb323b2d9")
    })

    it("segments carry the callback data as a text payload", () => {
      expect(result!.segments).toEqual([{ type: "text", text: "option_a" }])
      expect(result!.plainText).toBe("option_a")
    })

    it("sender is the user who pressed the button (not the bot)", () => {
      expect(result!.sender.remoteUserId).toBe("777777777")
      expect(result!.sender.displayName).toBe("Grace")
    })

    it("conversationKey anchors to the chat where the button lives", () => {
      expect(result!.conversationKey).toBe(`telegram:${ADAPTER_ID}:777777777`)
    })

    it("conversationRef carries the callback_query.id for the responder to ack", () => {
      expect((result!.conversationRef as { callbackQueryId?: string }).callbackQueryId).toBe(
        "4382bfdwdsb323b2d9"
      )
    })
  })

  describe("inline-message-only callback_query (no chat) returns null", () => {
    it("returns null when callback_query has no message", () => {
      const update: TelegramUpdate = {
        update_id: 1,
        callback_query: {
          id: "abc",
          from: { id: 1, first_name: "X" },
          inline_message_id: "inline-1",
          data: "x",
        },
      }
      expect(parseTelegramUpdate(ADAPTER_ID, SELF_ID, update)).toBeNull()
    })
  })

  describe("edited_channel_post produces an edit event for channel posts", () => {
    it("returns kind=edit when the update carries edited_channel_post", () => {
      const update: TelegramUpdate = {
        update_id: 2,
        edited_channel_post: {
          message_id: 555,
          chat: { id: -1009999, type: "channel", title: "News" },
          date: 1714900800,
          edit_date: 1714900900,
          text: "Channel edit",
        },
      }
      const r = parseTelegramUpdate(ADAPTER_ID, SELF_ID, update)
      expect(r).not.toBeNull()
      expect(r!.kind).toBe("edit")
      expect(r!.replacesMessageId).toBe("555")
      expect(r!.channel.kind).toBe("channel")
    })
  })
})
