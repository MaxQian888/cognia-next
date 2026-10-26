/**
 * The outcome vocabulary every reader stage reports to the configured Reader
 * (`./configured-reader`). One stage = one attempt by one reader.
 *
 * A stage either produced readable content, produced an HTTP outcome the
 * caller should see as-is (a direct 404, a raw body), or failed with a
 * classified reason. The class decides routing: only the fallback-eligible
 * classes may move on to another reader; everything else is terminal.
 */

import type { WebReaderId } from "@cognia/agent-config-types"

/**
 * Why a read did not produce content.
 *
 * Fallback-eligible: `network`, `thin`, `binary`, `anti-bot`, `attempt-timeout`,
 * `vendor-auth`, `vendor-quota`, `vendor-rate-limit`, `vendor-refused`,
 * `vendor-error`, `unavailable`.
 * Terminal: `not-found`, `auth-required`, `ambiguous-forbidden`, `blocked`,
 * `too-large`, `cancelled`, `timeout`, `invalid`.
 */
export type ReadFailureClass =
  | "network"
  | "thin"
  | "binary"
  | "anti-bot"
  | "attempt-timeout"
  | "vendor-auth"
  | "vendor-quota"
  | "vendor-rate-limit"
  | "vendor-refused"
  | "vendor-error"
  | "unavailable"
  | "not-found"
  | "auth-required"
  | "ambiguous-forbidden"
  | "blocked"
  | "too-large"
  | "cancelled"
  | "timeout"
  | "invalid"

const FALLBACK_ELIGIBLE: ReadonlySet<ReadFailureClass> = new Set([
  "network",
  "thin",
  "binary",
  "anti-bot",
  "attempt-timeout",
  "vendor-auth",
  "vendor-quota",
  "vendor-rate-limit",
  "vendor-refused",
  "vendor-error",
  "unavailable",
])

export function isFallbackEligible(failure: ReadFailureClass): boolean {
  return FALLBACK_ELIGIBLE.has(failure)
}

/** Where the reported `status` came from. */
export type StatusSource = "origin" | "reader-service"

/** Readable content one reader produced. */
export interface ReadContent {
  kind: "content"
  reader: WebReaderId
  /** Legacy `source` tag (`wechat`/`x`/`youtube`/`jina`/vendor id), when not plain direct. */
  source?: string
  text: string
  title?: string
  contentType: string
  status: number
  statusSource: StatusSource
  /** How the text was obtained. */
  extraction: "html" | "markdown" | "text" | "json"
}

/** A direct HTTP outcome surfaced verbatim (raw body, non-HTML text, error page). */
export interface ReadHttp {
  kind: "http"
  reader: "direct"
  ok: boolean
  status: number
  contentType: string
  body: string
  /** Set when the outcome is also a failure the router may act on. */
  failure?: ReadFailureClass
}

/** A non-text body that was not converted. */
export interface ReadBinary {
  kind: "binary"
  reader: "direct"
  ok: boolean
  status: number
  contentType: string
  isPdf: boolean
}

export interface ReadFailure {
  kind: "failure"
  reader: WebReaderId
  failure: ReadFailureClass
  /** Bounded, content-free detail for diagnostics. */
  detail: string
  /** HTTP status involved, when known; `statusSource` says whose. */
  status?: number
  statusSource?: StatusSource
}

export type StageOutcome = ReadContent | ReadHttp | ReadBinary | ReadFailure

/** Bound a diagnostic string: one line, no more than 200 characters. */
export function boundedDetail(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value ?? "")
  return text.replace(/\s+/g, " ").trim().slice(0, 200)
}
