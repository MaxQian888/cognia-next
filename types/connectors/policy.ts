import type { PlatformKind } from "./platform-kind"

export type TriggerRule =
  | { kind: "private-default" }
  | { kind: "self-mention" }
  | { kind: "reply-to-bot" }
  | { kind: "slash-command"; prefixes: string[] }
  | { kind: "keyword"; words: string[]; caseInsensitive: boolean }
  | { kind: "user-allowlist"; userIds: string[] }
  | { kind: "channel-allowlist"; channelIds: string[] }

export type TriggerBlocker =
  | { kind: "user-blocklist"; userIds: string[] }
  | { kind: "channel-blocklist"; channelIds: string[] }
  | { kind: "keyword-blocklist"; words: string[] }
  | {
      kind: "rate-limit"
      perUserPerMin: number
      perChannelPerMin: number
      /**
       * Ceiling across every sender and chat sharing one platform tenant.
       * The per-user and per-channel buckets bound one PERSON and one ROOM;
       * neither bounds a whole workspace, so a multi-tenant deployment had no
       * limit that a single tenant could hit. Omitted ⇒ no tenant ceiling
       * (single-tenant installs keep today's behavior exactly).
       */
      perTenantPerMin?: number
    }
  | { kind: "cooldown-after-bot-reply"; secs: number }

export interface TriggerPolicy {
  rules: TriggerRule[]
  blockers: TriggerBlocker[]
  storeUnmatchedInDraftMode: boolean
}

export type ConnectorMode = "auto" | "manual" | "draft"

/** Group-message admission policy resolved at adapter then conversation scope. */
export type InboundActivationPolicy =
  "mention_each" | "mention_activates" | "always" | "direct_only"

/** How a message received while a run is active should be interpreted. */
export type ActiveRunDispatchMode = "queue" | "steer"

/** Observed ability of a platform adapter to receive unmentioned messages. */
export type DeliveryReadiness = "unknown" | "mentions_only" | "all_messages_verified"

export const ALL_MODES = ["auto", "manual", "draft"] as const

/**
 * The rules that mean "this message is addressed to this bot".
 *
 * Every default profile below includes these, because a bot that is @-mentioned,
 * replied to, or invoked with `/ask` has been spoken to no matter which chat
 * scope it happens in. Leaving them out of the private profile is what made an
 * @-mention of a Telegram / Slack / Discord / Lark bot in a group match nothing
 * and get dropped: conversation admission let the mention through, and then the
 * trigger policy — which only knew `private-default` — refused it.
 */
export function addressedTriggerRules(): TriggerRule[] {
  return [
    { kind: "self-mention" },
    { kind: "reply-to-bot" },
    { kind: "slash-command", prefixes: ["/ask", "/agent"] },
  ]
}

/**
 * Default profile for a bot whose main scope is 1:1 chat: every private message
 * engages the AI, group messages engage when the bot is addressed, and unmatched
 * messages are stored in draft mode so the operator can still browse history.
 *
 * The generous rate limit is the profile's real distinguishing feature — a
 * person typing to a bot alone is not the same load as a busy group.
 */
export function defaultPrivateChatPolicy(): TriggerPolicy {
  return {
    rules: [{ kind: "private-default" }, ...addressedTriggerRules()],
    blockers: [{ kind: "rate-limit", perUserPerMin: 30, perChannelPerMin: 60 }],
    storeUnmatchedInDraftMode: true,
  }
}

/**
 * Default profile for a bot whose main scope is groups and channels: tighter
 * throttling, a post-reply cooldown so two bots cannot ping-pong, and unmatched
 * group chatter dropped rather than stored.
 *
 * It still carries `private-default`, because a bot deployed into groups is
 * also DM-able on every platform that reports a private scope at all. Without
 * it a WeCom / OneBot 1:1 chat matched nothing: those adapters only set
 * `selfMentioned` in groups, so a plain DM hit neither the mention rule nor the
 * reply rule and was dropped unanswered.
 */
export function defaultGroupChatPolicy(): TriggerPolicy {
  return {
    rules: [{ kind: "private-default" }, ...addressedTriggerRules()],
    blockers: [
      { kind: "rate-limit", perUserPerMin: 5, perChannelPerMin: 20 },
      { kind: "cooldown-after-bot-reply", secs: 3 },
    ],
    storeUnmatchedInDraftMode: false,
  }
}

/**
 * Default profile for a connector that speaks through a REAL PERSON'S account
 * rather than a bot identity (today: `wechat-personal`).
 *
 * Deliberately omits `private-default`. Auto-answering every direct message
 * sent to someone's own account is not a default anyone should acquire by
 * connecting an account — it has to be chosen. Unmatched messages are stored,
 * not dropped, so the operator still sees everything that arrived and can widen
 * the policy from the trigger editor once they mean to.
 */
export function addressedOnlyChatPolicy(): TriggerPolicy {
  return {
    rules: addressedTriggerRules(),
    blockers: [
      { kind: "rate-limit", perUserPerMin: 5, perChannelPerMin: 20 },
      { kind: "cooldown-after-bot-reply", secs: 3 },
    ],
    storeUnmatchedInDraftMode: true,
  }
}

/**
 * The trigger policy a freshly created instance of `kind` starts from.
 *
 * One table instead of eleven hard-coded calls in eleven create dialogs: the
 * profile a platform deserves is a property of the platform, and keeping it at
 * the call sites meant the choice was invisible, untested, and — for nine of
 * the eleven — wrong in one chat scope. Plugin-contributed kinds fall through
 * to the private profile, matching `connectors-bridge`'s own fallback.
 */
export function defaultTriggerPolicyFor(kind: PlatformKind): TriggerPolicy {
  switch (kind) {
    // Speaks as the operator's own WeChat account — see the profile docblock.
    case "wechat-personal":
      return addressedOnlyChatPolicy()
    // Group-first products. `matrix` is here because it reports every room as
    // `group`, so its DM rooms are addressed like any other room.
    case "dingtalk":
    case "wecom":
    case "qq-official":
    case "onebot":
    case "matrix":
      return defaultGroupChatPolicy()
    // DM-first products, plus `wechat-oa`, which has no group scope at all.
    default:
      return defaultPrivateChatPolicy()
  }
}
