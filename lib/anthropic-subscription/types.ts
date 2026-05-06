// Types shared across the Claude subscription OAuth subsystem. Mirrors the
// Rust struct in `src-tauri/src/anthropic_subscription/credential.rs` and the
// `UsageSnapshot` shape produced by the rate-limit header parser.
//
// The on-disk credential lives in the OS keyring; everything in this module
// is in-memory only (zustand cache + Dexie usage table).

/**
 * Which OAuth flow the credential came from. Determines authorize URL,
 * redirect URI, scope, and (per ADR 0010 + Phase 0 research) reuses the
 * same public client_id `9d1c250a-e61b-44d9-88ed-5944d1962f5e` for both —
 * the server differentiates by host + redirect URI.
 */
export type OAuthMode = "subscription" | "console"

/**
 * Persisted shape of the OAuth credential. Stored as JSON inside a single
 * keyring entry (`com.cognia.claude-subscription/v1` / account `default`).
 *
 * Field names match the Rust struct's `serde(rename = "...")` attributes so
 * the wire format is stable across the IPC boundary.
 */
export interface SubscriptionCredential {
  accessToken: string
  refreshToken: string
  /** Absolute expiry, ms epoch. `Date.now() + expires_in * 1000`. */
  expiresAtMs: number
  mode: OAuthMode
  scope?: string
  email?: string
  /** Optional plan label: "pro" | "max" | "team" | "console" | other. */
  plan?: string
  storedAtMs: number
}

/**
 * Source of a usage snapshot. Passive samples come from real conversation
 * traffic (zero extra quota cost); probe samples come from the optional
 * `usage-probe` module that the user explicitly opted in to (Phase 4b).
 */
export type UsageSource = "passive" | "probe"

/** Top-level `anthropic-ratelimit-unified-status` value. */
export type UsageStatus = "allowed" | "allowed_warning" | "rate_limited" | "unknown"

/** Which window Anthropic considers authoritative for the current call. */
export type RepresentativeClaim = "five_hour" | "seven_day"

export interface UsageWindow {
  /** 0–1, ratio of consumed quota in this window. */
  utilization: number
  /** When this window resets, ms epoch. */
  resetAt: number
  /** Per-window status (`allowed` | `allowed_warning` | `rate_limited`). */
  status: string
}

/**
 * One snapshot of `anthropic-ratelimit-unified-*` headers. Fields can be
 * `null` when the response didn't include them (e.g. error response, API-key
 * mode without unified headers, or transient network failure).
 */
export interface UsageSnapshot {
  fetchedAt: number
  source: UsageSource
  status: UsageStatus
  representativeClaim: RepresentativeClaim | null
  fiveHour: UsageWindow | null
  sevenDay: UsageWindow | null
  /** `anthropic-ratelimit-unified-fallback-percentage`, when present. */
  fallbackPercentage: number | null
  /** `anthropic-ratelimit-unified-overage-disabled-reason`, when present. */
  overageDisabledReason: string | null
  /** Raw `anthropic-ratelimit-*` headers verbatim, kept for debugging. */
  rawHeaders: Record<string, string>
}

/** Persisted shape with Dexie's auto-incrementing primary key. */
export interface SubscriptionUsageRow extends UsageSnapshot {
  /** Auto-incremented Dexie primary key. */
  localId?: number
}

/**
 * Settings that drive the subscription subsystem. Lives under
 * `AppSettings.subscriptionSettings` (extended in Phase 5).
 */
export interface SubscriptionSettings {
  /** Whether the active probe loop is enabled. Default `false` — passive
   *  collection runs unconditionally and is preferred. */
  probeEnabled: boolean
  /** Active probe cadence when the Subscription page is visible, ms.
   *  Floor 60_000 to avoid burning quota. */
  visibleIntervalMs: number
  /** Active probe cadence when the page is hidden, ms. */
  idleIntervalMs: number
  /** Utilization threshold (0–100) at which the Overview tab flips the
   *  "Approaching limit" warning. */
  warnThresholdPct: number
}

export const DEFAULT_SUBSCRIPTION_SETTINGS: SubscriptionSettings = {
  probeEnabled: false,
  visibleIntervalMs: 5 * 60 * 1000,
  idleIntervalMs: 30 * 60 * 1000,
  warnThresholdPct: 90,
}
