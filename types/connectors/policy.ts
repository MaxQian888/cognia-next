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
  | { kind: "rate-limit"; perUserPerMin: number; perChannelPerMin: number }
  | { kind: "cooldown-after-bot-reply"; secs: number }

export interface TriggerPolicy {
  rules: TriggerRule[]
  blockers: TriggerBlocker[]
  storeUnmatchedInDraftMode: boolean
}

export type ConnectorMode = "auto" | "manual" | "draft"

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
