import type { NormalizedInboundEvent } from "@/types/connectors/event"
import {
  addressedOnlyChatPolicy,
  defaultGroupChatPolicy,
  defaultPrivateChatPolicy,
  type TriggerPolicy,
} from "@/types/connectors/policy"

import { evaluatePolicy, type PolicyEvalState } from "./policy-eval"
import {
  emptyTriggerPolicyDraft,
  fromTriggerPolicyDraft,
  toTriggerPolicyDraft,
  triggerCoverageGaps,
  triggerDraftWarnings,
} from "./trigger-policy-draft"

function emptyState(): PolicyEvalState {
  return { recentBotReplyAtByConversation: {}, recentByUserAndChannel: {} }
}

function event(overrides: Partial<NormalizedInboundEvent> = {}): NormalizedInboundEvent {
  return {
    platform: "telegram",
    adapterId: "cai_1",
    selfId: "bot",
    messageId: "m1",
    conversationRef: { platform: "telegram", adapterId: "cai_1", chatId: "c1", messageId: "m1" },
    conversationKey: "telegram:cai_1:c1",
    sender: { id: "u1", displayName: "U" },
    channel: { id: "telegram:cai_1:c1", kind: "private", platformChannelId: "c1" },
    segments: [],
    plainText: "hello",
    mentions: { selfMentioned: false, users: [] },
    timestamp: 0,
    raw: {},
    ...overrides,
  }
}

describe("draft round trip", () => {
  it.each([
    ["private profile", defaultPrivateChatPolicy()],
    ["group profile", defaultGroupChatPolicy()],
    ["addressed-only profile", addressedOnlyChatPolicy()],
  ])("preserves the %s exactly", (_name, policy) => {
    expect(fromTriggerPolicyDraft(toTriggerPolicyDraft(policy))).toEqual(policy)
  })

  it("round-trips every slot switched on", () => {
    const policy: TriggerPolicy = {
      rules: [
        { kind: "private-default" },
        { kind: "self-mention" },
        { kind: "reply-to-bot" },
        { kind: "slash-command", prefixes: ["/ask"] },
        { kind: "keyword", words: ["deploy"], caseInsensitive: false },
        { kind: "user-allowlist", userIds: ["u1"] },
        { kind: "channel-allowlist", channelIds: ["c1"] },
      ],
      blockers: [
        { kind: "user-blocklist", userIds: ["bad"] },
        { kind: "channel-blocklist", channelIds: ["noisy"] },
        { kind: "keyword-blocklist", words: ["stop"] },
        { kind: "rate-limit", perUserPerMin: 4, perChannelPerMin: 9, perTenantPerMin: 40 },
        { kind: "cooldown-after-bot-reply", secs: 7 },
      ],
      storeUnmatchedInDraftMode: true,
    }
    expect(fromTriggerPolicyDraft(toTriggerPolicyDraft(policy))).toEqual(policy)
  })

  it("emits no rate-limit ceiling key when none was set", () => {
    const draft = toTriggerPolicyDraft({
      rules: [],
      blockers: [{ kind: "rate-limit", perUserPerMin: 5, perChannelPerMin: 20 }],
      storeUnmatchedInDraftMode: false,
    })
    expect(fromTriggerPolicyDraft(draft).blockers[0]).not.toHaveProperty("perTenantPerMin")
  })

  it("tolerates a row with no policy at all", () => {
    expect(fromTriggerPolicyDraft(toTriggerPolicyDraft(undefined))).toEqual({
      rules: [],
      blockers: [],
      storeUnmatchedInDraftMode: false,
    })
  })

  it("keeps an enabled-but-empty slot rather than dropping the operator's toggle", () => {
    const draft = emptyTriggerPolicyDraft()
    draft.rules.slashCommand = { enabled: true, prefixes: [] }
    const policy = fromTriggerPolicyDraft(draft)
    expect(policy.rules).toEqual([{ kind: "slash-command", prefixes: [] }])
    expect(toTriggerPolicyDraft(policy).rules.slashCommand).toEqual({ enabled: true, prefixes: [] })
  })
})

