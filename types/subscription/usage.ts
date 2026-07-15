// Anthropic usage tracking — Anthropic-only by design (ADR 0025 explicit
// non-goal of generalization). These types are referenced from both
// `lib/subscription/anthropic/` and `lib/db/schema.ts`.

import type { AnthropicAuthMode } from "./credential"

/** Passive vs probe sample lineage. */
export type UsageSource = "passive" | "probe"

/** Top-level `anthropic-ratelimit-unified-status` value. */
export type UsageStatus = "allowed" | "allowed_warning" | "rate_limited" | "unknown"

export type RepresentativeClaim = "five_hour" | "seven_day"

export interface UsageWindow {
  utilization: number
  resetAt: number
  status: string
}

export interface UsageSnapshot {
  fetchedAt: number
  source: UsageSource
  status: UsageStatus
  representativeClaim: RepresentativeClaim | null
  fiveHour: UsageWindow | null
  sevenDay: UsageWindow | null
  fallbackPercentage: number | null
  overageDisabledReason: string | null
  rawHeaders: Record<string, string>
}

export interface SubscriptionUsageRow extends UsageSnapshot {
  localId?: number
}

/** Anthropic-specific subscription settings (probe loop). */
export interface AnthropicSubscriptionSettings {
  probeEnabled: boolean
  visibleIntervalMs: number
  idleIntervalMs: number
  warnThresholdPct: number
}

export const DEFAULT_ANTHROPIC_SUBSCRIPTION_SETTINGS: AnthropicSubscriptionSettings = {
  probeEnabled: false,
  visibleIntervalMs: 5 * 60 * 1000,
  idleIntervalMs: 30 * 60 * 1000,
  warnThresholdPct: 90,
}

/**
 * Codex-specific subscription settings.
 *
 * Note there is no `preferDiscovered`: env injection requires an explicitly
 * adopted account (ADR-0025). Settings rows persisted before that flag was
 * removed may still carry it; it is inert, and nothing reads it.
 */
export interface CodexSubscriptionSettings {
  /** Refresh the bearer ~5min before expiry instead of waiting for failure. */
  autoRefreshNearExpiry: boolean
  /**
   * Background usage probing of the active Codex account's 5h/weekly windows
   * (parity with the Anthropic probe loop). Off by default — opt-in.
   */
  probeEnabled: boolean
  /** Probe cadence while the page is foregrounded (default 5 min). */
  visibleIntervalMs: number
  /** Probe cadence while the page is hidden / idle (default 30 min). */
  idleIntervalMs: number
  /** Utilization percent at which a window meter flips to the warn state. */
  warnThresholdPct: number
}

export const DEFAULT_CODEX_SUBSCRIPTION_SETTINGS: CodexSubscriptionSettings = {
  autoRefreshNearExpiry: true,
  probeEnabled: false,
  visibleIntervalMs: 5 * 60 * 1000,
  idleIntervalMs: 30 * 60 * 1000,
  warnThresholdPct: 90,
}

// ---------------------------------------------------------------------------
// Back-compat shape aliases — for files that import the v1 names while the
// renderer migration is in flight. Anything new should reach the names above
// directly.
// ---------------------------------------------------------------------------

/** @deprecated use `AnthropicAuthMode` */
export type OAuthMode = AnthropicAuthMode
/** @deprecated use `AnthropicSubscriptionSettings` */
export type SubscriptionSettings = AnthropicSubscriptionSettings
/** @deprecated use `DEFAULT_ANTHROPIC_SUBSCRIPTION_SETTINGS` */
export const DEFAULT_SUBSCRIPTION_SETTINGS = DEFAULT_ANTHROPIC_SUBSCRIPTION_SETTINGS
