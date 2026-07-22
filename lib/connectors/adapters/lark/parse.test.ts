import { parseLarkEventEnvelope, parseLarkBotMenuEvent, extractTenantKey } from "./parse"
import type { LarkEventEnvelope } from "./parse"
import type { LarkQuickCommand } from "./quick-commands"

import dmTextFixture from "./fixtures/dm-text.json"
import groupMentionFixture from "./fixtures/group-mention.json"
import replyThreadFixture from "./fixtures/reply-thread.json"
import imageMessageFixture from "./fixtures/image-message.json"

const ADAPTER_ID = "lark-adapter-1"
const SELF_BOT_OPEN_ID = "ou_bot_self_001"

describe("parseLarkEventEnvelope", () => {
  describe("dm-text.json — p2p text message", () => {
    const envelope = dmTextFixture as LarkEventEnvelope
    const result = parseLarkEventEnvelope(ADAPTER_ID, SELF_BOT_OPEN_ID, envelope)

    it("returns a non-null event", () => {
      expect(result).not.toBeNull()
    })

    it("maps platform to lark", () => {
      expect(result!.platform).toBe("lark")
    })

    it("maps messageId from message.message_id", () => {
      expect(result!.messageId).toBe("om_dm_001")
    })

    it("builds conversationKey for the chat_id (no thread)", () => {
      expect(result!.conversationKey).toBe(`lark:${ADAPTER_ID}:oc_dm_chat_001`)
    })

    it("channel kind is private for p2p chat", () => {
      expect(result!.channel.kind).toBe("private")
    })

    it("builds sender identity with lark: prefix from open_id", () => {
      expect(result!.sender.id).toBe("lark:ou_user_001")
      expect(result!.sender.platform).toBe("lark")
      expect(result!.sender.remoteUserId).toBe("ou_user_001")
      expect(result!.sender.kind).toBe("human")
    })

    it("produces a text segment from content.text", () => {
      expect(result!.segments).toEqual([{ type: "text", text: "Hello, bot!" }])
    })

    it("plainText matches content.text", () => {
      expect(result!.plainText).toBe("Hello, bot!")
    })

    it("no self mention detected (bot not in mentions)", () => {
      expect(result!.mentions.selfMentioned).toBe(false)
    })

    it("timestamp is parsed from create_time", () => {
      expect(result!.timestamp).toBe(1714900000000)
    })
  })

  describe("group-mention.json — group message mentioning bot", () => {
    const envelope = groupMentionFixture as LarkEventEnvelope
    const result = parseLarkEventEnvelope(ADAPTER_ID, SELF_BOT_OPEN_ID, envelope)

    it("returns a non-null event", () => {
      expect(result).not.toBeNull()
    })

    it("channel kind is group for group chat", () => {
      expect(result!.channel.kind).toBe("group")
    })

    it("selfMentioned is true when bot open_id is in mentions", () => {
      expect(result!.mentions.selfMentioned).toBe(true)
    })

    it("mentions.users contains the bot open_id", () => {
      expect(result!.mentions.users).toContain(SELF_BOT_OPEN_ID)
    })
  })

  describe("reply-thread.json — message inside a thread", () => {
    const envelope = replyThreadFixture as LarkEventEnvelope
    const result = parseLarkEventEnvelope(ADAPTER_ID, SELF_BOT_OPEN_ID, envelope)

    it("returns a non-null event", () => {
      expect(result).not.toBeNull()
    })

    it("channel kind is thread when thread_id present", () => {
      expect(result!.channel.kind).toBe("thread")
    })

    it("conversationKey includes thread_id", () => {
      expect(result!.conversationKey).toBe(`lark:${ADAPTER_ID}:oc_group_chat_002:thr_root_001`)
    })

    it("carries an explicit topic address so core code never parses the key", () => {
      expect(result!.conversationAddress).toEqual({
        conversationKey: `lark:${ADAPTER_ID}:oc_group_chat_002:thr_root_001`,
        platform: "lark",
        adapterId: ADAPTER_ID,
        scopeKind: "thread",
        containerId: "oc_group_chat_002",
        topicId: "thr_root_001",
      })
    })

    it("conversationRef.threadTs matches thread_id", () => {
      const ref = result!.conversationRef as { threadTs?: string }
      expect(ref.threadTs).toBe("thr_root_001")
    })

    it("carries the in-thread message id as the reply anchor (threadRootMessageId)", () => {
      // serialize.ts routes thread sends through /im/v1/messages/:id/reply —
      // that endpoint needs an om_ message id, not the thread_id.
      const ref = result!.conversationRef as { threadRootMessageId?: string }
      expect(ref.threadRootMessageId).toBe("om_thr_001")
    })
  })

  describe("non-thread messages carry no thread anchor", () => {
    it("dm-text.json has no threadRootMessageId on the ref", () => {
      const r = parseLarkEventEnvelope(
        ADAPTER_ID,
        SELF_BOT_OPEN_ID,
        dmTextFixture as LarkEventEnvelope
      )
      const ref = r!.conversationRef as { threadRootMessageId?: string }
      expect(ref.threadRootMessageId).toBeUndefined()
    })
  })

  describe("image-message.json — image message type", () => {
    const envelope = imageMessageFixture as LarkEventEnvelope
    const result = parseLarkEventEnvelope(ADAPTER_ID, SELF_BOT_OPEN_ID, envelope)

    it("returns a non-null event", () => {
      expect(result).not.toBeNull()
    })

    it("produces an image segment with image_key as url", () => {
      expect(result!.segments[0]).toMatchObject({
        type: "image",
        url: "img_v3_abc123",
      })
    })
  })

  describe("rich-media message types (Phase 2 ingestion)", () => {
    const receive = (messageType: string, content: unknown): LarkEventEnvelope => ({
      schema: "2.0",
      header: { event_id: "evt_rm", event_type: "im.message.receive_v1", app_id: "cli_app" },
      event: {
        sender: { sender_id: { open_id: "ou_user_rm" } },
        message: {
          message_id: "om_rm",
          chat_id: "oc_rm",
          chat_type: "group",
          message_type: messageType,
          content: JSON.stringify(content),
        },
      },
    })

    it("attributes application senders as bots", () => {
      const envelope = receive("text", { text: "automated" })
      envelope.event!.sender = {
        sender_id: { open_id: "ou_other_bot" },
        sender_type: "bot",
      }
      expect(parseLarkEventEnvelope(ADAPTER_ID, SELF_BOT_OPEN_ID, envelope)?.sender.kind).toBe(
        "bot"
      )
    })

    it("file → file segment with key, name, mime, sizeBytes", () => {
      const r = parseLarkEventEnvelope(
        ADAPTER_ID,
        SELF_BOT_OPEN_ID,
        receive("file", { file_key: "file_v3_x", file_name: "report.pdf" })
      )
      expect(r!.segments[0]).toEqual({
        type: "file",
        url: "file_v3_x",
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 0,
      })
      expect(r!.plainText).toContain("[file:report.pdf]")
    })

    it("audio → voice segment with duration in seconds", () => {
      const r = parseLarkEventEnvelope(
        ADAPTER_ID,
        SELF_BOT_OPEN_ID,
        receive("audio", { file_key: "file_v3_a", duration: 3000 })
      )
      expect(r!.segments[0]).toEqual({ type: "voice", url: "file_v3_a", durationSec: 3 })
    })

    it("media → video segment with cover thumbnail + duration", () => {
      const r = parseLarkEventEnvelope(
        ADAPTER_ID,
        SELF_BOT_OPEN_ID,
        receive("media", { file_key: "file_v3_v", image_key: "img_cover", duration: 8000 })
      )
      expect(r!.segments[0]).toEqual({
        type: "video",
        url: "file_v3_v",
        thumbnailUrl: "img_cover",
        durationSec: 8,
      })
    })

    it("sticker → text marker", () => {
      const r = parseLarkEventEnvelope(
        ADAPTER_ID,
        SELF_BOT_OPEN_ID,
        receive("sticker", { file_key: "stk_1" })
      )
      expect(r!.segments[0]).toEqual({ type: "text", text: "[sticker]" })
    })

    it("post (locale-wrapped) → markdown text + embedded image segments", () => {
      const content = {
        zh_cn: {
          title: "标题",
          content: [
            [
              { tag: "text", text: "看这个 " },
              { tag: "a", text: "链接", href: "https://x.test" },
              { tag: "at", user_id: "ou_a", user_name: "Alice" },
            ],
            [{ tag: "img", image_key: "img_in_post" }],
          ],
        },
      }
      const r = parseLarkEventEnvelope(ADAPTER_ID, SELF_BOT_OPEN_ID, receive("post", content))
      expect(r!.segments[0]).toEqual({
        type: "markdown",
        md: "标题\n看这个 链接 (https://x.test)@Alice",
      })
      expect(r!.segments[1]).toEqual({ type: "image", url: "img_in_post", alt: "image" })
    })

    it("post (already-unwrapped {title,content}) → markdown text", () => {
      const content = { title: "T", content: [[{ tag: "text", text: "body" }]] }
      const r = parseLarkEventEnvelope(ADAPTER_ID, SELF_BOT_OPEN_ID, receive("post", content))
      expect(r!.segments[0]).toEqual({ type: "markdown", md: "T\nbody" })
    })

    // Previously these types fell through to empty segments/plainText and
    // could trigger an AI turn on nothing in p2p — each now keeps a marker.
    it("share_chat → '[shared chat: …]' marker", () => {
      const r = parseLarkEventEnvelope(
        ADAPTER_ID,
        SELF_BOT_OPEN_ID,
        receive("share_chat", { chat_id: "oc_shared_123" })
      )
      expect(r!.segments).toEqual([{ type: "text", text: "[shared chat: oc_shared_123]" }])
      expect(r!.plainText).toBe("[shared chat: oc_shared_123]")
    })

    it("share_user → '[shared user: …]' marker", () => {
      const r = parseLarkEventEnvelope(
        ADAPTER_ID,
        SELF_BOT_OPEN_ID,
        receive("share_user", { user_id: "ou_shared_9" })
      )
      expect(r!.segments).toEqual([{ type: "text", text: "[shared user: ou_shared_9]" }])
    })

    it("location → typed location segment with non-empty plainText", () => {
      const r = parseLarkEventEnvelope(
        ADAPTER_ID,
        SELF_BOT_OPEN_ID,
        receive("location", { name: "Company HQ", latitude: "39.90", longitude: "116.40" })
      )
      expect(r!.segments[0]).toEqual({
        type: "location",
        lat: 39.9,
        lon: 116.4,
        name: "Company HQ",
      })
      expect(r!.plainText).toContain("Company HQ")
    })

    it("todo → '[todo: …]' marker", () => {
      const r = parseLarkEventEnvelope(
        ADAPTER_ID,
        SELF_BOT_OPEN_ID,
        receive("todo", { task_id: "task_abc" })
      )
      expect(r!.segments).toEqual([{ type: "text", text: "[todo: task_abc]" }])
    })

    it("calendar / share_calendar_event → '[calendar event: …]' marker", () => {
      for (const type of ["calendar", "share_calendar_event"]) {
        const r = parseLarkEventEnvelope(
          ADAPTER_ID,
          SELF_BOT_OPEN_ID,
          receive(type, { summary: "Weekly sync" })
        )
        expect(r!.segments).toEqual([{ type: "text", text: "[calendar event: Weekly sync]" }])
      }
    })

    it("system message type → null (content-less; must not trigger an AI turn)", () => {
      const r = parseLarkEventEnvelope(
        ADAPTER_ID,
        SELF_BOT_OPEN_ID,
        receive("system", { template: "{from_user} invited {to_chatters}." })
      )
      expect(r).toBeNull()
    })
  })

  describe("inbound mention placeholder substitution", () => {
    it("replaces @_user_N keys with @<display name> in the text segment", () => {
      const envelope: LarkEventEnvelope = {
        schema: "2.0",
        header: { event_id: "evt_m", event_type: "im.message.receive_v1" },
        event: {
          sender: { sender_id: { open_id: "ou_user_m" } },
          message: {
            message_id: "om_m",
            chat_id: "oc_m",
            chat_type: "group",
            message_type: "text",
            content: JSON.stringify({ text: "@_user_1 please review, cc @_user_2" }),
            mentions: [
              { key: "@_user_1", id: { open_id: SELF_BOT_OPEN_ID }, name: "Cognia Bot" },
              { key: "@_user_2", id: { open_id: "ou_alice" }, name: "Alice" },
            ],
          },
        },
      }
      const r = parseLarkEventEnvelope(ADAPTER_ID, SELF_BOT_OPEN_ID, envelope)
      expect(r!.plainText).toBe("@Cognia Bot please review, cc @Alice")
      // Mention detection is unaffected by the substitution.
      expect(r!.mentions.selfMentioned).toBe(true)
    })

    it("leaves the raw key when the mention carries no name", () => {
      const envelope: LarkEventEnvelope = {
        schema: "2.0",
        header: { event_id: "evt_m2", event_type: "im.message.receive_v1" },
        event: {
          sender: { sender_id: { open_id: "ou_user_m" } },
          message: {
            message_id: "om_m2",
            chat_id: "oc_m",
            chat_type: "group",
            message_type: "text",
            content: JSON.stringify({ text: "@_user_1 hi" }),
            mentions: [{ key: "@_user_1", id: { open_id: "ou_x" } }],
          },
        },
      }
      const r = parseLarkEventEnvelope(ADAPTER_ID, SELF_BOT_OPEN_ID, envelope)
      expect(r!.plainText).toBe("@_user_1 hi")
    })
  })

  describe("unsupported event types", () => {
    it("returns null for im.message.read_v1 (legacy event name)", () => {
      const envelope: LarkEventEnvelope = {
        schema: "2.0",
        header: {
          event_id: "evt_read_001",
          event_type: "im.message.read_v1",
          app_id: "cli_app_001",
        },
        event: {
          sender: { sender_id: { open_id: "ou_user_x" } },
          message: {
            message_id: "om_x",
            chat_id: "oc_x",
            chat_type: "p2p",
            message_type: "text",
            content: '{"text":"x"}',
          },
        },
      }
      expect(parseLarkEventEnvelope(ADAPTER_ID, SELF_BOT_OPEN_ID, envelope)).toBeNull()
    })

    it("returns null for p2p.chat.create", () => {
      const envelope: LarkEventEnvelope = {
        schema: "2.0",
        header: {
          event_id: "evt_chat_create",
          event_type: "p2p.chat.create",
          app_id: "cli_app_001",
        },
        event: {
          sender: { sender_id: { open_id: "ou_user_x" } },
          message: {
            message_id: "om_y",
            chat_id: "oc_y",
            chat_type: "p2p",
            message_type: "text",
            content: '{"text":"y"}',
          },
        },
      }
      expect(parseLarkEventEnvelope(ADAPTER_ID, SELF_BOT_OPEN_ID, envelope)).toBeNull()
    })
  })

  describe("im.message.message_read_v1 produces a system read_indicator event", () => {
    it("emits kind=system / systemKind=read_indicator with the reader's open_id", () => {
      const envelope: LarkEventEnvelope = {
        schema: "2.0",
        header: {
          event_id: "evt_read_real",
          event_type: "im.message.message_read_v1",
          app_id: "cli_app_001",
        },
        event: {
          reader: {
            reader_id: { open_id: "ou_reader_001" },
            read_time: "1714900100",
          },
          message_id_list: ["om_msg_001", "om_msg_002"],
        },
      }
      const r = parseLarkEventEnvelope(ADAPTER_ID, SELF_BOT_OPEN_ID, envelope)
      expect(r).not.toBeNull()
      expect(r!.kind).toBe("system")
      expect(r!.systemKind).toBe("read_indicator")
      expect(r!.sender.remoteUserId).toBe("ou_reader_001")
      expect(r!.segments).toEqual([])
    })

    it("returns null when message_id_list is empty", () => {
      const envelope: LarkEventEnvelope = {
        schema: "2.0",
        header: {
          event_id: "evt_read_empty",
          event_type: "im.message.message_read_v1",
        },
        event: {
          reader: { reader_id: { open_id: "ou_x" } },
          message_id_list: [],
        },
      }
      expect(parseLarkEventEnvelope(ADAPTER_ID, SELF_BOT_OPEN_ID, envelope)).toBeNull()
    })
  })

  describe("im.message.reaction.{created,deleted}_v1 produce system reaction events", () => {
    it("created_v1 emits kind=system / systemKind=reaction_added with the operator's open_id", () => {
      const envelope: LarkEventEnvelope = {
        schema: "2.0",
        header: {
          event_id: "evt_react_add",
          event_type: "im.message.reaction.created_v1",
          app_id: "cli_app_001",
        },
        event: {
          message_id: "om_reacted_msg",
          reaction_type: { emoji_type: "THUMBSUP" },
          operator_type: "user",
          user_id: { open_id: "ou_reactor_001" },
          action_time: "1714900300000",
        },
      }
      const r = parseLarkEventEnvelope(ADAPTER_ID, SELF_BOT_OPEN_ID, envelope)
      expect(r).not.toBeNull()
      expect(r!.kind).toBe("system")
      expect(r!.systemKind).toBe("reaction_added")
      expect(r!.sender.remoteUserId).toBe("ou_reactor_001")
      expect(r!.messageId).toContain("THUMBSUP")
      expect(r!.segments).toEqual([])
    })

    it("deleted_v1 emits systemKind=reaction_removed", () => {
      const envelope: LarkEventEnvelope = {
        schema: "2.0",
        header: {
          event_id: "evt_react_del",
          event_type: "im.message.reaction.deleted_v1",
        },
        event: {
          message_id: "om_reacted_msg",
          reaction_type: { emoji_type: "SMILE" },
          operator_type: "user",
          user_id: { open_id: "ou_reactor_002" },
        },
      }
      const r = parseLarkEventEnvelope(ADAPTER_ID, SELF_BOT_OPEN_ID, envelope)
      expect(r!.systemKind).toBe("reaction_removed")
    })

    it("returns null when message_id is missing", () => {
      const envelope: LarkEventEnvelope = {
        schema: "2.0",
        header: {
          event_id: "evt_react_bad",
          event_type: "im.message.reaction.created_v1",
        },
        event: { reaction_type: { emoji_type: "SMILE" } },
      }
      expect(parseLarkEventEnvelope(ADAPTER_ID, SELF_BOT_OPEN_ID, envelope)).toBeNull()
    })
  })

  describe("im.message.recalled_v1 produces a delete event", () => {
    it("emits kind=delete with replacesMessageId set", () => {
      const envelope: LarkEventEnvelope = {
        schema: "2.0",
        header: {
          event_id: "evt_recall_001",
          event_type: "im.message.recalled_v1",
        },
        event: {
          message_id: "om_recall_target",
          chat_id: "oc_chat_x",
          recall_time: "1714900200",
        },
      }
      const r = parseLarkEventEnvelope(ADAPTER_ID, SELF_BOT_OPEN_ID, envelope)
      expect(r).not.toBeNull()
      expect(r!.kind).toBe("delete")
      expect(r!.replacesMessageId).toBe("om_recall_target")
      expect(r!.timestamp).toBe(1714900200)
    })

    it("returns null when chat_id or message_id is missing", () => {
      const envelope: LarkEventEnvelope = {
        schema: "2.0",
        header: {
          event_id: "evt_recall_bad",
          event_type: "im.message.recalled_v1",
        },
        event: { recall_time: "1" },
      }
      expect(parseLarkEventEnvelope(ADAPTER_ID, SELF_BOT_OPEN_ID, envelope)).toBeNull()
    })
  })

  describe("member-change events produce system events", () => {
    it("im.chat.member.user.added_v1 → systemKind=member_added", () => {
      const envelope: LarkEventEnvelope = {
        schema: "2.0",
        header: {
          event_id: "evt_user_add",
          event_type: "im.chat.member.user.added_v1",
        },
        event: {
          chat_id: "oc_team_001",
          operator_id: { open_id: "ou_admin" },
          users: [{ user_id: { open_id: "ou_new" }, name: "Newcomer" }],
        },
      }
      const r = parseLarkEventEnvelope(ADAPTER_ID, SELF_BOT_OPEN_ID, envelope)
      expect(r).not.toBeNull()
      expect(r!.kind).toBe("system")
      expect(r!.systemKind).toBe("member_added")
      expect(r!.sender.remoteUserId).toBe("ou_admin")
    })

    it("im.chat.member.bot.deleted_v1 → systemKind=member_removed", () => {
      const envelope: LarkEventEnvelope = {
        schema: "2.0",
        header: {
          event_id: "evt_bot_del",
          event_type: "im.chat.member.bot.deleted_v1",
        },
        event: { chat_id: "oc_team_001" },
      }
      const r = parseLarkEventEnvelope(ADAPTER_ID, SELF_BOT_OPEN_ID, envelope)
      expect(r).not.toBeNull()
      expect(r!.kind).toBe("system")
      expect(r!.systemKind).toBe("member_removed")
    })
  })
})