describe("duplicate merging", () => {
  /**
   * Each case asserts the merge is behaviour-preserving by running BOTH the
   * original and the merged policy through the real evaluator: a merge that
   * quietly widened or narrowed the trigger would show up as a differing
   * verdict on one of the probes.
   */
  const probes: Array<[string, NormalizedInboundEvent]> = [
    ["plain private", event()],
    ["plain group", event({ channel: { id: "g", kind: "group", platformChannelId: "g" } })],
    [
      "group mention",
      event({
        channel: { id: "g", kind: "group", platformChannelId: "g" },
        mentions: { selfMentioned: true, users: [] },
      }),
    ],
    ["slash", event({ plainText: "/ops status" })],
    ["keyword hit", event({ plainText: "please DEPLOY now" })],
    ["listed sender", event({ sender: { id: "vip", displayName: "V" } })],
  ]

  function expectSameVerdicts(original: TriggerPolicy, merged: TriggerPolicy): void {
    for (const [, probe] of probes) {
      expect(evaluatePolicy(merged, probe, emptyState(), 1_000)).toEqual(
        evaluatePolicy(original, probe, emptyState(), 1_000)
      )
    }
  }

  it("unions list rules", () => {
    const original: TriggerPolicy = {
      rules: [
        { kind: "slash-command", prefixes: ["/ask"] },
        { kind: "slash-command", prefixes: ["/ops", "/ask"] },
        { kind: "user-allowlist", userIds: ["vip"] },
        { kind: "user-allowlist", userIds: ["other"] },
      ],
      blockers: [],
      storeUnmatchedInDraftMode: false,
    }
    const merged = fromTriggerPolicyDraft(toTriggerPolicyDraft(original))
    expect(merged.rules).toEqual([
      { kind: "slash-command", prefixes: ["/ask", "/ops"] },
      { kind: "user-allowlist", userIds: ["vip", "other"] },
    ])
    expectSameVerdicts(original, merged)
  })

  it("merges same-case keyword rules and keeps a disagreeing one verbatim", () => {
    const original: TriggerPolicy = {
      rules: [
        { kind: "keyword", words: ["deploy"], caseInsensitive: true },
        { kind: "keyword", words: ["ship"], caseInsensitive: true },
        { kind: "keyword", words: ["DEPLOY"], caseInsensitive: false },
      ],
      blockers: [],
      storeUnmatchedInDraftMode: false,
    }
    const draft = toTriggerPolicyDraft(original)
    expect(draft.rules.keyword).toEqual({
      enabled: true,
      words: ["deploy", "ship"],
      caseInsensitive: true,
    })
    expect(draft.residualRules).toEqual([
      { kind: "keyword", words: ["DEPLOY"], caseInsensitive: false },
    ])
    expectSameVerdicts(original, fromTriggerPolicyDraft(draft))
  })

  it("takes the tightest rate limit and the longest cooldown", () => {
    const original: TriggerPolicy = {
      rules: [{ kind: "private-default" }],
      blockers: [
        { kind: "rate-limit", perUserPerMin: 9, perChannelPerMin: 4, perTenantPerMin: 100 },
        { kind: "rate-limit", perUserPerMin: 3, perChannelPerMin: 20 },
        { kind: "cooldown-after-bot-reply", secs: 2 },
        { kind: "cooldown-after-bot-reply", secs: 8 },
      ],
      storeUnmatchedInDraftMode: false,
    }
    const merged = fromTriggerPolicyDraft(toTriggerPolicyDraft(original))
    expect(merged.blockers).toEqual([
      { kind: "rate-limit", perUserPerMin: 3, perChannelPerMin: 4, perTenantPerMin: 100 },
      { kind: "cooldown-after-bot-reply", secs: 8 },
    ])
    expectSameVerdicts(original, merged)
  })

  it("blocks at the same point as the two limits it replaced", () => {
    const original: TriggerPolicy = {
      rules: [{ kind: "private-default" }],
      blockers: [
        { kind: "rate-limit", perUserPerMin: 9, perChannelPerMin: 50 },
        { kind: "rate-limit", perUserPerMin: 3, perChannelPerMin: 50 },
      ],
      storeUnmatchedInDraftMode: false,
    }
    const merged = fromTriggerPolicyDraft(toTriggerPolicyDraft(original))
    const state: PolicyEvalState = {
      recentBotReplyAtByConversation: {},
      recentByUserAndChannel: { "-|u1:telegram:cai_1:c1": [1, 2, 3] },
    }
    expect(evaluatePolicy(merged, event(), state, 1_000).blocked).toBe(true)
    expect(evaluatePolicy(original, event(), state, 1_000).blocked).toBe(true)
  })
})

