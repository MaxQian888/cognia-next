// Codex / ChatGPT windowed-usage limits source.
//
// ChatGPT subscriptions expose a primary (≈5h) + secondary (≈weekly) rate-limit
// window. The real backend endpoint is `…/backend-api/wham/usage`, which returns
// `rate_limit.{primary_window,secondary_window}` (each `{ used_percent,
// limit_window_seconds, reset_at }`, `reset_at` in unix seconds) — the same
// shape the `codex` CLI and CC Switch render. We query that by default and parse
// its `*_window` fields first, then fall back to the older
// `{ primary, secondary }` shape so a relay reporting the legacy layout still
// lights up.
//
// Verified against `openai/codex` (`codex-rs/chatgpt/src/chatgpt_client.rs`,
// `codex-rs/cloud-tasks/src/util.rs::normalize_base_url`, 2026-07-16). Three
// facts from upstream drive the shape of this file:
//
//   1. The path is `/wham/usage` under `PathStyle::ChatGptApi`, hung off the
//      `chatgpt_base_url` root (`https://chatgpt.com/backend-api`) — NOT off the
//      Responses base (`…/backend-api/codex`) a chat preset carries. Appending
//      `/wham/usage` to the preset baseUrl produced `…/codex/wham/usage` (404)
//      or `…/v1/wham/usage` (404), which is why `resolveUsageBase` refuses to
//      reuse a preset base that isn't the ChatGPT backend root.
//   2. The endpoint needs the SAME identity headers the chat path sends
//      (`chat-bridge.ts`) — above all `ChatGPT-Account-Id`, which selects WHICH
//      subscription's quota to report. Bearer-only got a 401.
//   3. It is ChatGPT-auth-only: "chatgpt authentication required to read rate
//      limits". An `api_key` login has no usage endpoint at all, so this source
//      declines (returns `null`) and lets the credit-balance source answer.
//
// Failures are surfaced as an `error` snapshot rather than swallowed. The old
// bare `catch { return null }` made a 401/404/429 indistinguishable from "no
// data": the panel rendered blank with nothing in the log, and every one of the
// bugs above was invisible for years. `subscription_authed_get` already throws a
// well-formed `"{status}: {body}"` — we keep it. Mirrors `sources/anthropic.ts`.

import { errorLimits, windowMeter } from "../meters"

import type {
  CodexCredentialData,
  LimitsMeter,
  LimitsSource,
  LimitsSourceContext,
  ProviderLimits,
} from "@/types/subscription"

/** ChatGPT backend rate-limit path, hung off the backend-api root. */
const DEFAULT_USAGE_PATH = "/wham/usage"

/** The ChatGPT backend root. Upstream's `chatgpt_base_url` default. */
const CHATGPT_BACKEND_BASE = "https://chatgpt.com/backend-api"

/** Hosts that serve the ChatGPT backend (upstream `normalize_base_url`). */
const CHATGPT_HOST_RE = /^https?:\/\/(chatgpt\.com|chat\.openai\.com)(\/|$)/i

/**
 * Resolve the base to hang `/wham/usage` off, or `null` when this account's
 * endpoint can't serve it.
 *
 * A preset baseUrl describes where *chat* goes, which is a different surface
 * from the usage endpoint even on the genuine backend. So we only reuse a preset
 * base when it is a ChatGPT host, and then normalize it to the backend root
 * (dropping the `/codex` Responses prefix). A relay/Azure/api.openai.com base
 * yields `null` rather than silently retargeting the request at chatgpt.com —
 * that would ship the relay's bearer to OpenAI, which is a credential leak, not
 * a fallback.
 */
export function resolveUsageBase(baseUrl?: string): string | null {
  const trimmed = baseUrl?.trim().replace(/\/+$/, "")
  if (!trimmed) return CHATGPT_BACKEND_BASE
  if (!CHATGPT_HOST_RE.test(trimmed)) return null
  const root = trimmed.replace(/\/codex$/i, "").replace(/\/backend-api$/i, "")
  return `${root}/backend-api`
}

