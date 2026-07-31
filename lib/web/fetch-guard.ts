/**
 * SSRF guard for the agent-facing `web_fetch` tool (and the twin URL ingest).
 *
 * `web_fetch` takes a model-supplied URL and issues an HTTP request from the
 * user's machine — on desktop via the CORS-free Rust proxy, so an attacker who
 * can influence the model's tool call could otherwise reach loopback, private
 * LAN, or cloud metadata endpoints (`169.254.169.254`). This module classifies
 * the target host and denies those ranges unless the user explicitly opted in
 * (`allowPrivateHosts`). It also rejects non-http(s) schemes (`file:`,
 * `gopher:`, `data:`, …) which are classic SSRF pivots.
 *
 * Pure, no I/O — mirrors the spirit of `lib/plugin/security/network-allowlist`
 * (egress clamp) but for the fixed private/loopback ranges rather than a
 * per-plugin allowlist.
 */

export type FetchGuardReason = "ok" | "bad-url" | "bad-scheme" | "private-host"

export interface FetchGuardDecision {
  allowed: boolean
  reason: FetchGuardReason
  /** The parsed hostname (lower-cased, brackets stripped) when the URL parsed. */
  host?: string
}

export interface FetchGuardOptions {
  /** When true, private/loopback/link-local targets are permitted (default false). */
  allowPrivateHosts?: boolean
}

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
 * Parse a host as an IPv4 address, tolerating the common SSRF-bypass encodings:
 * dotted-decimal (`127.0.0.1`), and a bare 32-bit decimal integer
 * (`2130706433` ≡ `127.0.0.1`). Returns the four octets, or `null` when the
 * host is not an IPv4 literal.
 */
function parseIPv4(host: string): [number, number, number, number] | null {
  // Bare 32-bit decimal integer form (e.g. http://2130706433/).
  if (/^\d+$/.test(host)) {
    const n = Number(host)
    if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) return null
    return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
  }
  // Dotted-decimal form.
  const parts = host.split(".")
  if (parts.length !== 4) return null
  const octets: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const v = Number(part)
    if (v > 255) return null
    octets.push(v)
  }
  return octets as [number, number, number, number]
}

/** Is this IPv4 (as octets) in a loopback / private / link-local / reserved range? */
function isPrivateIPv4([a, b]: [number, number, number, number]): boolean {
  if (a === 0) return true // 0.0.0.0/8 "this host"
  if (a === 10) return true // 10.0.0.0/8 private
  if (a === 127) return true // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true // 169.254.0.0/16 link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10 CGNAT
  if (a >= 224) return true // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  return false
}

/** Is this IPv6 host (brackets already stripped) loopback / ULA / link-local / unspecified? */
function isPrivateIPv6(host: string): boolean {
  const h = host.toLowerCase()
  if (h === "::1" || h === "::") return true // loopback / unspecified
  if (h.startsWith("fe80:") || h.startsWith("fe80::")) return true // link-local
  // fc00::/7 unique-local — first byte 0xfc or 0xfd.
  if (/^f[cd][0-9a-f]{0,2}:/.test(h)) return true
  // IPv4-mapped / -embedded (::ffff:127.0.0.1, ::127.0.0.1) — check the tail.
  const mapped = h.match(/:((?:\d{1,3}\.){3}\d{1,3})$/)
  if (mapped) {
    const v4 = parseIPv4(mapped[1])
    if (v4 && isPrivateIPv4(v4)) return true
  }
  return false
}

/**
 * True when `host` names a loopback, private-LAN, link-local, or otherwise
 * non-public target that a fetch tool should not reach by default.
 */
export function isPrivateOrLocalHost(host: string): boolean {
  const h = host.trim().replace(/\.+$/, "").toLowerCase()
  if (!h) return true // empty host → treat as unsafe
  if (h === "localhost" || h.endsWith(".localhost")) return true
  if (h.includes(":")) return isPrivateIPv6(h)
  const v4 = parseIPv4(h)
  if (v4) return isPrivateIPv4(v4)
  return false
}

/**
 * Classify a fetch target. Never throws. Rejects unparseable URLs, non-http(s)
 * schemes, and (unless `allowPrivateHosts`) private/loopback/link-local hosts.
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
  if (scheme !== "http:" && scheme !== "https:") {
    return { allowed: false, reason: "bad-scheme", host: parsed.hostname.toLowerCase() }
  }
  const host = parsed.hostname.toLowerCase()
  if (!options.allowPrivateHosts && isPrivateOrLocalHost(host)) {
    return { allowed: false, reason: "private-host", host }
  }
  return { allowed: true, reason: "ok", host }
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
