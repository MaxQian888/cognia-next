import { parseSlackEventCallback, parseSlackSlashCommand } from "./parse"
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

    it("preserves the workspace team id for channel-native streams", () => {
      expect(result!.conversationRef.teamId).toBe(envelope.team_id)
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

    it("surfaces the thread parent as replyTo (quote → issue needs the id)", () => {
      expect(result!.replyTo).toEqual({ messageId: "1714900000.000100", snippet: "" })
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

  describe("message_changed (edit)", () => {
    const envelope: SlackEventEnvelope = {
      type: "event_callback",
      event: {
        type: "message",
        channel: "C123CHANNEL",
        channel_type: "channel",
        ts: "1714900005.000200",
        subtype: "message_changed",
        message: {
          type: "message",
          channel: "C123CHANNEL",
          user: "U222USER",
          text: "edited text",
          ts: "1714900000.000100",
        },
        previous_message: {
          type: "message",
          channel: "C123CHANNEL",
          user: "U222USER",
          text: "original text",
          ts: "1714900000.000100",
        },
      },
    }
    const result = parseSlackEventCallback(ADAPTER_ID, SELF_ID, envelope)

    it("returns a non-null event", () => {
      expect(result).not.toBeNull()
    })

    it("kind is edit", () => {
      expect(result!.kind).toBe("edit")
    })

    it("replacesMessageId is the original ts", () => {
      expect(result!.replacesMessageId).toBe("1714900000.000100")
    })

    it("messageId matches the original ts (the one being edited)", () => {
      expect(result!.messageId).toBe("1714900000.000100")
    })

    it("segments carry the updated text", () => {
      expect(result!.segments).toEqual([{ type: "text", text: "edited text" }])
    })

    it("sender is preserved from the updated message", () => {
      expect(result!.sender.remoteUserId).toBe("U222USER")
    })

    it("timestamp comes from the event ts (when the edit happened)", () => {
      expect(result!.timestamp).toBe(1714900005000)
    })
  })

  describe("message_deleted (delete)", () => {
    const envelope: SlackEventEnvelope = {
      type: "event_callback",
      event: {
        type: "message",
        channel: "C123CHANNEL",
        channel_type: "channel",
        ts: "1714900010.000300",
        subtype: "message_deleted",
        deleted_ts: "1714900000.000100",
        previous_message: {
          type: "message",
          channel: "C123CHANNEL",
          user: "U222USER",
          text: "original",
          ts: "1714900000.000100",
        },
      },
    }
    const result = parseSlackEventCallback(ADAPTER_ID, SELF_ID, envelope)

    it("returns a non-null event", () => {
      expect(result).not.toBeNull()
    })

    it("kind is delete", () => {
      expect(result!.kind).toBe("delete")
    })

    it("replacesMessageId is the deleted_ts", () => {
      expect(result!.replacesMessageId).toBe("1714900000.000100")
    })

    it("messageId matches deleted_ts", () => {
      expect(result!.messageId).toBe("1714900000.000100")
    })

    it("segments are empty (no payload on delete)", () => {
      expect(result!.segments).toEqual([])
    })

    it("sender is recovered from previous_message", () => {
      expect(result!.sender.remoteUserId).toBe("U222USER")
    })

    it("returns null when deleted_ts is missing", () => {
      const bad: SlackEventEnvelope = {
        type: "event_callback",
        event: {
          type: "message",
          channel: "C123",
          ts: "1714900010.000300",
          subtype: "message_deleted",
        },
      }
      expect(parseSlackEventCallback(ADAPTER_ID, SELF_ID, bad)).toBeNull()
    })
  })

  describe("self-echo guard", () => {
    function messageEnvelope(event: Partial<SlackEventEnvelope["event"]>): SlackEventEnvelope {
      return {
        type: "event_callback",
        event: {
          type: "message",
          channel: "C123",
          text: "hi",
          ts: "1714900100.000001",
          channel_type: "channel",
          user: "U222USER",
          ...event,
        } as SlackEventEnvelope["event"],
      }
    }

    it("drops messages carrying bot_id (bot-authored, any subtype)", () => {
      const envelope = messageEnvelope({ bot_id: "B0BOT" })
      expect(parseSlackEventCallback(ADAPTER_ID, SELF_ID, envelope)).toBeNull()
    })

    it("drops messages authored by the bot's own user id", () => {
      const envelope = messageEnvelope({ user: SELF_ID })
      expect(parseSlackEventCallback(ADAPTER_ID, SELF_ID, envelope)).toBeNull()
    })

    it("does NOT drop user messages when selfId is empty (failed auth.test probe)", () => {
      const envelope = messageEnvelope({ user: "U222USER" })
      const result = parseSlackEventCallback(ADAPTER_ID, "", envelope)
      expect(result).not.toBeNull()
      expect(result!.sender.remoteUserId).toBe("U222USER")
    })
  })

  describe("subtype whitelist", () => {
    function subtypeEnvelope(subtype?: string): SlackEventEnvelope {
      return {
        type: "event_callback",
        event: {
          type: "message",
          channel: "C123",
          user: "U222USER",
          text: "content",
          ts: "1714900200.000001",
          channel_type: "channel",
          ...(subtype ? { subtype } : {}),
        },
      }
    }

    it.each(["file_share", "thread_broadcast", "me_message"])(
      "passes user-content subtype %s",
      (subtype) => {
        expect(
          parseSlackEventCallback(ADAPTER_ID, SELF_ID, subtypeEnvelope(subtype))
        ).not.toBeNull()
      }
    )

    it.each([
      "channel_join",
      "channel_leave",
      "channel_topic",
      "channel_purpose",
      "channel_name",
      "channel_archive",
      "group_join",
    ])("drops system subtype %s", (subtype) => {
      expect(parseSlackEventCallback(ADAPTER_ID, SELF_ID, subtypeEnvelope(subtype))).toBeNull()
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

    it("returns null for malformed message_changed (missing nested message)", () => {
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

describe("parseSlackSlashCommand", () => {
  const payload = {
    command: "/cognia",
    text: "summarize today",
    channel_id: "C0CMD",
    user_id: "U0CMD",
    user_name: "erin",
    trigger_id: "trig-99",
  }

  it("projects the invocation into a normalized text event", () => {
    const event = parseSlackSlashCommand(ADAPTER_ID, SELF_ID, payload)
    expect(event).not.toBeNull()
    expect(event!.platform).toBe("slack")
    expect(event!.plainText).toBe("/cognia summarize today")
    expect(event!.segments).toEqual([{ type: "text", text: "/cognia summarize today" }])
    expect(event!.messageId).toBe("trig-99")
    expect(event!.conversationKey).toBe(`slack:${ADAPTER_ID}:C0CMD`)
    expect(event!.sender.remoteUserId).toBe("U0CMD")
    expect(event!.sender.displayName).toBe("erin")
    // A slash command is an explicit invocation of this bot.
    expect(event!.mentions.selfMentioned).toBe(true)
  })

  it("handles a command with no text", () => {
    const event = parseSlackSlashCommand(ADAPTER_ID, SELF_ID, { ...payload, text: undefined })
    expect(event!.plainText).toBe("/cognia")
  })

  it("synthesizes a messageId when trigger_id is absent", () => {
    const event = parseSlackSlashCommand(ADAPTER_ID, SELF_ID, {
      ...payload,
      trigger_id: undefined,
    })
    expect(event!.messageId).toMatch(/^slash-\d+$/)
  })

  it("returns null when required fields are missing", () => {
    expect(parseSlackSlashCommand(ADAPTER_ID, SELF_ID, { ...payload, command: "" })).toBeNull()
    expect(parseSlackSlashCommand(ADAPTER_ID, SELF_ID, { ...payload, channel_id: "" })).toBeNull()
    expect(parseSlackSlashCommand(ADAPTER_ID, SELF_ID, { ...payload, user_id: "" })).toBeNull()
  })
})
