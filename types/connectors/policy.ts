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
 * Default policy applied to private chats: every message engages the AI;
 * unmatched messages stored in draft mode so the user can browse history.
 * Adapters typically use this verbatim for private channels and use the
 * `defaultGroupChatPolicy` below for groups/channels.
 */
export function defaultPrivateChatPolicy(): TriggerPolicy {
  return {
    rules: [{ kind: "private-default" }],
    blockers: [{ kind: "rate-limit", perUserPerMin: 30, perChannelPerMin: 60 }],
    storeUnmatchedInDraftMode: true,
  }
}

export function defaultGroupChatPolicy(): TriggerPolicy {
  return {
    rules: [
      { kind: "self-mention" },
      { kind: "reply-to-bot" },
      { kind: "slash-command", prefixes: ["/ask", "/agent"] },
    ],
    blockers: [
      { kind: "rate-limit", perUserPerMin: 5, perChannelPerMin: 20 },
      { kind: "cooldown-after-bot-reply", secs: 3 },
    ],
    storeUnmatchedInDraftMode: false,
  }
}
