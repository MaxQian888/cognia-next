/**
 * The shared SSRF decision for an outbound URL.
 *
 * Three call sites in this repo take a URL they do not control and issue a
 * request from the user's machine:
 *
 *   - `web_fetch` (and the twin URL ingest) — the URL comes from the model.
 *   - the connector inbound-media pass — the URL comes from a chat message.
 *   - the web-clone engine — every sub-resource a hostile page references.
 *
 * All three used to carry their own copy of the policy, and the copies had
 * drifted into disagreement: the app gate cleared every IPv6 private address
 * (it compared `hostname` without stripping the brackets WHATWG keeps), the
 * webclone gate additionally missed `fec0::/10` and IPv4-mapped literals, and
 * the connector floor missed CGNAT, multicast, and the bare-integer IPv4 form.
 * This module is the union of the three, so the three cannot disagree again.
 *
 * Pure, no I/O. What it deliberately does NOT do: resolve DNS. A public name
 * that resolves to a private address (rebinding) needs a check at resolution
 * time, which belongs in the transport — see the Rust proxy backstop.
 */

import { isPrivateOrLocalHost, normalizeHost } from "./host"

/** Why a target was refused, or `"ok"` when it was cleared. */
export type FetchGuardReason = "ok" | "bad-url" | "bad-scheme" | "private-host"

export interface FetchGuardDecision {
  allowed: boolean
  reason: FetchGuardReason
  /** The parsed hostname (lower-cased, brackets stripped) when the URL parsed. */
  host?: string
}

export interface FetchGuardOptions {
  /**
   * When true, private/loopback/link-local targets are permitted (default
   * false). This is the ONLY rejection it lifts — a malformed URL or a
   * non-http(s) scheme stays blocked either way.
   */
  allowPrivateHosts?: boolean
}

/**
 * Classify a fetch target. Never throws. Rejects unparseable URLs, non-http(s)
 * schemes (`file:`, `gopher:`, `data:` — the classic SSRF pivots), and, unless
 * `allowPrivateHosts` is set, private/loopback/link-local hosts.
 */
export function evaluateFetchTarget(
  url: string,
  options: FetchGuardOptions = {}
): FetchGuardDecision {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { allowed: false, reason: "bad-url" }
  }
  const scheme = parsed.protocol.toLowerCase()
  // `hostname` keeps IPv6 brackets; normalise before it reaches a caller or a
  // classifier, so `host` means the same thing on every branch below.
  const host = normalizeHost(parsed.hostname)
  if (scheme !== "http:" && scheme !== "https:") {
    return { allowed: false, reason: "bad-scheme", host }
  }
  if (!options.allowPrivateHosts && isPrivateOrLocalHost(host)) {
    return { allowed: false, reason: "private-host", host }
  }
  return { allowed: true, reason: "ok", host }
}
