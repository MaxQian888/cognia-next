// Codex / ChatGPT windowed-usage limits source (best-effort).
//
// ChatGPT subscriptions expose a primary (≈5h) + secondary (≈weekly) rate-limit
// window, the same shape the `codex` CLI renders. Unlike Anthropic there is no
// stable, documented public endpoint we can rely on, so this source is
// deliberately defensive: it performs the injected authed GET and only emits
// meters when the response actually carries recognizable window fields. On any
// failure — transport error, unexpected shape, missing fields — it returns
// `null`, which lets the runner fall through (and the panel show "no limit
// data") exactly like an unavailable balance. The endpoint is overridable via
// the account's preset baseUrl so a working relay can light it up without a
// code change.

import { windowMeter } from "../meters"

import type {
  LimitsMeter,
  LimitsSource,
  LimitsSourceContext,
  ProviderLimits,
} from "@/types/subscription"

/** Default ChatGPT backend rate-limit endpoint. Overridable via preset baseUrl. */
const DEFAULT_USAGE_PATH = "/me/rate_limits"

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

    const meters = parseCodexWindows(body, ctx.now)
    if (meters.length === 0) return null

    return {
      provider: "codex",
      accountId: ctx.accountId,
      accountLabel: ctx.accountLabel,
      fetchedAt: ctx.now,
      meters,
    }
  },
}
