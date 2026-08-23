/**
 * Pure helpers around `NetworkProxySettings`. Used by both the renderer
 * (`createProxyFetch`, settings UI) and any Node-side code that needs to
 * shape the same config into env vars.
 *
 * Stays in `lib/network/` next to `proxy-fetch.ts` so the entire proxy
 * surface is co-located. Tests live next to this file.
 */

import type { NetworkProxySettings } from "@/types/network/proxy"

/**
 * Why a proxy host was refused. Distinct cases because the settings UI can
 * only say something useful ("drop the `http://`", "the port goes in its own
 * field") if it knows which mistake was made.
 */
export type ProxyHostRejection =
  "empty" | "scheme" | "userinfo" | "path" | "port-in-host" | "illegal-character" | "malformed"

export type ProxyHostValidation =
  { ok: true; host: string } | { ok: false; reason: ProxyHostRejection }

/** Characters a host may contain. Everything else is refused up front. */
const HOST_CHARSET = /^[A-Za-z0-9._\-:[\]]+$/

/**
 * Validate a proxy host as the user typed it.
 *
 * A host field that accepts anything is not a convenience — `http://proxy`
 * becomes `http://http://proxy:8080`, `user:pw@proxy` puts credentials in a
 * URL the renderer is never allowed to build, and `proxy:8080` silently
 * produces a double port. Each of those used to be accepted and fail later
 * as an opaque connection error.
 *
 * Refusing control and non-DNS bytes also closes the parser/resolver
 * differential class: the string validated here is the string that gets
 * dialled, so an embedded NUL or CR cannot make the two disagree.
 *
 * Returns the trimmed host on success. IPv6 is accepted bare or bracketed and
 * normalized to bare — [`formatProxyAuthority`] adds the brackets back where
 * a URL needs them.
 */
export function validateProxyHost(raw: string): ProxyHostValidation {
  const host = raw.trim()
  if (host.length === 0) return { ok: false, reason: "empty" }
  if (host.includes("://")) return { ok: false, reason: "scheme" }
  if (host.includes("@")) return { ok: false, reason: "userinfo" }
  if (host.includes("/") || host.includes("?") || host.includes("#")) {
    return { ok: false, reason: "path" }
  }
  if (!HOST_CHARSET.test(host)) return { ok: false, reason: "illegal-character" }

  const bare = stripBrackets(host)
  if (host.startsWith("[")) {
    // A bracketed host is an IPv6 literal by definition; anything else in
    // brackets is malformed rather than a hostname that happens to have them.
    if (!host.endsWith("]") || !isIpv6(bare)) return { ok: false, reason: "malformed" }
    return { ok: true, host: bare }
  }
  if (host.includes(":")) {
    // Either a bare IPv6 literal or — far more likely — someone pasted
    // `proxy.corp:8080` into a field that already has a port of its own.
    return isIpv6(host) ? { ok: true, host } : { ok: false, reason: "port-in-host" }
  }
  if (host.startsWith(".") || host.endsWith(".") || host.includes("..")) {
    return { ok: false, reason: "malformed" }
  }
  return { ok: true, host }
}

/** True for a usable TCP port. `0` is "unset", not "pick one for me". */
export function validateProxyPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

/**
 * `host:port` for a URL, TCP dial, or CONNECT line.
 *
 * IPv6 literals must be bracketed or the last group is read as the port:
 * `::1:8080` is not a parse of `::1` port 8080, it is a different (invalid)
 * address. Mirrors `proxy_config::authority` on the Rust side.
 */
export function formatProxyAuthority(host: string, port: number): string {
  const bare = stripBrackets(host.trim())
  return isIpv6(bare) ? `[${bare}]:${port}` : `${bare}:${port}`
}

/**
 * Strip the brackets `URL.hostname` keeps on an IPv6 literal.
 *
 * `new URL("http://[::1]/").hostname` is `"[::1]"`, so comparing it against a
 * bypass entry of `::1` never matched — and `::1` is in the DEFAULT bypass
 * list, which meant loopback IPv6 was silently proxied.
 */
export function normalizeProxyHostForMatch(hostname: string): string {
  return stripBrackets(hostname.trim().toLowerCase())
}

function stripBrackets(value: string): string {
  return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value
}

function isIpv6(value: string): boolean {
  const parsed = parseIpv6(value)
  return parsed !== null
}

/** True when the user has enabled a proxy AND filled in a valid host + port. */
export function isProxyActive(cfg?: NetworkProxySettings | null): cfg is NetworkProxySettings {
  if (!cfg) return false
  if (cfg.mode === "off") return false
  return validateProxyHost(cfg.host).ok && validateProxyPort(cfg.port)
}

/**
 * Build a public proxy endpoint URL without credentials.
 *
 * Returns `null` when the config isn't actionable (off, missing host, or
 * port = 0). Credentials live in the native keyring and must never be
 * reconstructed in the renderer.
 */
export function buildProxyUrl(cfg?: NetworkProxySettings | null): string | null {
  if (!isProxyActive(cfg)) return null
  const scheme = cfg.protocol === "socks5" ? "socks5" : cfg.protocol
  return `${scheme}://${formatProxyAuthority(cfg.host, cfg.port)}`
}

