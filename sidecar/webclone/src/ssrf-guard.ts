/**
 * SSRF guard for the vendored web-clone engine.
 *
 * A snapshot fetches a page's HTML and then every sub-resource URL it references
 * (CSS `@import`/`url()`, `<script src>`, `<img>`, fonts, …). Those URLs are
 * fully attacker-influenceable — a hostile page can point them at loopback,
 * private-LAN, or cloud-metadata endpoints (`169.254.169.254`). This module
 * classifies each target host and denies those ranges unless the caller
 * explicitly opts in (`allowPrivateHosts`). It also rejects non-http(s) schemes.
 *
 * This is a faithful port of the app-side gate in `lib/web/fetch-guard.ts` —
 * kept in sync deliberately so the sidecar engine enforces the same policy the
 * rest of cognia does. Pure, no I/O.
 *
 * Because the engine runs as a one-shot child process per snapshot job, the
 * module-level {@link setSsrfPolicy} is safe: a single job owns the process.
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
          : `Refusing to fetch a private/loopback address (${host}). Enable "allow private hosts" to override.`
    )
    this.name = "FetchTargetBlockedError"
    this.url = url
    this.host = host
    this.reason = reason
  }
}

/**
 * Parse a host as an IPv4 address, tolerating the common SSRF-bypass encodings:
 * dotted-decimal (`127.0.0.1`) and a bare 32-bit decimal integer
 * (`2130706433` ≡ `127.0.0.1`). Returns the four octets, or `null` when the
 * host is not an IPv4 literal.
 */
function parseIPv4(host: string): [number, number, number, number] | null {
  if (/^\d+$/.test(host)) {
    const n = Number(host)
    if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) return null
    return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
  }
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
  if (/^f[cd][0-9a-f]{0,2}:/.test(h)) return true // fc00::/7 unique-local
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
  // Strip the brackets WHATWG URL parsing keeps around IPv6 literals
  // (`new URL("http://[::1]/").hostname === "[::1]"`) so the IPv6 checks below
  // see the bare address. (The app-side gate this mirrors omits this — the
  // vendored copy is intentionally stricter for the sub-resource fetch path.)
  const h = host
    .trim()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "")
    .toLowerCase()
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

// ── One-shot module policy (a snapshot job owns the whole child process) ──────

let activePolicy: FetchGuardOptions = { allowPrivateHosts: false }

/** Set the SSRF policy for the current process (called once at job start). */
export function setSsrfPolicy(options: FetchGuardOptions): void {
  activePolicy = { allowPrivateHosts: Boolean(options.allowPrivateHosts) }
}

/** Read the SSRF policy currently in effect. */
export function getSsrfPolicy(): FetchGuardOptions {
  return activePolicy
}

/**
 * Guard an outbound URL against the active module policy. This is the single
 * call every transport path in the engine funnels through
 * (`fetchWithTimeout` + redirect following in `fetcher.ts`).
 */
export function guardOutboundUrl(url: string): void {
  assertFetchTargetAllowed(url, activePolicy)
}
