import { ALL_PLATFORM_KINDS, type BuiltInPlatformKind } from "./platform-kind"
import {
  addressedOnlyChatPolicy,
  addressedTriggerRules,
  defaultGroupChatPolicy,
  defaultPrivateChatPolicy,
  defaultTriggerPolicyFor,
  type TriggerPolicy,
} from "./policy"

describe("TriggerPolicy", () => {
  it("typed policy compiles", () => {
    const p: TriggerPolicy = {
      rules: [{ kind: "self-mention" }, { kind: "slash-command", prefixes: ["/ask"] }],
      blockers: [
        { kind: "rate-limit", perUserPerMin: 5, perChannelPerMin: 30 },
        { kind: "cooldown-after-bot-reply", secs: 3 },
      ],
      storeUnmatchedInDraftMode: false,
    }
    expect(p.rules).toHaveLength(2)
  })
})

describe("default profiles", () => {
  it("private-chat profile engages on every private message and stores the rest", () => {
    const p = defaultPrivateChatPolicy()
    expect(p.rules.some((r) => r.kind === "private-default")).toBe(true)
    expect(p.storeUnmatchedInDraftMode).toBe(true)
  })

  // The regression this batch fixes: an @-mention of a DM-first bot in a group
  // passed conversation admission and then matched no rule, so it was dropped.
  it.each([defaultPrivateChatPolicy(), defaultGroupChatPolicy(), addressedOnlyChatPolicy()])(
    "every profile answers a bot that was addressed",
    (policy) => {
      for (const rule of addressedTriggerRules()) {
        expect(policy.rules.some((r) => r.kind === rule.kind)).toBe(true)
      }
    }
  )

  // Symmetric regression: WeCom / OneBot only set `selfMentioned` in groups, so
  // a 1:1 chat under the old group profile matched nothing at all.
  it("group profile still answers a plain direct message", () => {
    expect(defaultGroupChatPolicy().rules.some((r) => r.kind === "private-default")).toBe(true)
  })

  // Not an oversight — see the profile docblock. Pinned so the omission cannot
  // be "fixed" into auto-answering every DM sent to a person's own account.
  it("addressed-only profile deliberately omits private-default and keeps history", () => {
    const p = addressedOnlyChatPolicy()
    expect(p.rules.some((r) => r.kind === "private-default")).toBe(false)
    expect(p.storeUnmatchedInDraftMode).toBe(true)
  })

  it("profiles differ only in throttling and unmatched handling", () => {
    expect(defaultPrivateChatPolicy().rules).toEqual(defaultGroupChatPolicy().rules)
    expect(defaultPrivateChatPolicy().blockers).not.toEqual(defaultGroupChatPolicy().blockers)
  })
})

describe("defaultTriggerPolicyFor", () => {
  it("gives every built-in platform a policy that can match something", () => {
    for (const kind of ALL_PLATFORM_KINDS) {
      expect(defaultTriggerPolicyFor(kind).rules.length).toBeGreaterThan(0)
    }
  })

  it.each([
    ["telegram", defaultPrivateChatPolicy()],
    ["slack", defaultPrivateChatPolicy()],
    ["discord", defaultPrivateChatPolicy()],
    ["lark", defaultPrivateChatPolicy()],
    ["wechat-oa", defaultPrivateChatPolicy()],
    ["dingtalk", defaultGroupChatPolicy()],
    ["wecom", defaultGroupChatPolicy()],
    ["qq-official", defaultGroupChatPolicy()],
    ["onebot", defaultGroupChatPolicy()],
    ["matrix", defaultGroupChatPolicy()],
    ["wechat-personal", addressedOnlyChatPolicy()],
  ] as Array<[BuiltInPlatformKind, TriggerPolicy]>)("maps %s to its profile", (kind, expected) => {
    expect(defaultTriggerPolicyFor(kind)).toEqual(expected)
  })

  // Plugin-contributed kinds are an open string branch; they must land on a
  // real profile rather than an empty policy that answers nothing.
  it("falls back to the private profile for a plugin kind", () => {
    expect(defaultTriggerPolicyFor("acme-chat")).toEqual(defaultPrivateChatPolicy())
  })
})
