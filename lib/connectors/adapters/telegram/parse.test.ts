import { parseTelegramUpdate, parseTelegramCallbackQuery } from "./parse"
import type { TelegramUpdate, TelegramRichBlock } from "./parse"

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
  const richEvent = (blocks: TelegramRichBlock[]) =>
    parseTelegramUpdate(ADAPTER_ID, SELF_ID, {
      update_id: 123,
      message: {
        message_id: 42,
        date: 1,
        chat: { id: 1, type: "private" },
        rich_message: { blocks },
      },
    })!

  it.each([
    "bold",
    "italic",
    "underline",
    "strikethrough",
    "spoiler",
    "date_time",
    "subscript",
    "superscript",
    "marked",
    "code",
  ])("preserves nested %s rich text without interpreting entity offsets", (type) => {
    const event = richEvent([
      {
        type: "paragraph",
        text: [
          "😀 ",
          {
            type,
            text: [
              { type: "text_mention", text: "Bot", user: { id: Number(SELF_ID) } },
              { type: "text_mention", text: "Bot", user: { id: Number(SELF_ID) } },
            ],
          },
        ],
      },
    ])
    expect(event.plainText).toBe("😀 BotBot")
    expect(event.mentions).toEqual({ selfMentioned: true, users: [SELF_ID] })
  })

  it("keeps rich text semantic targets, inline buttons, and unknown text readable", () => {
    const event = richEvent([
      {
        type: "paragraph",
        text: [
          { type: "email_address", text: "Contact", email_address: "a@example.com" },
          " ",
          { type: "phone_number", text: "Call", phone_number: "+12345" },
          " ",
          { type: "bank_card_number", text: "Card", bank_card_number: "1234" },
          " ",
          { type: "hashtag", text: "#topic" },
          " ",
          { type: "cashtag", text: "$USD" },
          " ",
          { type: "bot_command", text: "/help" },
          " ",
          { type: "anchor", name: "top" },
          " ",
          { type: "anchor_link", text: "Top", anchor_name: "top" },
          " ",
          { type: "mathematical_expression", expression: "y=2x" },
          " ",
          { type: "button", button: { text: "App", web_app: { url: "https://example.com/app" } } },
          " ",
          { type: "future_inline", text: "Retained" },
        ],
      },
    ])
    expect(event.plainText).toBe(
      "Contact (a@example.com) Call (+12345) Card (1234) #topic $USD /help [anchor: top] Top (#top) y=2x App (https://example.com/app) [unsupported rich text: future_inline] Retained"
    )
  })

  it("preserves rich table cells, list labels, references, links, and unknown content", () => {
    const event = richEvent([
      { type: "heading", text: "Report" },
      {
        type: "list",
        items: [
          {
            label: "1.",
            has_checkbox: true,
            is_checked: true,
            blocks: [
              {
                type: "paragraph",
                text: [
                  { type: "url", text: "Docs", url: "https://example.com" },
                  " ",
                  { type: "custom_emoji", alternative_text: "🎉" },
                ],
              },
            ],
          },
        ],
      },
      {
        type: "table",
        cells: [
          [{ text: "Name" }, { text: "Value" }],
          [{ text: "Total" }, { text: "42" }],
        ],
        caption: "Results",
      },
      {
        type: "blockquote",
        blocks: [
          { type: "paragraph", text: { type: "reference", name: "source", text: "Evidence" } },
        ],
        credit: "Author",
      },
      {
        type: "paragraph",
        text: { type: "reference_link", reference_name: "source", text: "Read" },
      },
      { type: "mathematical_expression", expression: "x^2" },
      { type: "anchor", name: "end" },
      { type: "divider" },
      {
        type: "future_widget",
        text: "Future content",
        blocks: [{ type: "paragraph", text: "Nested content" }],
      },
      { type: "future_empty" },
    ])
    expect(event.plainText).toBe(
      [
        "Report",
        "[x] 1.",
        "Docs (https://example.com) 🎉",
        "Name | Value\nTotal | 42",
        "Results",
        "[source: Evidence]",
        "Author",
        "Read [reference: source]",
        "x^2",
        "[anchor: end]",
        "———",
        "[unsupported rich block: future_widget]",
        "Future content",
        "Nested content",
        "[unsupported rich block: future_empty]",
      ].join("\n")
    )
  })

  it.each([
    [
      "animation",
      { animation: { file_id: "animation", width: 10, height: 10, duration: 2 } },
      "video",
    ],
    ["video", { video: { file_id: "video", width: 10, height: 10, duration: 2 } }, "video"],
    ["audio", { audio: { file_id: "audio", title: "Song", duration: 2 } }, "file"],
    ["document", { document: { file_id: "document", file_name: "report.pdf" } }, "file"],
    ["voice_note", { voice_note: { file_id: "voice_note", duration: 2 } }, "voice"],
  ] as const)(
    "retains %s rich media file IDs for the existing enrichment path",
    (type, media, kind) => {
      const event = richEvent([{ type, ...media, caption: { text: "Caption", credit: "Credit" } }])
      expect(event.segments[0]).toMatchObject({ type: kind, url: `tg://file/${type}` })
      expect(event.plainText).toContain("Caption\nCredit")
    }
  )

  it("preserves maps, captions, buttons, and mentions inside nested containers", () => {
    const event = richEvent([
      {
        type: "collage",
        blocks: [
          {
            type: "slideshow",
            blocks: [
              { type: "map", location: { latitude: 1, longitude: 2 }, caption: { text: "Map" } },
              {
                type: "buttons",
                buttons: [
                  { text: "User", url: `tg://user?id=${SELF_ID}` },
                  { text: "Copy", copy_text: { text: "Copy value" } },
                  { text: "Wait", callback_data: "secret", disabled: {} },
                ],
              },
              { type: "expandable_blockquote", text: "Expanded", credit: "A" },
              { type: "pullquote", text: "Quote", credit: "B" },
              { type: "footer", text: "Footer" },
              { type: "thinking", text: "Thinking" },
            ],
          },
        ],
      },
    ])
    expect(event.segments[0]).toMatchObject({ type: "location", lat: 1, lon: 2 })
    for (const content of [
      "Map",
      "User",
      "Copy value",
      "Wait [disabled]",
      "Expanded",
      "Quote",
      "Footer",
      "Thinking",
    ]) {
      expect(event.plainText).toContain(content)
    }
    expect(event.plainText).not.toContain("secret")
    expect(event.mentions).toEqual({ selfMentioned: true, users: [SELF_ID] })
  })

  it("preserves nested rich text, mentions, media, and rich reply snippets", () => {
    const update = {
      update_id: 123,
      message: {
        message_id: 42,
        date: 1,
        chat: { id: 1, type: "private" },
        rich_message: {
          blocks: [
            {
              type: "paragraph",
              text: [
                "Hello ",
                { type: "bold", text: "world" },
                " ",
                { type: "text_mention", text: "Bot", user: { id: Number(SELF_ID) } },
              ],
            },
            {
              type: "details",
              summary: "Photos",
              blocks: [
                {
                  type: "photo",
                  photo: [
                    { file_id: "small", file_unique_id: "s", width: 20, height: 20 },
                    { file_id: "large", file_unique_id: "l", width: 100, height: 100 },
                  ],
                  caption: {
                    text: ["By ", { type: "mention", text: "@alice", username: "alice" }],
                    credit: "Alice",
                  },
                },
              ],
            },
            { type: "pre", language: "js", text: "console.log(1)" },
          ],
        },
        reply_to_message: {
          message_id: 41,
          date: 1,
          chat: { id: 1, type: "private" },
          rich_message: { blocks: [{ type: "paragraph", text: "Original rich message" }] },
        },
      },
    } as TelegramUpdate
    const event = parseTelegramUpdate(ADAPTER_ID, SELF_ID, update)!
    expect(event.segments).toEqual([
      { type: "text", text: "Hello world Bot" },
      { type: "text", text: "\n" },
      { type: "text", text: "Photos" },
      { type: "text", text: "\n" },
      { type: "image", url: "tg://file/large", width: 100, height: 100 },
      { type: "text", text: "\n" },
      { type: "text", text: "By @alice" },
      { type: "text", text: "\n" },
      { type: "text", text: "Alice" },
      { type: "text", text: "\n" },
      { type: "code", language: "js", code: "console.log(1)" },
    ])
    expect(event.mentions).toEqual({ selfMentioned: true, users: [SELF_ID, "@alice"] })
    expect(event.replyTo?.snippet).toBe("Original rich message")
  })

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

    it("carries the parent author so `reply-to-bot` can match exactly", () => {
      expect(result!.replyTo!.parentSenderId).toBe(SELF_ID)
    })

    it("omits parentSenderId when the replied-to message has no `from`", () => {
      const anonymous = structuredClone(update) as TelegramUpdate
      delete (anonymous.message!.reply_to_message as { from?: unknown }).from
      const parsed = parseTelegramUpdate(ADAPTER_ID, SELF_ID, anonymous)
      expect(parsed!.replyTo!.messageId).toBe("999")
      expect(parsed!.replyTo!.parentSenderId).toBeUndefined()
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

  describe("my_chat_member → membership system event", () => {
    const chat = { id: -100, type: "supergroup" as const, title: "Team" }
    const bot = { id: 999, first_name: "Bot", is_bot: true }
    const actor = { id: 7, first_name: "Bob" }

    function membership(
      oldStatus: string,
      newStatus: string,
      extra: Record<string, unknown> = {}
    ): TelegramUpdate {
      return {
        update_id: 1,
        my_chat_member: {
          chat,
          from: actor,
          date: 1700000000,
          old_chat_member: { status: oldStatus, user: bot },
          new_chat_member: { status: newStatus, user: bot, ...extra },
        },
      } as unknown as TelegramUpdate
    }

    it("reports member_added when the bot is added to a group", () => {
      const r = parseTelegramUpdate(ADAPTER_ID, SELF_ID, membership("left", "member"))
      expect(r!.kind).toBe("system")
      expect(r!.systemKind).toBe("member_added")
      // The actor is whoever added the bot, not the bot itself.
      expect(r!.sender.remoteUserId).toBe("7")
      expect(r!.channel.kind).toBe("group")
    })

    it("reports member_added when the bot is promoted straight to admin", () => {
      const r = parseTelegramUpdate(ADAPTER_ID, SELF_ID, membership("kicked", "administrator"))
      expect(r!.systemKind).toBe("member_added")
    })

    it("reports member_removed when the bot is kicked", () => {
      const r = parseTelegramUpdate(ADAPTER_ID, SELF_ID, membership("administrator", "kicked"))
      expect(r!.systemKind).toBe("member_removed")
    })

    it("reports member_removed when the bot leaves", () => {
      const r = parseTelegramUpdate(ADAPTER_ID, SELF_ID, membership("member", "left"))
      expect(r!.systemKind).toBe("member_removed")
    })

    it("treats restricted-but-still-a-member as present", () => {
      // Tightening a restriction is not a leave — it must not fire the
      // removal path, and it must not re-fire the welcome card either.
      expect(
        parseTelegramUpdate(
          ADAPTER_ID,
          SELF_ID,
          membership("member", "restricted", { is_member: true })
        )
      ).toBeNull()
    })

    it("treats restricted-with-is_member-false as a removal", () => {
      const r = parseTelegramUpdate(
        ADAPTER_ID,
        SELF_ID,
        membership("member", "restricted", { is_member: false })
      )
      expect(r!.systemKind).toBe("member_removed")
    })

    it("drops a permission change that does not cross the membership boundary", () => {
      // member → administrator would otherwise welcome the group a second time.
      expect(
        parseTelegramUpdate(ADAPTER_ID, SELF_ID, membership("member", "administrator"))
      ).toBeNull()
      expect(parseTelegramUpdate(ADAPTER_ID, SELF_ID, membership("left", "kicked"))).toBeNull()
    })

    it("gives the same transition the same id so a redelivery cannot welcome twice", () => {
      const first = parseTelegramUpdate(ADAPTER_ID, SELF_ID, membership("left", "member"))
      const again = parseTelegramUpdate(ADAPTER_ID, SELF_ID, membership("left", "member"))
      expect(first!.messageId).toBe(again!.messageId)
    })

    it("carries no message body — it is an audit event, not a turn", () => {
      const r = parseTelegramUpdate(ADAPTER_ID, SELF_ID, membership("left", "member"))
      expect(r!.segments).toEqual([])
      expect(r!.plainText).toBe("")
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