describe("parseLarkBotMenuEvent — application.bot.menu_v6", () => {
  const QUICK_COMMANDS: LarkQuickCommand[] = [
    { triggerKey: "agenda", label: "今日日程", action: { type: "slash", value: "/agenda today" } },
  ]

  function menuEnvelope(
    eventKey: string | undefined,
    openId: string | undefined
  ): LarkEventEnvelope {
    return {
      schema: "2.0",
      header: { event_id: "evt_menu_1", event_type: "application.bot.menu_v6" },
      event: {
        ...(openId ? { operator: { operator_id: { open_id: openId } } } : {}),
        ...(eventKey ? { event_key: eventKey } : {}),
      },
    } as unknown as LarkEventEnvelope
  }

  it("maps a configured event_key to its action value as a p2p create event", () => {
    const r = parseLarkBotMenuEvent(
      ADAPTER_ID,
      SELF_BOT_OPEN_ID,
      menuEnvelope("agenda", "ou_user_001"),
      QUICK_COMMANDS
    )
    expect(r).not.toBeNull()
    expect(r!.kind).toBe("create")
    expect(r!.plainText).toBe("/agenda today")
    expect(r!.segments).toEqual([{ type: "text", text: "/agenda today" }])
    expect(r!.channel.kind).toBe("private")
    // Reply must address the operator p2p by open_id (ou_ prefix sniff).
    expect(r!.conversationRef.channelId).toBe("ou_user_001")
    expect(r!.conversationKey).toBe(`lark:${ADAPTER_ID}:ou_user_001`)
    expect(r!.messageId).toBe("lark.menu:evt_menu_1")
  })

  it("falls back to the raw event_key when unmapped (never silently dropped)", () => {
    const r = parseLarkBotMenuEvent(
      ADAPTER_ID,
      SELF_BOT_OPEN_ID,
      menuEnvelope("unknown_key", "ou_user_001"),
      QUICK_COMMANDS
    )
    expect(r).not.toBeNull()
    expect(r!.plainText).toBe("unknown_key")
  })

  it("returns null for non-menu events", () => {
    const r = parseLarkBotMenuEvent(
      ADAPTER_ID,
      SELF_BOT_OPEN_ID,
      dmTextFixture as LarkEventEnvelope,
      QUICK_COMMANDS
    )
    expect(r).toBeNull()
  })

  it("returns null when operator open_id or event_key is absent", () => {
    expect(
      parseLarkBotMenuEvent(
        ADAPTER_ID,
        SELF_BOT_OPEN_ID,
        menuEnvelope("agenda", undefined),
        QUICK_COMMANDS
      )
    ).toBeNull()
    expect(
      parseLarkBotMenuEvent(
        ADAPTER_ID,
        SELF_BOT_OPEN_ID,
        menuEnvelope(undefined, "ou_user_001"),
        QUICK_COMMANDS
      )
    ).toBeNull()
  })
})