describe("triggerCoverageGaps", () => {
  it("reports the empty policy as answering nothing, and only that", () => {
    expect(
      triggerCoverageGaps({ rules: [], blockers: [], storeUnmatchedInDraftMode: false })
    ).toEqual(["no-rules"])
  })

  it.each([
    ["private profile", defaultPrivateChatPolicy()],
    ["group profile", defaultGroupChatPolicy()],
  ])("finds no gap in the %s", (_name, policy) => {
    expect(triggerCoverageGaps(policy)).toEqual([])
  })

  // Deliberate, not a defect — see `addressedOnlyChatPolicy`.
  it("reports the intentionally narrow profile's private gap", () => {
    expect(triggerCoverageGaps(addressedOnlyChatPolicy())).toEqual(["plain-private"])
  })

  it("reports the group gap of a private-only policy", () => {
    expect(
      triggerCoverageGaps({
        rules: [{ kind: "private-default" }],
        blockers: [],
        storeUnmatchedInDraftMode: false,
      })
    ).toEqual(["group-mention"])
  })

  /**
   * The gap list is derived from rule kinds rather than by simulating events,
   * so this pins the two against the real evaluator — a change to `matchRule`
   * that broke the correspondence fails here rather than shipping a diagnostic
   * that quietly disagrees with what the bus does.
   */
  it("agrees with the evaluator about both probes", () => {
    const policies: TriggerPolicy[] = [
      defaultPrivateChatPolicy(),
      defaultGroupChatPolicy(),
      addressedOnlyChatPolicy(),
      { rules: [{ kind: "private-default" }], blockers: [], storeUnmatchedInDraftMode: false },
      { rules: [{ kind: "self-mention" }], blockers: [], storeUnmatchedInDraftMode: false },
      {
        rules: [{ kind: "keyword", words: ["x"], caseInsensitive: true }],
        blockers: [],
        storeUnmatchedInDraftMode: false,
      },
    ]
    const plainPrivate = event()
    const groupMention = event({
      channel: { id: "g", kind: "group", platformChannelId: "g" },
      mentions: { selfMentioned: true, users: [] },
    })
    for (const policy of policies) {
      const gaps = triggerCoverageGaps(policy)
      expect(gaps.includes("plain-private")).toBe(
        !evaluatePolicy(policy, plainPrivate, emptyState(), 1_000).matched
      )
      expect(gaps.includes("group-mention")).toBe(
        !evaluatePolicy(policy, groupMention, emptyState(), 1_000).matched
      )
    }
  })
})

describe("triggerDraftWarnings", () => {
  it("stays quiet on a shipped profile", () => {
    expect(triggerDraftWarnings(toTriggerPolicyDraft(defaultGroupChatPolicy()))).toEqual([])
  })

  it("names every switched-on slot that has nothing to match", () => {
    const draft = emptyTriggerPolicyDraft()
    draft.rules.slashCommand.enabled = true
    draft.rules.keyword.enabled = true
    draft.rules.userAllowlist.enabled = true
    draft.rules.channelAllowlist.enabled = true
    draft.blockers.userBlocklist.enabled = true
    draft.blockers.channelBlocklist.enabled = true
    draft.blockers.keywordBlocklist.enabled = true
    expect(triggerDraftWarnings(draft)).toEqual([
      "slash-command-empty",
      "keyword-empty",
      "user-allowlist-empty",
      "channel-allowlist-empty",
      "user-blocklist-empty",
      "channel-blocklist-empty",
      "keyword-blocklist-empty",
    ])
  })

  it("catches a rate limit of zero, which silences the bot entirely", () => {
    const draft = emptyTriggerPolicyDraft()
    draft.blockers.rateLimit = {
      enabled: true,
      perUserPerMin: 0,
      perChannelPerMin: 20,
      perTenantPerMin: undefined,
    }
    expect(triggerDraftWarnings(draft)).toContain("rate-limit-blocks-everything")
    // …and the evaluator really does block the very first message.
    expect(
      evaluatePolicy(fromTriggerPolicyDraft(draft), event(), emptyState(), 1_000).blocked
    ).toBe(true)
  })
})
