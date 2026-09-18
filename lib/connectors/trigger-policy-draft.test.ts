import { readFileSync } from "node:fs"

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
  type TriggerCoverageGap,
  type TriggerDraftWarning,
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
    sender: {
      id: "u1",
      displayName: "U",
      platform: "telegram",
      adapterId: "cai_1",
      remoteUserId: "u1",
    },
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
        { kind: "regex", pattern: "p[012]", caseInsensitive: true },
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

  it("rejects an unsafe regex at draft so it never reaches the evaluator", () => {
    const draft = emptyTriggerPolicyDraft()
    draft.rules.regex = { enabled: true, pattern: "(a+)+$", caseInsensitive: true }
    const policy = fromTriggerPolicyDraft(draft)
    expect(policy.rules).toEqual([])
    expect(triggerDraftWarnings(draft)).toEqual(["regex-unsafe"])
  })

  it("rejects an enabled-but-empty regex rather than emitting a match-everything rule", () => {
    // `new RegExp("")` matches every message — an enabled empty slot saved as
    // a rule would trigger the bot on all traffic, so the draft refuses to
    // emit it (the `regex-empty` warning explains why the slot did not save).
    const draft = emptyTriggerPolicyDraft()
    draft.rules.regex = { enabled: true, pattern: "", caseInsensitive: true }
    expect(fromTriggerPolicyDraft(draft).rules).toEqual([])
    expect(triggerDraftWarnings(draft)).toEqual(["regex-empty"])
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
    [
      "listed sender",
      event({
        sender: {
          id: "vip",
          displayName: "V",
          platform: "telegram",
          adapterId: "cai_1",
          remoteUserId: "vip",
        },
      }),
    ],
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

  it("merges same-case regex rules by alternation and keeps a disagreeing one verbatim", () => {
    const original: TriggerPolicy = {
      rules: [
        { kind: "regex", pattern: "deploy", caseInsensitive: true },
        { kind: "regex", pattern: "p[012]", caseInsensitive: true },
        { kind: "regex", pattern: "DEPLOY", caseInsensitive: false },
      ],
      blockers: [],
      storeUnmatchedInDraftMode: false,
    }
    const draft = toTriggerPolicyDraft(original)
    expect(draft.rules.regex).toEqual({
      enabled: true,
      pattern: "deploy|p[012]",
      caseInsensitive: true,
    })
    expect(draft.residualRules).toEqual([
      { kind: "regex", pattern: "DEPLOY", caseInsensitive: false },
    ])
    expectSameVerdicts(original, fromTriggerPolicyDraft(draft))
  })

  it("does not double-list an identical regex rule", () => {
    const original: TriggerPolicy = {
      rules: [
        { kind: "regex", pattern: "deploy", caseInsensitive: true },
        { kind: "regex", pattern: "deploy", caseInsensitive: true },
      ],
      blockers: [],
      storeUnmatchedInDraftMode: false,
    }
    const draft = toTriggerPolicyDraft(original)
    expect(draft.rules.regex.pattern).toBe("deploy")
  })

  it("keeps a stored unsafe regex verbatim in residual rather than letting it contaminate the slot", () => {
    const original: TriggerPolicy = {
      rules: [
        { kind: "regex", pattern: "(a+)+$", caseInsensitive: true },
        { kind: "regex", pattern: "deploy", caseInsensitive: true },
      ],
      blockers: [],
      storeUnmatchedInDraftMode: false,
    }
    const draft = toTriggerPolicyDraft(original)
    // The unsafe rule fails closed at eval regardless; keeping it out of the
    // slot stops an alternation merge from dropping `deploy` with it on save.
    expect(draft.rules.regex).toEqual({
      enabled: true,
      pattern: "deploy",
      caseInsensitive: true,
    })
    expect(draft.residualRules).toEqual([
      { kind: "regex", pattern: "(a+)+$", caseInsensitive: true },
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
    draft.rules.regex.enabled = true
    draft.rules.userAllowlist.enabled = true
    draft.rules.channelAllowlist.enabled = true
    draft.blockers.userBlocklist.enabled = true
    draft.blockers.channelBlocklist.enabled = true
    draft.blockers.keywordBlocklist.enabled = true
    expect(triggerDraftWarnings(draft)).toEqual([
      "slash-command-empty",
      "keyword-empty",
      "regex-empty",
      "user-allowlist-empty",
      "channel-allowlist-empty",
      "user-blocklist-empty",
      "channel-blocklist-empty",
      "keyword-blocklist-empty",
    ])
  })

  it("flags an unsafe regex rather than letting it silently never match", () => {
    const draft = emptyTriggerPolicyDraft()
    draft.rules.regex = { enabled: true, pattern: "(a+)+$", caseInsensitive: true }
    expect(triggerDraftWarnings(draft)).toEqual(["regex-unsafe"])
    // …and the evaluator really does fail it closed.
    const event_ = event({ plainText: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaab" })
    expect(evaluatePolicy(fromTriggerPolicyDraft(draft), event_, emptyState(), 1_000).matched).toBe(
      false
    )
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

/**
 * `triggerCoverageGaps` and `triggerDraftWarnings` are rendered through
 * `t(`gaps.${gap}`)` / `t(`warnings.${warning}`)`, and `lint:i18n` skips
 * template-literal keys entirely — so a new member of either union ships as a
 * raw key path in the UI with every gate green.
 */
describe("localisation catalogue", () => {
  const GAPS: TriggerCoverageGap[] = ["no-rules", "plain-private", "group-mention"]
  const WARNINGS: TriggerDraftWarning[] = [
    "slash-command-empty",
    "keyword-empty",
    "regex-empty",
    "regex-unsafe",
    "user-allowlist-empty",
    "channel-allowlist-empty",
    "user-blocklist-empty",
    "channel-blocklist-empty",
    "keyword-blocklist-empty",
    "rate-limit-blocks-everything",
  ]
  /** Independently spelled — the conversation editor indexes by these. */
  const OVERRIDE_PARTS = ["rules", "blockers", "storeUnmatched"]

  it.each(["en", "zh-CN"])("covers every dynamic key in %s", (locale) => {
    const messages = JSON.parse(
      readFileSync(`i18n/messages/${locale}/settings/connections.json`, "utf8")
    ).triggerPolicy
    for (const gap of GAPS) expect(messages.gaps).toHaveProperty(gap)
    for (const warning of WARNINGS) expect(messages.warnings).toHaveProperty(warning)
    for (const part of OVERRIDE_PARTS) expect(messages.overrideParts).toHaveProperty(part)
  })

  // The lists above are hand-kept, so pin them to the real unions: a member
  // added without a message would otherwise just be missing from both.
  it("keeps the pinned lists exhaustive", () => {
    expect(
      triggerCoverageGaps({ rules: [], blockers: [], storeUnmatchedInDraftMode: false })
    ).toEqual(expect.arrayContaining([expect.any(String)]))
    const everySlotOn = emptyTriggerPolicyDraft()
    everySlotOn.rules.slashCommand.enabled = true
    everySlotOn.rules.keyword.enabled = true
    // The regex slot has two warning states and one draft can only show one;
    // the unsafe variant is unioned in from a second draft below.
    everySlotOn.rules.regex.enabled = true
    everySlotOn.rules.userAllowlist.enabled = true
    everySlotOn.rules.channelAllowlist.enabled = true
    everySlotOn.blockers.userBlocklist.enabled = true
    everySlotOn.blockers.channelBlocklist.enabled = true
    everySlotOn.blockers.keywordBlocklist.enabled = true
    everySlotOn.blockers.rateLimit = {
      enabled: true,
      perUserPerMin: 0,
      perChannelPerMin: 0,
      perTenantPerMin: undefined,
    }
    const unsafeRegex = emptyTriggerPolicyDraft()
    unsafeRegex.rules.regex = { enabled: true, pattern: "(a+)+", caseInsensitive: true }
    expect(
      new Set([...triggerDraftWarnings(everySlotOn), ...triggerDraftWarnings(unsafeRegex)])
    ).toEqual(new Set(WARNINGS))
    expect(
      new Set([
        ...triggerCoverageGaps({ rules: [], blockers: [], storeUnmatchedInDraftMode: false }),
        ...triggerCoverageGaps({
          rules: [{ kind: "reply-to-bot" }],
          blockers: [],
          storeUnmatchedInDraftMode: false,
        }),
      ])
    ).toEqual(new Set(GAPS))
  })
})
