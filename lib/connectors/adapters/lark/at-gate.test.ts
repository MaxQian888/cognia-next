/**
 * Coverage for the Lark inbound at-gate.
 *
 * Each spec constructs a minimal `NormalizedInboundEvent` + adapter row
 * pair and asserts the decision shape (`allowed` + `reason`). DM bypass
 * is the most important property — without it, `mention_only` (the
 * default) would silently break every 1:1 chat the bot is invited into.
 */

import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import {
  DEFAULT_AT_RESPONSE_STRATEGY,
  shouldRespondToMessage,
  type AtResponseStrategy,
} from "./at-gate"

function makeAdapter(overrides: Partial<AdapterInstanceRow> = {}): AdapterInstanceRow {
  return {
    id: "lark-1",
    type: "lark",
    displayName: "Lark",
    enabled: true,
    transportMode: "webhook",
    settings: {},
    credentialsRef: { keyringService: "com.cognia.platforms", accounts: [] },
    trigger: {
      rules: [{ kind: "private-default" }],
      blockers: [],
      storeUnmatchedInDraftMode: false,
    },
    defaultMode: "auto",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

function makeEvent(
  overrides: Partial<NormalizedInboundEvent> = {},
  channelKind: "private" | "group" | "channel" | "thread" = "group",
  selfMentioned = false,
  chatId = "oc_team_eng"
): NormalizedInboundEvent {
  return {
    platform: "lark",
    adapterId: "lark-1",
    selfId: "bot_open_id",
    messageId: "om_1",
    conversationRef: { platform: "lark", adapterId: "lark-1", chatId },
    conversationKey: `lark:lark-1:${chatId}`,
    sender: {
      id: "lark:lark-1:ou_user",
      platform: "lark",
      adapterId: "lark-1",
      remoteUserId: "ou_user",
    },
    channel: { id: chatId, kind: channelKind, platformChannelId: chatId },
    segments: [{ type: "text", text: "hi" }],
    plainText: "hi",
    mentions: { selfMentioned, users: [] },
    timestamp: 0,
    raw: {},
    ...overrides,
  }
}

describe("shouldRespondToMessage", () => {
  describe("default strategy", () => {
    it("defaults to mention_only — group messages without @bot are blocked", () => {
      const adapter = makeAdapter() // no atResponseStrategy set
      const event = makeEvent({}, "group", false)
      const decision = shouldRespondToMessage(event, adapter)
      expect(decision).toEqual({ allowed: false, reason: "at_mention_required" })
    })

    it("DEFAULT_AT_RESPONSE_STRATEGY is mention_only", () => {
      expect(DEFAULT_AT_RESPONSE_STRATEGY).toBe<AtResponseStrategy>("mention_only")
    })
  })

  describe("DM bypass", () => {
    it.each<AtResponseStrategy>(["always", "mention_only", "direct_only"])(
      "strategy=%s — private channel always passes (no mention required)",
      (strategy) => {
        const adapter = makeAdapter({ atResponseStrategy: strategy })
        const event = makeEvent({}, "private", false)
        expect(shouldRespondToMessage(event, adapter)).toEqual({ allowed: true })
      }
    )
  })

  describe("strategy = always", () => {
    it("group message without @bot still passes", () => {
      const adapter = makeAdapter({ atResponseStrategy: "always" })
      const event = makeEvent({}, "group", false)
      expect(shouldRespondToMessage(event, adapter)).toEqual({ allowed: true })
    })

    it("channel message without @bot still passes", () => {
      const adapter = makeAdapter({ atResponseStrategy: "always" })
      const event = makeEvent({}, "channel", false)
      expect(shouldRespondToMessage(event, adapter)).toEqual({ allowed: true })
    })
  })

  describe("strategy = mention_only", () => {
    it("group message with @bot passes", () => {
      const adapter = makeAdapter({ atResponseStrategy: "mention_only" })
      const event = makeEvent({}, "group", true)
      expect(shouldRespondToMessage(event, adapter)).toEqual({ allowed: true })
    })

    it("group message without @bot is blocked with at_mention_required", () => {
      const adapter = makeAdapter({ atResponseStrategy: "mention_only" })
      const event = makeEvent({}, "group", false)
      expect(shouldRespondToMessage(event, adapter)).toEqual({
        allowed: false,
        reason: "at_mention_required",
      })
    })
  })

  describe("strategy = direct_only", () => {
    it("group message blocked even when @bot is mentioned", () => {
      const adapter = makeAdapter({ atResponseStrategy: "direct_only" })
      const event = makeEvent({}, "group", true)
      expect(shouldRespondToMessage(event, adapter)).toEqual({
        allowed: false,
        reason: "at_direct_only",
      })
    })

    it("thread message blocked", () => {
      const adapter = makeAdapter({ atResponseStrategy: "direct_only" })
      const event = makeEvent({}, "thread", true)
      expect(shouldRespondToMessage(event, adapter)).toEqual({
        allowed: false,
        reason: "at_direct_only",
      })
    })
  })

  describe("chatBlocklist", () => {
    it("denies regardless of strategy / mention state", () => {
      const adapter = makeAdapter({
        atResponseStrategy: "always",
        chatBlocklist: ["oc_spam"],
      })
      const event = makeEvent({}, "group", true, "oc_spam")
      expect(shouldRespondToMessage(event, adapter)).toEqual({
        allowed: false,
        reason: "chat_blocklist",
      })
    })

    it("denies in DMs too — blocklist beats DM bypass", () => {
      const adapter = makeAdapter({
        atResponseStrategy: "always",
        chatBlocklist: ["oc_blocked_dm"],
      })
      const event = makeEvent({}, "private", false, "oc_blocked_dm")
      expect(shouldRespondToMessage(event, adapter)).toEqual({
        allowed: false,
        reason: "chat_blocklist",
      })
    })

    it("empty blocklist is a no-op", () => {
      const adapter = makeAdapter({
        atResponseStrategy: "always",
        chatBlocklist: [],
      })
      const event = makeEvent({}, "group", true)
      expect(shouldRespondToMessage(event, adapter)).toEqual({ allowed: true })
    })
  })

  describe("chatAllowlist", () => {
    it("non-empty allowlist: missing chat id is denied", () => {
      const adapter = makeAdapter({
        atResponseStrategy: "always",
        chatAllowlist: ["oc_team_eng"],
      })
      const event = makeEvent({}, "group", true, "oc_random")
      expect(shouldRespondToMessage(event, adapter)).toEqual({
        allowed: false,
        reason: "chat_allowlist",
      })
    })

    it("non-empty allowlist: matching chat id passes", () => {
      const adapter = makeAdapter({
        atResponseStrategy: "always",
        chatAllowlist: ["oc_team_eng", "oc_team_pm"],
      })
      const event = makeEvent({}, "group", true, "oc_team_pm")
      expect(shouldRespondToMessage(event, adapter)).toEqual({ allowed: true })
    })

    it("empty allowlist treated as 'no allowlist configured'", () => {
      const adapter = makeAdapter({
        atResponseStrategy: "always",
        chatAllowlist: [],
      })
      const event = makeEvent({}, "group", true, "oc_random")
      expect(shouldRespondToMessage(event, adapter)).toEqual({ allowed: true })
    })

    it("blocklist hit beats allowlist hit", () => {
      const adapter = makeAdapter({
        atResponseStrategy: "always",
        chatAllowlist: ["oc_team_eng"],
        chatBlocklist: ["oc_team_eng"], // pathological but operator-correct
      })
      const event = makeEvent({}, "group", true, "oc_team_eng")
      expect(shouldRespondToMessage(event, adapter)).toEqual({
        allowed: false,
        reason: "chat_blocklist",
      })
    })
  })

  describe("event kind passthrough", () => {
    it("edit events bypass the gate", () => {
      const adapter = makeAdapter({
        atResponseStrategy: "direct_only",
        chatBlocklist: ["oc_team_eng"],
      })
      const event = makeEvent({ kind: "edit", replacesMessageId: "om_1" }, "group", false)
      expect(shouldRespondToMessage(event, adapter)).toEqual({ allowed: true })
    })

    it("delete events bypass the gate", () => {
      const adapter = makeAdapter({ atResponseStrategy: "direct_only" })
      const event = makeEvent({ kind: "delete", replacesMessageId: "om_1" }, "group", false)
      expect(shouldRespondToMessage(event, adapter)).toEqual({ allowed: true })
    })

    it("system events bypass the gate", () => {
      const adapter = makeAdapter({ atResponseStrategy: "direct_only" })
      const event = makeEvent({ kind: "system", systemKind: "member_added" }, "group", false)
      expect(shouldRespondToMessage(event, adapter)).toEqual({ allowed: true })
    })
  })

  describe("chat id source", () => {
    it("prefers channel.platformChannelId over channel.id when both set", () => {
      const adapter = makeAdapter({
        atResponseStrategy: "always",
        chatBlocklist: ["oc_platform"],
      })
      const event = makeEvent(
        {
          channel: { id: "bus_id", kind: "group", platformChannelId: "oc_platform" },
        },
        "group",
        true
      )
      expect(shouldRespondToMessage(event, adapter)).toEqual({
        allowed: false,
        reason: "chat_blocklist",
      })
    })

    it("falls back to channel.id when platformChannelId is absent", () => {
      const adapter = makeAdapter({
        atResponseStrategy: "always",
        chatBlocklist: ["bus_only_id"],
      })
      const event = makeEvent(
        {
          channel: { id: "bus_only_id", kind: "group" },
        },
        "group",
        true
      )
      expect(shouldRespondToMessage(event, adapter)).toEqual({
        allowed: false,
        reason: "chat_blocklist",
      })
    })
  })
})
