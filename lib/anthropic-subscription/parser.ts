// Pure header parser. Takes a `Headers` instance (or a plain header bag) and
// returns a `UsageSnapshot`. Tolerant of missing fields — anything we can't
// parse cleanly is set to `null` rather than throwing, so a transient blip
// in Anthropic's response shape never crashes the collector.
//
// Field-level reference: anthropics/claude-code#12829 (verbatim header dump
// from a real /v1/messages 200 response).

import type { RepresentativeClaim, UsageSnapshot, UsageStatus, UsageWindow } from "./types"

/**
 * Raw shape we accept. `Headers` exposes `.get`/`.entries`; plain objects work
 * via `Object.entries`. Both Node fetch + Vercel AI SDK return real `Headers`,
 * but tests + the sidecar bridge often hand us a plain map.
 */
export type HeaderInput = Headers | Record<string, string>

const RATELIMIT_PREFIX = "anthropic-ratelimit-"

function readHeader(headers: HeaderInput, name: string): string | null {
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    return headers.get(name)
  }
  // Headers are case-insensitive on the wire; normalise to lower-case.
  const target = name.toLowerCase()
  for (const [k, v] of Object.entries(headers as Record<string, string>)) {
    if (k.toLowerCase() === target) return v
  }
  return null
}

function collectRawHeaders(headers: HeaderInput): Record<string, string> {
  const out: Record<string, string> = {}
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    headers.forEach((value, key) => {
      if (key.toLowerCase().startsWith(RATELIMIT_PREFIX)) {
        out[key.toLowerCase()] = value
      }
    })
    return out
  }
  for (const [k, v] of Object.entries(headers as Record<string, string>)) {
    if (k.toLowerCase().startsWith(RATELIMIT_PREFIX)) {
      out[k.toLowerCase()] = v
    }
  }
  return out
}

function parseFloatOrNull(value: string | null): number | null {
  if (value == null || value === "") return null
  const n = Number.parseFloat(value)
  return Number.isFinite(n) ? n : null
}

/**
 * Anthropic emits `*-reset` as a Unix-seconds integer. Our app works in
 * ms-epoch everywhere; convert here so consumers don't have to remember.
 */
function parseResetAtMs(value: string | null): number | null {
  if (value == null || value === "") return null
  const seconds = Number.parseInt(value, 10)
  if (!Number.isFinite(seconds)) return null
  return seconds * 1000
}

function parseStatus(value: string | null): UsageStatus {
  switch (value) {
    case "allowed":
    case "allowed_warning":
    case "rate_limited":
      return value
    default:
      return "unknown"
  }
}

function parseClaim(value: string | null): RepresentativeClaim | null {
  return value === "five_hour" || value === "seven_day" ? value : null
}

function buildWindow(
  utilization: number | null,
  resetAt: number | null,
  status: string | null
): UsageWindow | null {
  if (utilization == null || resetAt == null) return null
  return { utilization, resetAt, status: status ?? "" }
}

/**
 * Parse the unified-rate-limit header set from a `/v1/messages` response.
 *
 * @param headers   Source headers (Headers or plain bag)
 * @param source    "passive" when collected from a real chat response,
 *                  "probe"   when collected by the active probe loop.
 * @param fetchedAt ms-epoch timestamp of the parse, defaults to Date.now().
 */
export function parseUsageHeaders(
  headers: HeaderInput,
  source: UsageSnapshot["source"] = "passive",
  fetchedAt: number = Date.now()
): UsageSnapshot {
  const status = parseStatus(readHeader(headers, "anthropic-ratelimit-unified-status"))
  const claim = parseClaim(readHeader(headers, "anthropic-ratelimit-unified-representative-claim"))

  const fiveHour = buildWindow(
    parseFloatOrNull(readHeader(headers, "anthropic-ratelimit-unified-5h-utilization")),
    parseResetAtMs(readHeader(headers, "anthropic-ratelimit-unified-5h-reset")),
    readHeader(headers, "anthropic-ratelimit-unified-5h-status")
  )

  const sevenDay = buildWindow(
    parseFloatOrNull(readHeader(headers, "anthropic-ratelimit-unified-7d-utilization")),
    parseResetAtMs(readHeader(headers, "anthropic-ratelimit-unified-7d-reset")),
    readHeader(headers, "anthropic-ratelimit-unified-7d-status")
  )

  const fallbackPercentage = parseFloatOrNull(
    readHeader(headers, "anthropic-ratelimit-unified-fallback-percentage")
  )

  const overageDisabledReason = readHeader(
    headers,
    "anthropic-ratelimit-unified-overage-disabled-reason"
  )

  return {
    fetchedAt,
    source,
    status,
    representativeClaim: claim,
    fiveHour,
    sevenDay,
    fallbackPercentage,
    overageDisabledReason,
    rawHeaders: collectRawHeaders(headers),
  }
}

/**
 * `true` when the headers carry at least the unified-status field. Use this
 * to short-circuit out of writing a snapshot when the response didn't come
 * with any rate-limit info (e.g. 4xx errors before the gate, or API-key mode
 * which may not emit the unified-* family).
 */
export function hasUsageHeaders(headers: HeaderInput): boolean {
  return readHeader(headers, "anthropic-ratelimit-unified-status") != null
}
