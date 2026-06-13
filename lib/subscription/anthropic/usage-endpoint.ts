// Free Claude subscription usage endpoint.
//
// `GET https://api.anthropic.com/api/oauth/usage` (header
// `anthropic-beta: oauth-2025-04-20`) returns the same rate-limit windows the
// official Claude clients show — `five_hour`, `seven_day`, `seven_day_opus`,
// `seven_day_sonnet`, each `{ utilization: 0-100, resets_at: ISO8601 }` — at
// ZERO token cost. This replaces the paid `probeOnce` (which spends ~10 tokens
// per poll) as the primary reading for the unified limits panel; the probe
// stays as a fallback. The 7-day opus/sonnet windows are not visible through
// the header path at all, so this also surfaces two windows we couldn't show
// before.

import { windowMeter } from "@/lib/subscription/limits/meters"

import type { LimitsMeter } from "@/types/subscription"

/** The free OAuth usage endpoint. */
export const OAUTH_USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage"
/** Required beta header for the OAuth usage endpoint. */
export const OAUTH_USAGE_BETA = "oauth-2025-04-20"

interface OAuthWindow {
  utilization?: unknown
  resets_at?: unknown
}

/** Map each response key to a stable meter id + i18n label. */
const WINDOW_MAP: ReadonlyArray<{ key: string; id: string; labelKey: string }> = [
  { key: "five_hour", id: "session", labelKey: "subscription.limits.meter.session" },
  { key: "seven_day", id: "weekly", labelKey: "subscription.limits.meter.weekly" },
  { key: "seven_day_opus", id: "weekly_opus", labelKey: "subscription.limits.meter.weekly_opus" },
  {
    key: "seven_day_sonnet",
    id: "weekly_sonnet",
    labelKey: "subscription.limits.meter.weekly_sonnet",
  },
]

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : v
  return typeof n === "number" && Number.isFinite(n) ? n : null
}

/** Resolve an ISO `resets_at` to epoch ms, or `null`. */
function resolveReset(w: OAuthWindow): number | null {
  if (typeof w.resets_at === "string") {
    const ms = Date.parse(w.resets_at)
    if (Number.isFinite(ms)) return ms
  }
  // Tolerate a numeric unix-seconds/ms reset just in case.
  const n = num(w.resets_at)
  if (n == null) return null
  return n < 1e12 ? n * 1000 : n
}

function windowFrom(w: unknown, id: string, labelKey: string): LimitsMeter | null {
  if (!w || typeof w !== "object") return null
  const win = w as OAuthWindow
  const pct = num(win.utilization)
  if (pct == null) return null
  return windowMeter(id, labelKey, { utilization: pct, resetAt: resolveReset(win) })
}

/**
 * Parse the OAuth usage body into ordered meters
 * (session / weekly / weekly_opus / weekly_sonnet). Windows absent from the
 * response are simply skipped.
 */
export function parseOAuthUsage(body: string): LimitsMeter[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== "object") return []
  const root = parsed as Record<string, unknown>
  const meters: LimitsMeter[] = []
  for (const { key, id, labelKey } of WINDOW_MAP) {
    const meter = windowFrom(root[key], id, labelKey)
    if (meter) meters.push(meter)
  }
  return meters
}

export interface OAuthUsageDeps {
  authedGet: (url: string, headers?: Record<string, string>) => Promise<string>
}

/**
 * Fetch + parse the free OAuth usage windows. Returns `[]` on any failure
 * (transport, non-JSON, no recognizable windows) so the caller can fall back to
 * the paid probe.
 */
export async function fetchOAuthUsage(token: string, deps: OAuthUsageDeps): Promise<LimitsMeter[]> {
  let body: string
  try {
    body = await deps.authedGet(OAUTH_USAGE_ENDPOINT, {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": OAUTH_USAGE_BETA,
      Accept: "application/json",
    })
  } catch {
    return []
  }
  return parseOAuthUsage(body)
}