describe("history-list mentions (flat id + id_type) — fetchHistory reprojection", () => {
  // `/im/v1/messages` list items flatten the mention identity to a plain
  // string discriminated by `id_type` (live events nest `{ open_id }`).
  // fetchHistory wraps raw list items in synthetic receive_v1 envelopes, so
  // the parser must accept both shapes or history events lose mentions.
  const envelope = {
    schema: "2.0",
    header: { event_id: "hist:om_hist_001", event_type: "im.message.receive_v1" },
    event: {
      sender: { sender_id: { open_id: "ou_user_001" } },
      message: {
        message_id: "om_hist_001",
        chat_id: "oc_group_chat_001",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "@Bot please look at this" }),
        create_time: "1714900000000",
        mentions: [
          { key: "@_user_1", id: "ou_bot_self_001", id_type: "open_id", name: "Bot" },
          // user_id-typed mentions cannot be compared against the bot's
          // open_id — they must be dropped, not misclassified.
          { key: "@_user_2", id: "uid_someone", id_type: "user_id", name: "Someone" },
        ],
      },
    },
  } as unknown as LarkEventEnvelope
  const result = parseLarkEventEnvelope(ADAPTER_ID, SELF_BOT_OPEN_ID, envelope)

  it("returns a non-null event", () => {
    expect(result).not.toBeNull()
  })

  it("detects the bot self-mention from the flat open_id shape", () => {
    expect(result!.mentions.selfMentioned).toBe(true)
    expect(result!.mentions.users).toContain(SELF_BOT_OPEN_ID)
  })

  it("drops non-open_id-typed flat mentions instead of misclassifying them", () => {
    expect(result!.mentions.users).not.toContain("uid_someone")
  })
})

