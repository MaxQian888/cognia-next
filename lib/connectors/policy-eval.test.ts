/**
 * Tests for the trigger policy evaluator (Task 26).
 *
 * Each `it()` tests exactly one rule kind or one blocker kind so failures are
 * easy to pin-point.
 */

import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { TriggerPolicy } from "@/types/connectors/policy"
import { evaluatePolicy, type PolicyEvalState } from "./policy-eval"

// ── helpers ──────────────────────────────────────────────────────────────────

function baseEvent(overrides: Partial<NormalizedInboundEvent> = {}): NormalizedInboundEvent {
  return {
    platform: "telegram",
    adapterId: "a1",
    selfId: "bot_1",
    messageId: "m1",
    conversationRef: { platform: "telegram", adapterId: "a1" },
    conversationKey: "telegram:a1:42",
    sender: { id: "u_alice", platform: "telegram", adapterId: "a1", remoteUserId: "u_alice" },
    channel: { id: "ch_group", kind: "group" },
    segments: [{ type: "text", text: "hello" }],
    plainText: "hello",
    mentions: { selfMentioned: false, users: [] },
    timestamp: 1_000_000,
    raw: {},
    ...overrides,
  }
}

function emptyState(): PolicyEvalState {
  return {
    recentBotReplyAtByConversation: {},
    recentByUserAndChannel: {},
  }
}

function noBlockPolicy(rules: TriggerPolicy["rules"]): TriggerPolicy {
  return { rules, blockers: [], storeUnmatchedInDraftMode: false }
}

function noRulePolicy(blockers: TriggerPolicy["blockers"]): TriggerPolicy {
  return { rules: [{ kind: "private-default" }], blockers, storeUnmatchedInDraftMode: false }
}

// ── rules ─────────────────────────────────────────────────────────────────────

describe("evaluatePolicy — rules", () => {
  it("private-default matches when channel.kind === 'private'", () => {
    const policy = noBlockPolicy([{ kind: "private-default" }])
    const event = baseEvent({ channel: { id: "ch_dm", kind: "private" } })
    const result = evaluatePolicy(policy, event, emptyState())
    expect(result.matched).toBe(true)
    expect(result.blocked).toBe(false)
  })

  it("private-default does NOT match a group channel", () => {
    const policy = noBlockPolicy([{ kind: "private-default" }])
    const event = baseEvent({ channel: { id: "ch_group", kind: "group" } })
    const result = evaluatePolicy(policy, event, emptyState())
    expect(result.matched).toBe(false)
  })

  it("self-mention matches when mentions.selfMentioned is true", () => {
    const policy = noBlockPolicy([{ kind: "self-mention" }])
    const event = baseEvent({ mentions: { selfMentioned: true, users: [] } })
    const result = evaluatePolicy(policy, event, emptyState())
    expect(result.matched).toBe(true)
  })

  it("self-mention does NOT match when selfMentioned is false", () => {
    const policy = noBlockPolicy([{ kind: "self-mention" }])
    const event = baseEvent({ mentions: { selfMentioned: false, users: [] } })
    const result = evaluatePolicy(policy, event, emptyState())
    expect(result.matched).toBe(false)
  })

  it("reply-to-bot matches when replyTo.messageId is present", () => {
    const policy = noBlockPolicy([{ kind: "reply-to-bot" }])
    const event = baseEvent({ replyTo: { messageId: "bot_msg_1", snippet: "..." } })
    const result = evaluatePolicy(policy, event, emptyState())
    expect(result.matched).toBe(true)
  })

  it("reply-to-bot does NOT match when replyTo is absent", () => {
    const policy = noBlockPolicy([{ kind: "reply-to-bot" }])
    const result = evaluatePolicy(policy, baseEvent(), emptyState())
    expect(result.matched).toBe(false)
  })

  it("slash-command matches when plainText starts with a prefix", () => {
    const policy = noBlockPolicy([{ kind: "slash-command", prefixes: ["/ask", "/agent"] }])
    const event = baseEvent({ plainText: "/ask what is the weather?" })
    const result = evaluatePolicy(policy, event, emptyState())
    expect(result.matched).toBe(true)
  })

  it("slash-command is case-sensitive and does NOT match mismatched prefix", () => {
    const policy = noBlockPolicy([{ kind: "slash-command", prefixes: ["/ask"] }])
    const event = baseEvent({ plainText: "/Ask hello" })
    const result = evaluatePolicy(policy, event, emptyState())
    expect(result.matched).toBe(false)
  })

  it("slash-command does NOT match text that contains but doesn't start with prefix", () => {
    const policy = noBlockPolicy([{ kind: "slash-command", prefixes: ["/ask"] }])
    const event = baseEvent({ plainText: "hello /ask me" })
    const result = evaluatePolicy(policy, event, emptyState())
    expect(result.matched).toBe(false)
  })

  it("keyword matches when plainText contains the word (case-sensitive)", () => {
    const policy = noBlockPolicy([{ kind: "keyword", words: ["cognia"], caseInsensitive: false }])
    const event = baseEvent({ plainText: "I love cognia!" })
    const result = evaluatePolicy(policy, event, emptyState())
    expect(result.matched).toBe(true)
  })

  it("keyword case-sensitive does NOT match different case", () => {
    const policy = noBlockPolicy([{ kind: "keyword", words: ["Cognia"], caseInsensitive: false }])
    const event = baseEvent({ plainText: "I love cognia!" })
    const result = evaluatePolicy(policy, event, emptyState())
    expect(result.matched).toBe(false)
  })

  it("keyword case-insensitive matches regardless of case", () => {
    const policy = noBlockPolicy([{ kind: "keyword", words: ["COGNIA"], caseInsensitive: true }])
    const event = baseEvent({ plainText: "I love cognia!" })
    const result = evaluatePolicy(policy, event, emptyState())
    expect(result.matched).toBe(true)
  })

  it("user-allowlist matches when sender.id is in the list", () => {
    const policy = noBlockPolicy([{ kind: "user-allowlist", userIds: ["u_alice", "u_bob"] }])
    const event = baseEvent({
      sender: { id: "u_alice", platform: "telegram", adapterId: "a1", remoteUserId: "u_alice" },
    })
    const result = evaluatePolicy(policy, event, emptyState())
    expect(result.matched).toBe(true)
  })

  it("user-allowlist does NOT match unknown sender", () => {
    const policy = noBlockPolicy([{ kind: "user-allowlist", userIds: ["u_bob"] }])
    const result = evaluatePolicy(policy, baseEvent(), emptyState())
    expect(result.matched).toBe(false)
  })

  it("channel-allowlist matches when channel.id is in the list", () => {
    const policy = noBlockPolicy([{ kind: "channel-allowlist", channelIds: ["ch_vip"] }])
    const event = baseEvent({ channel: { id: "ch_vip", kind: "group" } })
    const result = evaluatePolicy(policy, event, emptyState())
    expect(result.matched).toBe(true)
  })

  it("channel-allowlist does NOT match unlisted channel", () => {
    const policy = noBlockPolicy([{ kind: "channel-allowlist", channelIds: ["ch_vip"] }])
    const result = evaluatePolicy(policy, baseEvent(), emptyState())
    expect(result.matched).toBe(false)
  })

  it("rules are OR — first match wins", () => {
    const policy = noBlockPolicy([
      { kind: "self-mention" },
      { kind: "slash-command", prefixes: ["/ask"] },
    ])
    const event = baseEvent({
      plainText: "/ask help",
      mentions: { selfMentioned: false, users: [] },
    })
    const result = evaluatePolicy(policy, event, emptyState())
    expect(result.matched).toBe(true)
  })

  it("no rules → matched is false", () => {
    const policy: TriggerPolicy = { rules: [], blockers: [], storeUnmatchedInDraftMode: false }
    const result = evaluatePolicy(policy, baseEvent(), emptyState())
    expect(result.matched).toBe(false)
  })
})

