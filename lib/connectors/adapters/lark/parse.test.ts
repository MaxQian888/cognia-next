import { parseLarkEventEnvelope } from "./parse"
import type { LarkEventEnvelope } from "./parse"

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

    it("conversationRef.threadTs matches thread_id", () => {
      const ref = result!.conversationRef as { threadTs?: string }
      expect(ref.threadTs).toBe("thr_root_001")
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
