/**
 * Pure parser + formatters for the LIVE Anthropic API rate-limit headers.
 *
 * The sidecar's `fetch-interceptor.mjs` captures every `anthropic-ratelimit-*`
 * response header from `api.anthropic.com` and writes it to stdout as a
 * `usage_headers` message. The TUI subscribes to that channel
 * (`useAgentSession`) and folds the headers into a {@link RateLimitSnapshot}
 * here, which the `/limits` panel renders as a live "API rate limits" block and
 * the optional `ratelimit` footer segment summarizes.
 *
 * This is a DIFFERENT data source from the subscription/account windows in
 * `runtime/limits-data.ts`: those answer "how much of my plan have I used"; these
 * answer "how close is this API key to a per-window 429". Both render as bars but
 * never share a number, so they stay separate types.
 *
 * Kept pure (clock injected) so the reset math stays deterministic + tested.
 */
import { splitCountdown } from "@/lib/subscription/anthropic/usage-analytics"

import { meterColor, type MeterColorToken } from "./limits"
import type { LimitsMeterStatus } from "@/types/subscription"

/** The four per-window quotas Anthropic reports on a response. */
export type RateLimitKind = "requests" | "tokens" | "input-tokens" | "output-tokens"

/** One live quota window parsed from the response headers. */
export interface RateLimitMeter {
  kind: RateLimitKind
  /** English display label (the Ink TUI is English). */
  label: string
  /** Short unit suffix for the right-aligned figure ("req" | "tok"). */
  unit: string
  limit: number
  remaining: number
  /** Consumed share of the window, 0-100 (clamped). */
  usedPct: number
  /** Epoch ms the window resets, or null when the header was unparseable. */
  resetAt: number | null
}

/** The latest live rate-limit reading captured from the API. */
export interface RateLimitSnapshot {
  meters: RateLimitMeter[]
  /** Epoch ms the headers were observed (drives "as of" staleness, if shown). */
  capturedAt: number
}

const KINDS: { kind: RateLimitKind; label: string; unit: string }[] = [
  { kind: "requests", label: "Requests", unit: "req" },
  { kind: "tokens", label: "Tokens", unit: "tok" },
  { kind: "input-tokens", label: "Input tokens", unit: "tok" },
  { kind: "output-tokens", label: "Output tokens", unit: "tok" },
]

/** Finite-number coercion: returns null for missing / non-numeric headers. */
function num(value: string | undefined): number | null {
  if (value == null) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * Parse a `*-reset` header into epoch ms. Anthropic sends an RFC-3339 timestamp
 * (e.g. `2024-01-01T00:00:00Z`); a bare number is treated as seconds-from-now (the
 * `retry-after` lineage). Returns null when neither shape parses.
 */
export function parseResetAt(value: string | undefined, now: number): number | null {
  if (value == null) return null
  const iso = Date.parse(value)
  if (Number.isFinite(iso)) return iso
  const secs = Number(value)
  if (Number.isFinite(secs)) return now + secs * 1000
  return null
}

/** usedPct = (limit - remaining) / limit, clamped to 0-100 (limit 0 → 0). */
function usedPctOf(limit: number, remaining: number): number {
  if (limit <= 0) return 0
  const pct = ((limit - remaining) / limit) * 100
  return Math.max(0, Math.min(100, Math.round(pct)))
}

/**
 * Fold a captured `anthropic-ratelimit-*` header bag into a snapshot. Header
 * keys are lowercased by the interceptor. Returns null when no quota window had
 * both a limit and a remaining figure (e.g. a non-Anthropic response).
 */
export function parseRateLimitHeaders(
  headers: Record<string, string>,
  now: number
): RateLimitSnapshot | null {
  const meters: RateLimitMeter[] = []
  for (const { kind, label, unit } of KINDS) {
    const prefix = `anthropic-ratelimit-${kind}-`
    const limit = num(headers[`${prefix}limit`])
    const remaining = num(headers[`${prefix}remaining`])
    if (limit == null || remaining == null) continue
    meters.push({
      kind,
      label,
      unit,
      limit,
      remaining,
      usedPct: usedPctOf(limit, remaining),
      resetAt: parseResetAt(headers[`${prefix}reset`], now),
    })
  }
  if (meters.length === 0) return null
  return { meters, capturedAt: now }
}

/** Severity from consumed share — mirrors the subscription meter thresholds. */
export function rateLimitSeverity(usedPct: number): LimitsMeterStatus {
  if (usedPct >= 100) return "exceeded"
  if (usedPct >= 90) return "crit"
  if (usedPct >= 75) return "warn"
  return "ok"
}

/** Theme palette token for a meter's bar fill, reusing the subscription mapping. */
export function rateLimitColor(usedPct: number): MeterColorToken {
  return meterColor(rateLimitSeverity(usedPct))
}

/** Reset subtitle for a live meter, or null when there's no parseable reset. */
export function rateLimitResetText(resetAt: number | null, now: number): string | null {
  if (resetAt == null) return null
  const c = splitCountdown(resetAt - now)
  if (c.expired) return "Resets shortly"
  if (c.hours > 0) return `Resets in ${c.hours}h ${c.minutes}m`
  return `Resets in ${c.minutes}m`
}

/** Right-aligned figure: "1,234 tok left" (uses the meter's own unit). */
export function rateLimitRightLabel(m: RateLimitMeter): string {
  return `${m.remaining.toLocaleString("en-US")} ${m.unit} left`
}

/**
 * The tightest remaining headroom across all windows, as a whole percent — the
 * footer's one-glyph "how close to a 429" summary. null when no meter has a
 * positive limit. Lower = closer to throttling.
 */
export function tightestRemainingPct(snapshot: RateLimitSnapshot): number | null {
  let min: number | null = null
  for (const m of snapshot.meters) {
    if (m.limit <= 0) continue
    const remPct = Math.max(0, Math.min(100, Math.round((m.remaining / m.limit) * 100)))
    if (min == null || remPct < min) min = remPct
  }
  return min
}