// ── blockers ──────────────────────────────────────────────────────────────────

describe("evaluatePolicy — blockers", () => {
  it("user-blocklist blocks when sender.id is in the list", () => {
    const policy: TriggerPolicy = {
      rules: [{ kind: "private-default" }],
      blockers: [{ kind: "user-blocklist", userIds: ["u_spammer"] }],
      storeUnmatchedInDraftMode: false,
    }
    const event = baseEvent({
      channel: { id: "ch_dm", kind: "private" },
      sender: { id: "u_spammer", platform: "telegram", adapterId: "a1", remoteUserId: "u_spammer" },
    })
    const result = evaluatePolicy(policy, event, emptyState())
    expect(result.blocked).toBe(true)
    expect(result.reason).toMatch(/user-blocklist/)
  })

  it("user-blocklist does NOT block an allowed user", () => {
    const policy = noRulePolicy([{ kind: "user-blocklist", userIds: ["u_spammer"] }])
    const result = evaluatePolicy(
      policy,
      baseEvent({ channel: { id: "ch_dm", kind: "private" } }),
      emptyState()
    )
    expect(result.blocked).toBe(false)
  })

  it("channel-blocklist blocks when channel.id is in the list", () => {
    const policy = noRulePolicy([{ kind: "channel-blocklist", channelIds: ["ch_banned"] }])
    const event = baseEvent({
      channel: { id: "ch_banned", kind: "group" },
    })
    const result = evaluatePolicy(policy, event, emptyState())
    expect(result.blocked).toBe(true)
  })

  it("keyword-blocklist blocks when plainText contains the word", () => {
    const policy = noRulePolicy([{ kind: "keyword-blocklist", words: ["spam"] }])
    const event = baseEvent({ plainText: "this is spam content" })
    const result = evaluatePolicy(policy, event, emptyState())
    expect(result.blocked).toBe(true)
  })

  it("keyword-blocklist does NOT block when word is absent", () => {
    const policy = noRulePolicy([{ kind: "keyword-blocklist", words: ["spam"] }])
    const result = evaluatePolicy(
      policy,
      baseEvent({ channel: { id: "ch_dm", kind: "private" } }),
      emptyState()
    )
    expect(result.blocked).toBe(false)
  })

  it("rate-limit blocks when user bucket >= perUserPerMin", () => {
    const NOW = 1_000_000
    const bucketKey = "u_alice:ch_group"
    // 3 recent timestamps within last 60s
    const state: PolicyEvalState = {
      recentBotReplyAtByConversation: {},
      recentByUserAndChannel: {
        [bucketKey]: [NOW - 1000, NOW - 2000, NOW - 3000],
      },
    }
    const policy = noRulePolicy([{ kind: "rate-limit", perUserPerMin: 3, perChannelPerMin: 100 }])
    const result = evaluatePolicy(
      policy,
      baseEvent({ channel: { id: "ch_group", kind: "private" } }),
      state,
      NOW
    )
    expect(result.blocked).toBe(true)
    expect(result.reason).toMatch(/rate-limit/)
  })

  it("rate-limit does NOT block when bucket is under limit", () => {
    const NOW = 1_000_000
    const bucketKey = "u_alice:ch_group"
    const state: PolicyEvalState = {
      recentBotReplyAtByConversation: {},
      recentByUserAndChannel: {
        [bucketKey]: [NOW - 1000, NOW - 2000],
      },
    }
    const policy = noRulePolicy([{ kind: "rate-limit", perUserPerMin: 5, perChannelPerMin: 100 }])
    const result = evaluatePolicy(
      policy,
      baseEvent({ channel: { id: "ch_group", kind: "private" } }),
      state,
      NOW
    )
    expect(result.blocked).toBe(false)
  })

  it("rate-limit ignores timestamps older than 60s", () => {
    const NOW = 1_000_000
    const bucketKey = "u_alice:ch_group"
    // All older than 60s — should be ignored
    const state: PolicyEvalState = {
      recentBotReplyAtByConversation: {},
      recentByUserAndChannel: {
        [bucketKey]: [NOW - 61_000, NOW - 90_000, NOW - 120_000],
      },
    }
    const policy = noRulePolicy([{ kind: "rate-limit", perUserPerMin: 1, perChannelPerMin: 100 }])
    const result = evaluatePolicy(policy, baseEvent(), state, NOW)
    expect(result.blocked).toBe(false)
  })

  it("cooldown-after-bot-reply blocks within the cooldown window", () => {
    const NOW = 1_000_000
    const convKey = "telegram:a1:42"
    const state: PolicyEvalState = {
      recentBotReplyAtByConversation: { [convKey]: NOW - 2000 }, // 2s ago
      recentByUserAndChannel: {},
    }
    const policy = noRulePolicy([{ kind: "cooldown-after-bot-reply", secs: 5 }])
    const result = evaluatePolicy(policy, baseEvent(), state, NOW)
    expect(result.blocked).toBe(true)
    expect(result.reason).toMatch(/cooldown/)
  })

  it("cooldown-after-bot-reply does NOT block after cooldown has elapsed", () => {
    const NOW = 1_000_000
    const convKey = "telegram:a1:42"
    const state: PolicyEvalState = {
      recentBotReplyAtByConversation: { [convKey]: NOW - 10_000 }, // 10s ago
      recentByUserAndChannel: {},
    }
    const policy = noRulePolicy([{ kind: "cooldown-after-bot-reply", secs: 5 }])
    const result = evaluatePolicy(policy, baseEvent(), state, NOW)
    expect(result.blocked).toBe(false)
  })

  it("cooldown-after-bot-reply does NOT block when no bot reply on record", () => {
    const policy = noRulePolicy([{ kind: "cooldown-after-bot-reply", secs: 5 }])
    const result = evaluatePolicy(policy, baseEvent(), emptyState())
    expect(result.blocked).toBe(false)
  })
})

// ── combined cases ────────────────────────────────────────────────────────────

describe("evaluatePolicy — combined semantics", () => {
  it("private-default rule still triggers a match when no other rules are set", () => {
    const policy: TriggerPolicy = {
      rules: [{ kind: "private-default" }],
      blockers: [],
      storeUnmatchedInDraftMode: true,
    }
    const event = baseEvent({ channel: { id: "dm", kind: "private" } })
    const result = evaluatePolicy(policy, event, emptyState())
    expect(result.matched).toBe(true)
    expect(result.blocked).toBe(false)
  })

  it("allowlist rule matches, but blocklist still blocks (blockers apply independently)", () => {
    const policy: TriggerPolicy = {
      rules: [{ kind: "user-allowlist", userIds: ["u_alice"] }],
      blockers: [{ kind: "channel-blocklist", channelIds: ["ch_group"] }],
      storeUnmatchedInDraftMode: false,
    }
    const result = evaluatePolicy(policy, baseEvent(), emptyState())
    expect(result.matched).toBe(true)
    expect(result.blocked).toBe(true)
  })
})
