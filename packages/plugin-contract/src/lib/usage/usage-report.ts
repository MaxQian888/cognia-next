/**
 * The plugin contract's share of `lib/usage/usage-report.ts`, which re-exports these.
 */
import type { ModelUsageRow, SurfaceUsageRow, UsageContributor } from "./session-analytics"

/**
 * The windows the card can attribute spend over. Each is precomputed at command
 * time: the card is a transcript snapshot, so a scope the user can switch to
 * must already carry its numbers rather than re-querying a database that has
 * moved on since.
 */
export type UsageScopeKey = "session" | "today" | "week"

/** Summed billable quantities for one scope. */
export interface UsageSpendTotals {
  turns: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  reasoningTokens: number
  costUsd: number
  durationMs: number
  /**
   * Turns no pricing layer could price. Their contribution to `costUsd` was 0,
   * so any figure with `unpricedTurns > 0` is a lower bound, not a total.
   */
  unpricedTurns: number
  /**
   * Share of prompt tokens served from the cache, 0–1, or `null` when the scope
   * read no prompt tokens at all (dividing by zero would render as "0% cached",
   * which reads as a cold cache rather than as "nothing to cache").
   */
  cacheHitRate: number | null
  /** Distinct sessions represented, so a multi-session scope says so. */
  sessions: number
}

/** One attribution scope, fully precomputed. */
export interface UsageScopeReport {
  key: UsageScopeKey
  totals: UsageSpendTotals
  /** Descending by cost. */
  surfaces: SurfaceUsageRow[]
  /** Descending by cost. */
  models: ModelUsageRow[]
  /** Claude-Code-style characteristics of the usage in this scope. */
  contributors: UsageContributor[]
}

/** Why a plane of the report is missing or degraded. Rendered as inline notes. */
export type UsageNoteId =
  /** Not the desktop shell — the keyring-backed quota read cannot run. */
  | "web-mode"
  /** No Anthropic subscription account is configured / active. */
  | "no-account"
  /** The account exists but has not opted into outbound quota queries. */
  | "query-disabled"
  /** The quota query ran and failed; `detail` carries the provider message. */
  | "quota-error"
  /** Quota data is older than the freshness budget. */
  | "stale"
  /** No local `sessionUsage` rows in any scope — nothing to attribute. */
  | "no-local-spend"
  /** Local spend could not be read (Dexie unavailable). */
  | "local-spend-unavailable"

export interface UsageNote {
  id: UsageNoteId
  /** Verbatim provider/system detail, when the note has one. */
  detail?: string
}
