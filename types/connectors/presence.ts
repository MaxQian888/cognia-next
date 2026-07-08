/**
 * Presence-status types — the cross-platform contract behind the
 * "token-usage status" feature (usage snapshot surfaced as a Lark 系统状态
 * badge, Slack profile status, Discord gateway presence, or a pinned
 * periodically-edited card on platforms without a status API).
 *
 * The adapter-facing half is deliberately tiny: a text + optional expiry +
 * optional target users. Everything usage-specific (formatting, windows,
 * refresh cadence) lives above the adapter layer in
 * `lib/connectors/presence/usage-status-runner.ts`.
 */

/** Input to `PlatformAdapter.setPresenceStatus`. */
export interface PresenceStatusInput {
  /**
   * Short status text. The caller is responsible for truncating to the
   * platform budget (adapters may hard-truncate again as defense).
   */
  text: string
  /** Absolute expiry (ms epoch). Platforms that require one default to ~2× the refresh interval. */
  expiresAt?: number
  /**
   * Platform-side user ids the status should be applied to. Only meaningful
   * on platforms where a bot applies a badge to *users* (Lark system status
   * batch_open). Ignored by self-status platforms (Slack user token,
   * Discord bot presence).
   */
  targetUserIds?: string[]
}

/** Which surfaces the usage presence feature drives. */
export type UsagePresenceMode = "badge" | "card" | "both"

/** Rolling window the usage snapshot covers. */
export type UsagePresenceWindow = "today" | "7d" | "30d"

/**
 * Per-adapter usage-presence configuration. Stored on
 * `AdapterInstanceRow.presence` (non-indexed JSON — no schema bump), same
 * row-level placement rationale as `quietHours`/`muted`.
 */
export interface UsagePresenceConfig {
  enabled: boolean
  mode: UsagePresenceMode
  /** Refresh cadence in minutes. Clamped to ≥1 by the runner; default 5. */
  intervalMinutes: number
  /** Usage window the snapshot covers. Default "today". */
  window: UsagePresenceWindow
  /** Conversation hosting the pinned usage card (card/both modes). */
  cardConversationKey?: string
  /** Platform user ids for badge platforms that target users (Lark). */
  targetUserIds?: string[]
}

/**
 * Runtime state the refresh runner persists between ticks. Stored on
 * `AdapterInstanceRow.presenceState` (non-indexed JSON).
 */
export interface UsagePresenceState {
  /**
   * Platform-side status object id, when the platform models statuses as
   * tenant-level entities (Lark 系统状态 id, created lazily on first refresh).
   */
  platformStatusId?: string
  /** Platform message id of the pinned usage card, once known. */
  cardMessageId?: string
  /** Outbound job id of the card-creating send (resolved to a message id on the next tick). */
  cardJobId?: string
  /** Whether the card has been pinned (best-effort, once). */
  cardPinned?: boolean
  lastRefreshAt?: number
  lastError?: string
}

export const DEFAULT_USAGE_PRESENCE_CONFIG: UsagePresenceConfig = {
  enabled: false,
  mode: "badge",
  intervalMinutes: 5,
  window: "today",
}
