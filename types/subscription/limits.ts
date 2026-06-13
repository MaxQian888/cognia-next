// Unified subscription limits / usage type surface (ADR 0025 follow-up).
//
// The `balance` adapters (`types/subscription/balance.ts`) answer "how much
// credit is left" and the Anthropic usage tracker (`types/subscription/usage.ts`)
// answers "how much of my rate-limit window is consumed". Those two shapes never
// met: balance is per-preset credit, Anthropic usage is provider-specific 5h/7d
// windows, and only the latter ever reached a UI.
//
// This module is the abstraction that unifies them. A `ProviderLimits` snapshot
// carries a flat list of `LimitsMeter`s — each meter is either a *window* (a
// utilization percent that resets at a wall-clock time, e.g. Claude's 5h
// session / 7d week, Codex's primary/weekly windows) or a *balance* (credit /
// quota left, e.g. Kimi, OpenCodeGo, DeepSeek). The TUI `/limits` panel and the
// desktop Usage tab both render this one shape, so adding a provider only means
// contributing a `LimitsSource` (built-in or via the `limits-source` plugin
// capability) — no new UI.
//
// NOTE: the existing `UsageSource = "passive" | "probe"` union in
// `./usage.ts` is the Anthropic sample lineage and is unrelated; this module
// deliberately uses the `Limits*` prefix to avoid that name clash.

import type { ProviderId } from "./credential"

/** A meter is either a resetting utilization window or a credit/quota balance. */
export type LimitsMeterKind = "window" | "balance"

/**
 * Three-step severity plus two terminals. `ok`/`warn`/`crit` mirror the
 * Anthropic `UsageLevel` (crit once a window hits 100%); `exceeded` flags a
 * window past 100% or a non-positive balance; `unknown` is "no usable reading".
 */
export type LimitsMeterStatus = "ok" | "warn" | "crit" | "exceeded" | "unknown"

/** One normalized meter on a provider account. */
export interface LimitsMeter {
  /** Stable id within the snapshot, e.g. "session" | "weekly" | "weekly_sonnet" | "credit". */
  id: string
  /**
   * i18n key the renderer resolves (no hard-coded strings reach the UI). Built-in
   * meters use keys under `subscription.limits.meter.*`; plugin meters may pass a
   * pre-resolved string here and set `label` instead.
   */
  labelKey?: string
  /** Pre-resolved label for plugin/dynamic meters that don't have an i18n key. */
  label?: string
  kind: LimitsMeterKind
  /**
   * Utilization as a whole percent (0-100, may exceed 100 on overage). For a
   * `balance` meter this is `used/total*100` when `total` is known, else `null`.
   */
  usedPct: number | null
  /** Epoch ms when a `window` meter resets, or `null`/absent for balances. */
  resetAt?: number | null
  /** Balance amounts (when `kind === "balance"`). */
  used?: number
  total?: number
  remaining?: number
  /** "USD" | "CNY" | "tokens" | "requests" — for balance meters. */
  unit?: string
  /** ISO-4217 currency for credit meters ("USD" | "CNY"). */
  currency?: string
  status: LimitsMeterStatus
}

/** Normalized limits/usage reading for one subscription account at one instant. */
export interface ProviderLimits {
  /** `ProviderId` for built-in sources; the balance providerKey for credit meters. */
  provider: string
  /** Vault account id this snapshot describes (absent for ad-hoc readings). */
  accountId?: string
  /** Account label for display headers, when known. */
  accountLabel?: string
  fetchedAt: number
  meters: LimitsMeter[]
  /** Set when the query failed; kept so the UI can surface the error inline. */
  error?: string
}

/** Persisted form — Dexie auto-increment primary key. */
export interface ProviderLimitsRow extends ProviderLimits {
  localId?: number
}

/** Fully-resolved I/O + identity a `LimitsSource` needs to fetch one account. */
export interface LimitsSourceContext {
  provider: ProviderId
  accountId: string
  accountLabel?: string
  /** Bearer token for the account, or `null` when none is available. */
  token: string | null
  /** Resolved preset baseUrl (for credit/host-matched sources). */
  baseUrl?: string
  /** Resolved preset templateId (the authoritative provider-match signal). */
  providerKey?: string
  /**
   * CORS-free authed GET. Tauri injects `subscription_authed_get`; the CLI
   * injects a node-`fetch`-backed implementation. Sources that fetch their own
   * way (e.g. the Anthropic header probe) may ignore it.
   */
  authedGet: (url: string, headers?: Record<string, string>) => Promise<string>
  /** Injected clock for reset-countdown math. */
  now: number
}

/**
 * Pure-ish per-provider limits source. `matches` is pure; `fetch` performs the
 * (injected) I/O and returns a normalized snapshot, `null` when the source
 * doesn't apply to the account (the runner then falls through to the next
 * candidate), or a snapshot with `error` set on a failed query.
 */
export interface LimitsSource {
  key: string
  matches(q: { provider?: string; providerKey?: string; baseUrl?: string }): boolean
  fetch(ctx: LimitsSourceContext): Promise<ProviderLimits | null>
}
