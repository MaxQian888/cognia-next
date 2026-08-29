/**
 * "Is this hostname this machine?" — the predicate every plaintext-transport
 * decision in the app turns on.
 *
 * It lives in its own leaf module because its callers have nothing else in
 * common. `origin-reachability.ts` is a `"use client"` module that reaches for
 * Capacitor HTTP; `lib/runtime/target-registry.ts` is a Dexie schema that runs
 * in the node test project. Sharing the rule must not drag one's dependencies
 * into the other, and a second hand-written copy is how two guards on the same
 * transport start disagreeing — which is exactly the defect this extraction was
 * made to fix.
 *
 * The rule mirrors the Host's own `web_origin::is_secure_or_loopback` loopback
 * arm: `localhost`, `::1`, and the whole `127.0.0.0/8` block.
 */

/**
 * Whether `host` is a dotted-quad IPv4 literal inside `127.0.0.0/8`.
 *
 * Parsed, not prefix-matched. A `/^127\./` test is a check on *text*, and
 * `127.evil.example` and `127.0.0.1.nip.io` are both text that starts with
 * `127.` while resolving wherever their owner points them — which, on the two
 * guards that now gate plaintext transport on this predicate, would ship a
 * device credential and a signaling room descriptor in the clear to somebody
 * else's machine. Every label must be a decimal octet, and there must be
 * exactly four of them.
 *
 * `URL.hostname` has already normalised the shorthand forms (`127.1` arrives
 * as `127.0.0.1`), so requiring the full quad costs nothing at the call sites.
 */
function isLoopbackIpv4(host: string): boolean {
  const parts = host.split(".")
  if (parts.length !== 4) return false
  if (!parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return false
  return Number(parts[0]) === 127
}

/**
 * True for `localhost`, `::1` (bracketed or not), and any `127.0.0.0/8`
 * address.
 *
 * Brackets are stripped first because `URL.hostname` keeps them for IPv6
 * literals (`[::1]`), so a bare string comparison would miss every IPv6
 * loopback URL.
 */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "")
  return host === "localhost" || host === "::1" || isLoopbackIpv4(host)
}