/**
 * Identity headers for the ChatGPT backend, mirroring `chat-bridge.ts` — the
 * one Codex path in this repo known to authenticate successfully.
 */
export function usageHeaders(
  token: string,
  credential: CodexCredentialData | null
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "OpenAI-Beta": "responses=experimental",
    originator: "codex_cli_rs",
    "OAI-Product-Sku": "codex",
    "User-Agent": "codex-cli",
  }
  const accountId = credential?.accountId?.trim()
  if (accountId) headers["ChatGPT-Account-Id"] = accountId
  return headers
}

type UsageFailure = { kind: "auth" | "http" | "network"; message: string }
type UsageResult = { ok: true; body: string } | ({ ok: false } & UsageFailure)

/**
 * Classify a thrown transport error. `subscription_authed_get` rejects non-2xx
 * as `"{status}: {body}"`, so the status is recoverable from the message; an
 * auth verdict is what drives the one reactive token refresh.
 */
export function classifyUsageError(err: unknown): UsageFailure {
  const message = err instanceof Error ? err.message : String(err)
  const status = /^\s*(\d{3})\b/.exec(message)?.[1]
  if (status === "401" || status === "403") return { kind: "auth", message }
  if (status) return { kind: "http", message }
  return { kind: "network", message }
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

/** One `/wham/usage` GET, normalized into a result rather than a throw. */
async function callUsage(
  ctx: LimitsSourceContext,
  url: string,
  token: string,
  credential: CodexCredentialData | null
): Promise<UsageResult> {
  try {
    return { ok: true, body: await ctx.authedGet(url, usageHeaders(token, credential)) }
  } catch (err) {
    return { ok: false, ...classifyUsageError(err) }
  }
}

export const codexLimitsSource: LimitsSource = {
  key: "codex",

  // Provider alone. The old `looksLikeChatgpt` gate also rejected on
  // `providerKey`, but that is the preset's `templateId` — Codex presets are
  // built from the `openai-compatible`/`openrouter` catalog families, so a
  // perfectly good ChatGPT account whose preset came from the catalog made this
  // source never match at all. `authMode` (checked in `fetch`) is the
  // authoritative signal for "is this a ChatGPT subscription", not the preset.
  matches(q) {
    return q.provider === "codex"
  },

  async fetch(ctx: LimitsSourceContext): Promise<ProviderLimits | null> {
    const credential: CodexCredentialData | null =
      ctx.credential?.provider === "codex" ? ctx.credential : null

    // Rate-limit windows are a ChatGPT-subscription concept. An api_key login
    // has no usage endpoint upstream, so decline and let the credit-balance
    // source answer for it (the UI explains the gap). Only decline on a KNOWN
    // non-chatgpt mode — an absent credential keeps the legacy behavior.
    if (credential && credential.authMode !== "chatgpt") return null
    if (!ctx.token) return null

    const base = resolveUsageBase(ctx.baseUrl)
    if (!base) return null
    const url = `${base}${DEFAULT_USAGE_PATH}`

    let token = ctx.token
    let result = await callUsage(ctx, url, token, credential)

    // One reactive refresh on a real 401/403. Codex bearers expire (~ChatGPT
    // session lifetime) and the runner refreshes proactively, but a token can
    // still age out between resolve and fetch.
    if (!result.ok && result.kind === "auth" && ctx.refreshToken) {
      const refreshed = await ctx.refreshToken().catch(() => null)
      if (refreshed && refreshed !== token) {
        token = refreshed
        result = await callUsage(ctx, url, token, credential)
      }
    }

    // A 401/404/429/outage is NOT "no windows" — surface it so the panel can
    // say why instead of rendering blank.
    if (!result.ok) return errorLimits(ctx, "codex", result.message)

    // Prefer the real wham/usage layout; fall back to the legacy shape so a
    // relay reporting `{ primary, secondary }` still resolves.
    const meters = parseWhamUsage(result.body, ctx.now)
    const resolved = meters.length > 0 ? meters : parseCodexWindows(result.body, ctx.now)
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
