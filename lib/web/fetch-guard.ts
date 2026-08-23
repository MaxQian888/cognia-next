/**
 * SSRF guard for the agent-facing `web_fetch` tool (and the twin URL ingest).
 *
 * `web_fetch` takes a model-supplied URL and issues an HTTP request from the
 * user's machine — on desktop via the CORS-free Rust proxy, so an attacker who
 * can influence the model's tool call could otherwise reach loopback, private
 * LAN, or cloud metadata endpoints (`169.254.169.254`).
 *
 * This module is the APP ADAPTER over `@cognia/network-guard`, which owns the
 * classification itself and is shared with the connector inbound-media floor
 * and the web-clone sidecar engine. What stays here is the part that is only
 * true of the app: the error type, and the "enable it in Settings → Search"
 * guidance, which names a surface neither of the other two runtimes has.
 *
 * Pure, no I/O — mirrors the spirit of `lib/plugin/security/network-allowlist`
 * (egress clamp) but for the fixed private/loopback ranges rather than a
 * per-plugin allowlist.
 */

import { evaluateFetchTarget, type FetchGuardReason } from "@cognia/network-guard"

export {
  evaluateFetchTarget,
  isPrivateOrLocalHost,
  type FetchGuardDecision,
  type FetchGuardOptions,
  type FetchGuardReason,
} from "@cognia/network-guard"

import type { FetchGuardOptions } from "@cognia/network-guard"

/** Thrown by {@link assertFetchTargetAllowed} when a target is not permitted. */
export class FetchTargetBlockedError extends Error {
  readonly url: string
  readonly host: string
  readonly reason: FetchGuardReason

  constructor(url: string, host: string, reason: FetchGuardReason) {
    super(
      reason === "bad-scheme"
        ? `Refusing to fetch non-http(s) URL: ${url}`
        : reason === "bad-url"
          ? `Refusing to fetch an unparseable URL: ${url}`
          : `Refusing to fetch a private/loopback address (${host}). Enable "allow private hosts" in Settings → Search to override.`
    )
    this.name = "FetchTargetBlockedError"
    this.url = url
    this.host = host
    this.reason = reason
  }
}

/**
 * Enforce {@link evaluateFetchTarget}; throws {@link FetchTargetBlockedError}
 * when the target is not permitted. Call before any outbound request.
 */
export function assertFetchTargetAllowed(url: string, options: FetchGuardOptions = {}): void {
  const decision = evaluateFetchTarget(url, options)
  if (!decision.allowed) {
    throw new FetchTargetBlockedError(url, decision.host ?? "", decision.reason)
  }
}
