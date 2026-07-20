// Active probe loop for the Claude unified rate-limit headers.
//
// The user opts in (Settings → Subscription → Claude → Settings: probeEnabled).
// When enabled, this module sends a near-empty `/v1/messages` request and
// parses `anthropic-ratelimit-*` from the response headers, persisting one
// `source: "probe"` row per successful call.
//
// IMPORTANT: each probe consumes ~10 input tokens + 1 output token of the
// user's quota. Anthropic does NOT offer a documented free probe carve-out
// (verified via [Anthropic pricing docs](https://platform.claude.com/docs/en/about-claude/pricing));
// the UI must surface this so the user understands the cost.

import type { AnthropicCredentialData, UsageSnapshot } from "@/types/subscription"
import { OAUTH_REQUEST_HEADERS } from "./constants"
import { hasUsageHeaders, parseUsageHeaders } from "./parser"
import { recordUsageSnapshot } from "./usage-collector"

const MESSAGES_ENDPOINT = "https://api.anthropic.com/v1/messages"
/** Cheapest model that still emits the unified-* headers. */
const PROBE_MODEL = "claude-haiku-4-5-20251001"

export interface ProbeResult {
  ok: true
  snapshot: UsageSnapshot
}

export interface ProbeFailure {
  ok: false
  reason: "auth" | "rate-limited" | "no-headers" | "transport" | "http"
  status?: number
  message?: string
}

export type ProbeOutcome = ProbeResult | ProbeFailure

export async function probeOnce(
  credential: AnthropicCredentialData,
  options: { fetchImpl?: typeof fetch; now?: () => number } = {}
): Promise<ProbeOutcome> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const now = options.now ?? (() => Date.now())

  const body = JSON.stringify({
    model: PROBE_MODEL,
    max_tokens: 1,
    messages: [{ role: "user", content: "." }],
  })

  let response: Response
  try {
    response = await fetchImpl(MESSAGES_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${credential.accessToken}`,
        ...OAUTH_REQUEST_HEADERS,
      },
      body,
    })
  } catch (err) {
    return {
      ok: false,
      reason: "transport",
      message: err instanceof Error ? err.message : String(err),
    }
  }

  if (response.status === 401 || response.status === 403) {
    return { ok: false, reason: "auth", status: response.status }
  }
  if (response.status === 429) {
    if (hasUsageHeaders(response.headers)) {
      const snapshot = parseUsageHeaders(response.headers, "probe", now())
      return { ok: true, snapshot }
    }
    return { ok: false, reason: "rate-limited", status: 429 }
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "")
    return { ok: false, reason: "http", status: response.status, message: text }
  }

  if (!hasUsageHeaders(response.headers)) {
    return { ok: false, reason: "no-headers", status: response.status }
  }

  const snapshot = parseUsageHeaders(response.headers, "probe", now())
  return { ok: true, snapshot }
}

export async function runOnceAndPersist(
  credential: AnthropicCredentialData
): Promise<
  { ok: true; persisted: Awaited<ReturnType<typeof recordUsageSnapshot>> } | ProbeFailure
> {
  const outcome = await probeOnce(credential)
  if (!outcome.ok) return outcome
  const persisted = await recordUsageSnapshot(outcome.snapshot)
  return { ok: true, persisted }
}
