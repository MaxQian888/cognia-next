import { parseTelegramUpdate, parseTelegramCallbackQuery } from "./parse"
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

  describe("callback_query is routed through the callback channel (G4)", () => {
    const update = callbackQueryFixture as TelegramUpdate

    it("parseTelegramUpdate returns null — callbacks go through dispatchConnectorCallback", () => {
      // G3.1 moved callback_query off the inbound message path so the
      // adapter can ack the press and dedup via namespace="callback".
      expect(parseTelegramUpdate(ADAPTER_ID, SELF_ID, update)).toBeNull()
    })
  })

  describe("inline-message-only callback_query returns null from both parsers", () => {
    const update: TelegramUpdate = {
      update_id: 1,
      callback_query: {
        id: "abc",
        from: { id: 1, first_name: "X" },
        inline_message_id: "inline-1",
        data: "x",
      },
    }
    it("parseTelegramUpdate returns null", () => {
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

  describe("native media types (G3.1)", () => {
    const baseChat = { id: 1, type: "private" as const, first_name: "Q" }
    const baseFrom = { id: 1, first_name: "Q" }

    it("voice → voice segment with durationSec", () => {
      const u: TelegramUpdate = {
        update_id: 1,
        message: {
          message_id: 10,
          chat: baseChat,
          from: baseFrom,
          date: 1,
          voice: { file_id: "vid_abc", duration: 12 },
        },
      }
      const r = parseTelegramUpdate(ADAPTER_ID, SELF_ID, u)
      expect(r!.segments).toEqual([{ type: "voice", url: "tg://file/vid_abc", durationSec: 12 }])
    })

    it("audio → file segment with friendly name", () => {
      const u: TelegramUpdate = {
        update_id: 1,
        message: {
          message_id: 10,
          chat: baseChat,
          from: baseFrom,
          date: 1,
          audio: { file_id: "aud_1", duration: 100, title: "Song" },
        },
      }
      const r = parseTelegramUpdate(ADAPTER_ID, SELF_ID, u)
      expect(r!.segments[0]).toMatchObject({
        type: "file",
        url: "tg://file/aud_1",
        name: "Song",
      })
    })

    it("video → video segment with thumbnailUrl when thumb present", () => {
      const u: TelegramUpdate = {
        update_id: 1,
        message: {
          message_id: 10,
          chat: baseChat,
          from: baseFrom,
          date: 1,
          video: {
            file_id: "vid_x",
            width: 1280,
            height: 720,
            duration: 30,
            thumb: { file_id: "thumb_x", file_unique_id: "u", width: 320, height: 180 },
          },
        },
      }
      const r = parseTelegramUpdate(ADAPTER_ID, SELF_ID, u)
      expect(r!.segments[0]).toMatchObject({
        type: "video",
        url: "tg://file/vid_x",
        thumbnailUrl: "tg://file/thumb_x",
        durationSec: 30,
      })
    })

    it("video_note → video segment (round avatar recording)", () => {
      const u: TelegramUpdate = {
        update_id: 1,
        message: {
          message_id: 10,
          chat: baseChat,
          from: baseFrom,
          date: 1,
          video_note: { file_id: "vn_1", length: 360, duration: 5 },
        },
      }
      const r = parseTelegramUpdate(ADAPTER_ID, SELF_ID, u)
      expect(r!.segments[0].type).toBe("video")
    })

    it("animation → video segment (GIF / animated WebP)", () => {
      const u: TelegramUpdate = {
        update_id: 1,
        message: {
          message_id: 10,
          chat: baseChat,
          from: baseFrom,
          date: 1,
          animation: { file_id: "anim_1", width: 200, height: 200, duration: 2 },
        },
      }
      const r = parseTelegramUpdate(ADAPTER_ID, SELF_ID, u)
      expect(r!.segments[0].type).toBe("video")
    })

    it("document → file segment with the original file_name", () => {
      const u: TelegramUpdate = {
        update_id: 1,
        message: {
          message_id: 10,
          chat: baseChat,
          from: baseFrom,
          date: 1,
          document: {
            file_id: "doc_1",
            file_name: "report.pdf",
            mime_type: "application/pdf",
            file_size: 1024,
          },
        },
      }
      const r = parseTelegramUpdate(ADAPTER_ID, SELF_ID, u)
      expect(r!.segments[0]).toMatchObject({
        type: "file",
        name: "report.pdf",
        mimeType: "application/pdf",
      })
    })

    it("sticker → emoji segment carrying the sticker emoji", () => {
      const u: TelegramUpdate = {
        update_id: 1,
        message: {
          message_id: 10,
          chat: baseChat,
          from: baseFrom,
          date: 1,
          sticker: { file_id: "stk_1", emoji: "🐱", width: 512, height: 512 },
        },
      }
      const r = parseTelegramUpdate(ADAPTER_ID, SELF_ID, u)
      expect(r!.segments).toEqual([{ type: "emoji", code: "🐱" }])
    })

    it("location → location segment with lat/lon", () => {
      const u: TelegramUpdate = {
        update_id: 1,
        message: {
          message_id: 10,
          chat: baseChat,
          from: baseFrom,
          date: 1,
          location: { latitude: 1.2, longitude: 3.4 },
        },
      }
      const r = parseTelegramUpdate(ADAPTER_ID, SELF_ID, u)
      expect(r!.segments).toEqual([{ type: "location", lat: 1.2, lon: 3.4 }])
    })

    it("contact → text segment with name + phone", () => {
      const u: TelegramUpdate = {
        update_id: 1,
        message: {
          message_id: 10,
          chat: baseChat,
          from: baseFrom,
          date: 1,
          contact: { phone_number: "+1234567890", first_name: "Alice", last_name: "B" },
        },
      }
      const r = parseTelegramUpdate(ADAPTER_ID, SELF_ID, u)
      expect((r!.segments[0] as { text: string }).text).toContain("Alice B")
      expect((r!.segments[0] as { text: string }).text).toContain("+1234567890")
    })

    it("dice → text segment with emoji and value", () => {
      const u: TelegramUpdate = {
        update_id: 1,
        message: {
          message_id: 10,
          chat: baseChat,
          from: baseFrom,
          date: 1,
          dice: { emoji: "🎲", value: 4 },
        },
      }
      const r = parseTelegramUpdate(ADAPTER_ID, SELF_ID, u)
      expect((r!.segments[0] as { text: string }).text).toBe("🎲 (4)")
    })
  })

  describe("message_reaction → system event", () => {
    it("reports reaction_added as systemKind", () => {
      const u: TelegramUpdate = {
        update_id: 1,
        message_reaction: {
          chat: { id: -100, type: "supergroup", title: "Team" },
          message_id: 42,
          user: { id: 7, first_name: "Bob" },
          date: 1700000000,
          old_reaction: [],
          new_reaction: [{ type: "emoji", emoji: "👍" }],
        },
      }
      const r = parseTelegramUpdate(ADAPTER_ID, SELF_ID, u)
      expect(r!.kind).toBe("system")
      expect(r!.systemKind).toBe("reaction_added")
      expect(r!.segments).toEqual([{ type: "emoji", code: "👍" }])
      expect(r!.replacesMessageId).toBe("42")
    })

    it("reports reaction_removed when new_reaction is empty", () => {
      const u: TelegramUpdate = {
        update_id: 1,
        message_reaction: {
          chat: { id: -100, type: "supergroup", title: "Team" },
          message_id: 42,
          user: { id: 7, first_name: "Bob" },
          date: 1700000000,
          old_reaction: [{ type: "emoji", emoji: "👍" }],
          new_reaction: [],
        },
      }
      const r = parseTelegramUpdate(ADAPTER_ID, SELF_ID, u)
      expect(r!.systemKind).toBe("reaction_removed")
    })

    it("returns null when neither old nor new reaction changed", () => {
      const u: TelegramUpdate = {
        update_id: 1,
        message_reaction: {
          chat: { id: -100, type: "supergroup", title: "Team" },
          message_id: 42,
          user: { id: 7, first_name: "Bob" },
          date: 1700000000,
          old_reaction: [{ type: "emoji", emoji: "👍" }],
          new_reaction: [{ type: "emoji", emoji: "👍" }],
        },
      }
      expect(parseTelegramUpdate(ADAPTER_ID, SELF_ID, u)).toBeNull()
    })

    it("falls back to actor_chat for anonymous / channel reactions (audited fix #11)", () => {
      const u: TelegramUpdate = {
        update_id: 1,
        message_reaction: {
          chat: { id: -100, type: "channel", title: "Team" },
          message_id: 42,
          actor_chat: { id: -100200, type: "channel", title: "Anon Channel" },
          date: 1700000000,
          old_reaction: [],
          new_reaction: [{ type: "emoji", emoji: "🔥" }],
        },
      }
      const r = parseTelegramUpdate(ADAPTER_ID, SELF_ID, u)
      expect(r).not.toBeNull()
      expect(r!.systemKind).toBe("reaction_added")
      expect(r!.sender.remoteUserId).toBe("-100200")
      expect(r!.sender.displayName).toBe("Anon Channel")
      expect(r!.messageId).toBe("tgreact:42:-100200:1700000000")
    })

    it("still drops reactions with neither user nor actor_chat", () => {
      const u: TelegramUpdate = {
        update_id: 1,
        message_reaction: {
          chat: { id: -100, type: "supergroup", title: "Team" },
          message_id: 42,
          date: 1700000000,
          old_reaction: [],
          new_reaction: [{ type: "emoji", emoji: "👍" }],
        },
      }
      expect(parseTelegramUpdate(ADAPTER_ID, SELF_ID, u)).toBeNull()
    })
  })

  describe("largest-photo selection (audited fix #10)", () => {
    const baseChat = { id: 1, type: "private" as const, first_name: "Q" }
    const baseFrom = { id: 1, first_name: "Q" }

    it("defaults to the LAST PhotoSize when file_size is absent (small→large order)", () => {
      const u: TelegramUpdate = {
        update_id: 1,
        message: {
          message_id: 10,
          chat: baseChat,
          from: baseFrom,
          date: 1,
          photo: [
            { file_id: "small", file_unique_id: "s", width: 90, height: 60 },
            { file_id: "medium", file_unique_id: "m", width: 320, height: 213 },
            { file_id: "large", file_unique_id: "l", width: 1280, height: 853 },
          ],
        },
      }
      const r = parseTelegramUpdate(ADAPTER_ID, SELF_ID, u)
      expect(r!.segments[0]).toMatchObject({
        type: "image",
        url: "tg://file/large",
        width: 1280,
      })
    })

    it("picks the max file_size when sizes are present", () => {
      const u: TelegramUpdate = {
        update_id: 1,
        message: {
          message_id: 10,
          chat: baseChat,
          from: baseFrom,
          date: 1,
          photo: [
            { file_id: "a", file_unique_id: "a", width: 90, height: 60, file_size: 1000 },
            { file_id: "b", file_unique_id: "b", width: 1280, height: 853, file_size: 90000 },
            { file_id: "c", file_unique_id: "c", width: 320, height: 213, file_size: 5000 },
          ],
        },
      }
      const r = parseTelegramUpdate(ADAPTER_ID, SELF_ID, u)
      expect(r!.segments[0]).toMatchObject({ type: "image", url: "tg://file/b" })
    })
  })
})

describe("parseTelegramCallbackQuery", () => {
  it("projects the press into a ConnectorCallbackEvent for the callback channel", () => {
    const update = callbackQueryFixture as TelegramUpdate
    const cb = parseTelegramCallbackQuery(ADAPTER_ID, SELF_ID, update)
    expect(cb).not.toBeNull()
    expect(cb!.platform).toBe("telegram")
    expect(cb!.adapterId).toBe(ADAPTER_ID)
    expect(cb!.actionType).toBe("button")
    // triggerId prefers the wire data field; falls back to the cq id.
    expect(cb!.triggerId).toBe("option_a")
    expect(cb!.user.remoteUserId).toBe("777777777")
    expect(cb!.originatingMessageId).toBeDefined()
  })

  it("uses tgcq:<callbackId> as triggerId when data is empty", () => {
    const update: TelegramUpdate = {
      update_id: 1,
      callback_query: {
        id: "press-1",
        from: { id: 1, first_name: "X" },
        message: {
          message_id: 9,
          chat: { id: 7, type: "private", first_name: "X" },
          date: 1,
        },
        data: "",
      },
    }
    const cb = parseTelegramCallbackQuery(ADAPTER_ID, SELF_ID, update)
    expect(cb!.triggerId).toBe("tgcq:press-1")
  })

  it("returns null when no message is attached", () => {
    const update: TelegramUpdate = {
      update_id: 1,
      callback_query: { id: "p", from: { id: 1, first_name: "X" }, data: "a" },
    }
    expect(parseTelegramCallbackQuery(ADAPTER_ID, SELF_ID, update)).toBeNull()
  })
})