describe("extractTenantKey", () => {
  const base = { event_id: "e1", event_type: "im.message.receive_v1" }

  it("reads the 2.0 header tenant_key", () => {
    const env = { header: { ...base, tenant_key: "tk_hdr" }, event: {} } as LarkEventEnvelope
    expect(extractTenantKey(env)).toBe("tk_hdr")
  })

  it("falls back to sender.tenant_key when the header lacks it", () => {
    const env = {
      header: base,
      event: { sender: { sender_id: { open_id: "ou_u" }, tenant_key: "tk_sender" } },
    } as LarkEventEnvelope
    expect(extractTenantKey(env)).toBe("tk_sender")
  })

  it("falls back to reader.tenant_key (read indicators)", () => {
    const env = {
      header: base,
      event: { reader: { tenant_key: "tk_reader" } },
    } as LarkEventEnvelope
    expect(extractTenantKey(env)).toBe("tk_reader")
  })

  it("prefers the header over nested fallbacks", () => {
    const env = {
      header: { ...base, tenant_key: "tk_hdr" },
      event: { sender: { sender_id: { open_id: "ou_u" }, tenant_key: "tk_sender" } },
    } as LarkEventEnvelope
    expect(extractTenantKey(env)).toBe("tk_hdr")
  })

  it("returns undefined when no tenant_key is present anywhere", () => {
    const env = { header: base, event: {} } as LarkEventEnvelope
    expect(extractTenantKey(env)).toBeUndefined()
  })
})
