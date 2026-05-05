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

  describe("edited_message returns null (Phase 1)", () => {
    const update = editedMessageFixture as TelegramUpdate

    it("returns null for edited_message", () => {
      // TODO (Phase 2): handle edited_message as edit events
      expect(parseTelegramUpdate(ADAPTER_ID, SELF_ID, update)).toBeNull()
    })
  })

  describe("callback_query returns null (Phase 1)", () => {
    const update = callbackQueryFixture as TelegramUpdate

    it("returns null for callback_query", () => {
      // TODO (Phase 2): handle callback_query for interactive button flows
      expect(parseTelegramUpdate(ADAPTER_ID, SELF_ID, update)).toBeNull()
    })
  })
})
