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

import { CLAUDE_CLI_USER_AGENT } from "@/lib/subscription/anthropic/constants"
import { balanceMeter, windowMeter } from "@/lib/subscription/limits/meters"

import type { BalanceSnapshot, LimitsMeter } from "@/types/subscription"

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
 * A window key we don't know about yet. cc-switch's `query_claude_quota` walks
 * every field outside its `KNOWN_TIERS` list rather than a fixed map, so a
 * server-side tier addition degrades to "shown with a raw label" instead of
 * "silently absent". `labelKey` is deliberately left unset: no i18n key can
 * exist for a tier we've never seen, and `MeterRow` already falls back to
 * `label` (guarded by `tr.has`).
 */
function unknownWindowFrom(key: string, w: unknown): LimitsMeter | null {
  const meter = windowFrom(w, key, "")
  if (!meter) return null
  return { ...meter, labelKey: undefined, label: key }
}

interface OAuthExtraUsage {
  is_enabled?: unknown
  monthly_limit?: unknown
  used_credits?: unknown
  currency?: unknown
}

/**
 * Build a balance meter for Claude's pay-as-you-go overage (`extra_usage`) when
 * it's enabled. `monthly_limit`/`used_credits` are currency amounts; we surface
 * the spent-vs-cap as a credit meter. Returns `null` when overage is off or the
 * numbers aren't usable. Mirrors CCSwitch's `SubscriptionQuota.extra_usage`.
 */
function overageFrom(raw: unknown): LimitsMeter | null {
  if (!raw || typeof raw !== "object") return null
  const x = raw as OAuthExtraUsage
  if (x.is_enabled !== true) return null
  const total = num(x.monthly_limit)
  const used = num(x.used_credits)
  if (total == null && used == null) return null
  const currency = typeof x.currency === "string" ? x.currency : "USD"
  const snap: BalanceSnapshot = {
    fetchedAt: 0,
    providerKey: "anthropic",
    accountId: "",
    kind: "credit",
    currency,
    unit: currency,
    total: total ?? undefined,
    used: used ?? undefined,
    remaining: total != null && used != null ? Math.max(0, total - used) : undefined,
    raw: x as Record<string, unknown>,
  }
  return balanceMeter(snap, {
    id: "overage",
    labelKey: "subscription.limits.meter.overage",
  })
}

/**
 * Parse the OAuth usage body into ordered meters
 * (session / weekly / weekly_opus / weekly_sonnet). Windows absent from the
 * response are simply skipped.
 */
export function parseOAuthUsage(body: string): LimitsMeter[] {
  return parseOAuthUsageBody(body)?.meters ?? []
}

/**
 * Parse the body into meters, distinguishing "not a JSON object" (`null` — the
 * endpoint contract broke) from "valid object, no windows in it" (`[]`). The
 * old `[]`-for-everything return made those indistinguishable, so a changed
 * response shape looked exactly like an idle account.
 */
export function parseOAuthUsageBody(body: string): { meters: LimitsMeter[] } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null
  const root = parsed as Record<string, unknown>
  const meters: LimitsMeter[] = []
  for (const { key, id, labelKey } of WINDOW_MAP) {
    const meter = windowFrom(root[key], id, labelKey)
    if (meter) meters.push(meter)
  }
  // Any remaining window-shaped field is a tier we don't model yet.
  const known = new Set(WINDOW_MAP.map((w) => w.key))
  for (const key of Object.keys(root)) {
    if (known.has(key) || key === "extra_usage") continue
    const meter = unknownWindowFrom(key, root[key])
    if (meter) meters.push(meter)
  }
  const overage = overageFrom(root.extra_usage)
  if (overage) meters.push(overage)
  return { meters }
}

export interface OAuthUsageDeps {
  authedGet: (url: string, headers?: Record<string, string>) => Promise<string>
}

/**
 * Why the reading failed. Mirrors the distinction cc-switch's
 * `query_claude_quota` draws: 401/403 means "re-login" (`CredentialStatus::Expired`),
 * every other non-2xx surfaces the HTTP status + body verbatim. Each kind needs a
 * different response — refresh the bearer / back off / show the outage — and the
 * previous `[]`-for-everything return made them indistinguishable.
 */
export type OAuthUsageFailureKind = "auth" | "rate_limited" | "http" | "network" | "parse"

export interface OAuthUsageFailure {
  ok: false
  kind: OAuthUsageFailureKind
  /** HTTP status when the transport surfaced one. */
  status?: number
  /** Verbatim detail, surfaced through `ProviderLimits.error`. */
  message: string
}

export type OAuthUsageResult = { ok: true; meters: LimitsMeter[] } | OAuthUsageFailure

/**
 * Recover the failure kind from a rejected `authedGet`. The Rust
 * `subscription_authed_get` command rejects non-2xx as `"{status}: {body}"`
 * (e.g. `"429 Too Many Requests: ..."`), and Tauri rejects with the bare
 * `Err(String)` payload rather than an `Error`, so both shapes are handled.
 */
export function classifyUsageError(err: unknown): OAuthUsageFailure {
  const message = err instanceof Error ? err.message : String(err)
  const matched = /(^|\s)(\d{3})(\s|:)/.exec(message)
  const status = matched ? Number(matched[2]) : null
  if (status == null) return { ok: false, kind: "network", message }
  if (status === 401 || status === 403) return { ok: false, kind: "auth", status, message }
  if (status === 429) return { ok: false, kind: "rate_limited", status, message }
  return { ok: false, kind: "http", status, message }
}

/**
 * Fetch + parse the free OAuth usage windows. Never throws: every outcome is
 * reported as a discriminated result so the caller can tell an expired bearer
 * from a throttle from a broken response contract.
 */
export async function fetchOAuthUsage(
  token: string,
  deps: OAuthUsageDeps
): Promise<OAuthUsageResult> {
  let body: string
  try {
    body = await deps.authedGet(OAUTH_USAGE_ENDPOINT, {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": OAUTH_USAGE_BETA,
      Accept: "application/json",
      // A `claude-cli/...`-shaped User-Agent is required: without it the endpoint
      // serves an aggressively rate-limited 429 bucket, which would silently push
      // every poll onto the paid probe fallback (~10 tokens/poll). Anthropic
      // validates the shape, not the version (see constants.ts).
      "User-Agent": CLAUDE_CLI_USER_AGENT,
    })
  } catch (err) {
    return classifyUsageError(err)
  }
  const parsed = parseOAuthUsageBody(body)
  if (!parsed) {
    return {
      ok: false,
      kind: "parse",
      message: `unrecognized usage response: ${body.slice(0, 200)}`,
    }
  }
  return { ok: true, meters: parsed.meters }
}