type ParsedIp = { bits: 32 | 128; bytes: number[] }

function parseIpv4(input: string): ParsedIp | null {
  const parts = input.split(".")
  if (parts.length !== 4) return null
  const bytes: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    bytes.push(octet)
  }
  return { bits: 32, bytes }
}

function ipv6Words(part: string): number[] | null {
  if (!part) return []
  const words: number[] = []
  for (const token of part.split(":")) {
    if (!token) return null
    if (token.includes(".")) {
      const ipv4 = parseIpv4(token)
      if (!ipv4) return null
      words.push(ipv4.bytes[0] * 256 + ipv4.bytes[1], ipv4.bytes[2] * 256 + ipv4.bytes[3])
      continue
    }
    if (!/^[0-9a-f]{1,4}$/i.test(token)) return null
    words.push(Number.parseInt(token, 16))
  }
  return words
}

function parseIpv6(input: string): ParsedIp | null {
  const normalized = input.replace(/^\[|\]$/g, "")
  const halves = normalized.split("::")
  if (halves.length > 2) return null
  const left = ipv6Words(halves[0] ?? "")
  const right = ipv6Words(halves[1] ?? "")
  if (!left || !right) return null
  const omitted = 8 - left.length - right.length
  if (halves.length === 1 ? omitted !== 0 : omitted < 1) return null
  const words = [...left, ...Array.from({ length: omitted }, () => 0), ...right]
  if (words.length !== 8) return null
  return {
    bits: 128,
    bytes: words.flatMap((word) => [word >> 8, word & 0xff]),
  }
}

function parseIp(input: string): ParsedIp | null {
  return parseIpv4(input) ?? parseIpv6(input)
}

function cidrMatches(host: string, entry: string): boolean {
  const separator = entry.lastIndexOf("/")
  if (separator <= 0) return false
  const network = parseIp(entry.slice(0, separator))
  const target = parseIp(host)
  const prefix = Number(entry.slice(separator + 1))
  if (!network || !target || network.bits !== target.bits || !Number.isInteger(prefix)) return false
  if (prefix < 0 || prefix > network.bits) return false
  const wholeBytes = Math.floor(prefix / 8)
  for (let index = 0; index < wholeBytes; index += 1) {
    if (network.bytes[index] !== target.bytes[index]) return false
  }
  const remainingBits = prefix % 8
  if (remainingBits === 0) return true
  const mask = (0xff << (8 - remainingBits)) & 0xff
  return (network.bytes[wholeBytes] & mask) === (target.bytes[wholeBytes] & mask)
}

/**
 * Determine whether a target URL should bypass the proxy. Matches each
 * `bypass` entry as either a literal host (with optional port suffix) or a
 * domain suffix when the entry starts with a dot.
 *
 *   "127.0.0.1"     → matches http://127.0.0.1, http://127.0.0.1:3000
 *   ".internal"     → matches https://api.internal/foo
 *   "localhost"     → matches http://localhost/whatever
 *
 * Anything we cannot parse falls back to "do not bypass" — direct calls are
 * cheaper to debug than silently-leaked-direct ones.
 */
export function shouldBypass(targetUrl: string, bypass: string[]): boolean {
  if (bypass.length === 0) return false
  let host: string
  try {
    // Bracket-stripped once, for every branch. `URL.hostname` keeps the
    // brackets on an IPv6 literal, so the literal comparison below used to
    // test `"[::1]" === "::1"` and never match — with `::1` in the default
    // bypass list.
    host = normalizeProxyHostForMatch(new URL(targetUrl).hostname)
  } catch {
    return false
  }
  return bypass.some((raw) => {
    const entry = normalizeProxyHostForMatch(raw)
    if (!entry) return false
    if (entry.includes("/")) return cidrMatches(host, entry)
    if (entry.startsWith(".")) return host === entry.slice(1) || host.endsWith(entry)
    return host === entry
  })
}

/** Redact proxy URL userinfo before it reaches logs, IPC, or diagnostic UI. */
export function redactProxyUrl(value: string): string {
  try {
    const parsed = new URL(value)
    parsed.username = ""
    parsed.password = ""
    return parsed.toString()
  } catch {
    return "<invalid-proxy-url>"
  }
}

/**
 * Env-var map suitable for spawning a child process (Node sidecar, MCP
 * server) so its outbound HTTP picks up the same proxy. Reads every common
 * casing because libraries are inconsistent.
 *
 * Returns `{}` when no proxy is active so the caller can spread it without
 * conditionals.
 */
export function proxyEnvVars(cfg?: NetworkProxySettings | null): Record<string, string> {
  const url = buildProxyUrl(cfg)
  if (!url) return {}
  const env: Record<string, string> = {
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    http_proxy: url,
    https_proxy: url,
  }
  if (cfg && cfg.bypass.length > 0) {
    const noProxy = cfg.bypass.join(",")
    env.NO_PROXY = noProxy
    env.no_proxy = noProxy
  }
  return env
}
