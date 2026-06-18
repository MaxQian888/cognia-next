// Codex / ChatGPT windowed-usage limits source.
//
// ChatGPT subscriptions expose a primary (≈5h) + secondary (≈weekly) rate-limit
// window. The real backend endpoint is `…/backend-api/wham/usage`, which returns
// `rate_limit.{primary_window,secondary_window}` (each `{ used_percent,
// limit_window_seconds, reset_at }`, `reset_at` in unix seconds) — the same
// shape the `codex` CLI and CC Switch render. We query that by default and parse
// its `*_window` fields first, then fall back to the older
// `{ primary, secondary }` shape so a relay reporting the legacy layout still
// lights up. On any failure — transport error, unexpected shape, missing fields
// — the source returns `null`, letting the runner fall through (the panel shows
// "no limit data") exactly like an unavailable balance. The endpoint is
// overridable via the account's preset baseUrl.

import { windowMeter } from "../meters"

import type {
  LimitsMeter,
  LimitsSource,
  LimitsSourceContext,
  ProviderLimits,
} from "@/types/subscription"

/** Default ChatGPT backend rate-limit endpoint. Overridable via preset baseUrl. */
const DEFAULT_USAGE_PATH = "/wham/usage"

/** Only the genuine ChatGPT/OpenAI endpoint reports these windows. */
function looksLikeChatgpt(q: { providerKey?: string; baseUrl?: string }): boolean {
  const key = q.providerKey
  if (key && key !== "openai" && key !== "codex" && key !== "chatgpt") return false
  const base = q.baseUrl
  if (base && !/openai\.com|chatgpt\.com|api\.openai/i.test(base)) return false
  return true
}

interface RawWindow {
  used_percent?: unknown
  usage_percent?: unknown
  resets_at?: unknown
  resets_in_seconds?: unknown
}

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : v
  return typeof n === "number" && Number.isFinite(n) ? n : null
}

/** Resolve a reset wall-clock (ms) from `resets_at` (sec or ms) or a relative delta. */
function resolveResetAt(w: RawWindow, now: number): number | null {
  const at = num(w.resets_at)
  if (at != null) return at < 1e12 ? at * 1000 : at // seconds → ms heuristic
  const inSec = num(w.resets_in_seconds)
  if (inSec != null) return now + inSec * 1000
  return null
}

function windowFrom(
  w: RawWindow | undefined,
  id: string,
  labelKey: string,
  now: number
): LimitsMeter | null {
  if (!w || typeof w !== "object") return null
  const pct = num(w.used_percent) ?? num(w.usage_percent)
  if (pct == null) return null
  return windowMeter(id, labelKey, { utilization: pct, resetAt: resolveResetAt(w, now) })
}

interface WhamWindow {
  used_percent?: unknown
  // The Codex `RateLimitWindow` field is `resets_at` (unix seconds). Older
  // captures and some relays emit `reset_at`; accept both.
  resets_at?: unknown
  reset_at?: unknown
  // Rolling-window duration (minutes), used to derive a reset when neither
  // absolute timestamp is present.
  window_minutes?: unknown
}

/**
 * Resolve a wham window's reset wall-clock (epoch ms). Prefers the absolute
 * `resets_at`/`reset_at` (unix seconds, or already-ms); falls back to
 * `now + window_minutes` so a window that only reports its duration still shows
 * a countdown.
 */
function whamReset(w: WhamWindow, now: number): number | null {
  const at = num(w.resets_at) ?? num(w.reset_at)
  if (at != null) return at < 1e12 ? at * 1000 : at
  const mins = num(w.window_minutes)
  if (mins != null) return now + mins * 60_000
  return null
}

function whamWindowFrom(
  w: WhamWindow | undefined,
  id: string,
  labelKey: string,
  now: number
): LimitsMeter | null {
  if (!w || typeof w !== "object") return null
  const pct = num(w.used_percent)
  if (pct == null) return null
  return windowMeter(id, labelKey, { utilization: pct, resetAt: whamReset(w, now) })
}

/**
 * Parse the real `wham/usage` shape (Codex `RateLimitSnapshot`):
 *   { rate_limit: { primary_window, secondary_window } }
 * each window `{ used_percent, window_minutes, resets_at(unix s) }`.
 * primary → 5h session, secondary → weekly.
 */
export function parseWhamUsage(body: string, now: number): LimitsMeter[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== "object") return []
  const root = parsed as Record<string, unknown>
  const rl = root.rate_limit
  if (!rl || typeof rl !== "object") return []
  const limits = rl as { primary_window?: WhamWindow; secondary_window?: WhamWindow }

  const meters: LimitsMeter[] = []
  const primary = whamWindowFrom(
    limits.primary_window,
    "session",
    "subscription.limits.meter.session",
    now
  )
  if (primary) meters.push(primary)
  const secondary = whamWindowFrom(
    limits.secondary_window,
    "weekly",
    "subscription.limits.meter.weekly",
    now
  )
  if (secondary) meters.push(secondary)
  return meters
}

/** Parse the defensive `{ primary, secondary }` (optionally under `rate_limits`) shape. */
export function parseCodexWindows(body: string, now: number): LimitsMeter[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== "object") return []
  const root = parsed as Record<string, unknown>
  const limits = (
    root.rate_limits && typeof root.rate_limits === "object"
      ? (root.rate_limits as Record<string, unknown>)
      : root
  ) as { primary?: RawWindow; secondary?: RawWindow }

  const meters: LimitsMeter[] = []
  const primary = windowFrom(limits.primary, "session", "subscription.limits.meter.session", now)
  if (primary) meters.push(primary)
  const secondary = windowFrom(limits.secondary, "weekly", "subscription.limits.meter.weekly", now)
  if (secondary) meters.push(secondary)
  return meters
}

export const codexLimitsSource: LimitsSource = {
  key: "codex",

  matches(q) {
    return q.provider === "codex" && looksLikeChatgpt(q)
  },

  async fetch(ctx: LimitsSourceContext): Promise<ProviderLimits | null> {
    if (!ctx.token) return null
    const base = (ctx.baseUrl ?? "https://chatgpt.com/backend-api").replace(/\/+$/, "")
    const url = `${base}${DEFAULT_USAGE_PATH}`

    let body: string
    try {
      body = await ctx.authedGet(url, {
        Authorization: `Bearer ${ctx.token}`,
        Accept: "application/json",
      })
    } catch {
      return null
    }

    // Prefer the real wham/usage layout; fall back to the legacy shape so a
    // relay reporting `{ primary, secondary }` still resolves.
    const meters = parseWhamUsage(body, ctx.now)
    const resolved = meters.length > 0 ? meters : parseCodexWindows(body, ctx.now)
    if (resolved.length === 0) return null

    return {
      provider: "codex",
      accountId: ctx.accountId,
      accountLabel: ctx.accountLabel,
      fetchedAt: ctx.now,
      meters: resolved,
    }
  },
}
