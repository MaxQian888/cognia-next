/**
 * Pure host classifier shared by the companion transport tier logic
 * (`lib/tauri/transport-companion.ts`) and the runtime LAN re-resolver
 * (`lib/connectivity/lan-resolver.ts`). ADR-0021.
 *
 * Extracted into `lib/connectivity` so the re-resolver can reuse it
 * without pulling the whole `lib/tauri/transport-companion` →
 * `TransportRtc` → signaling graph into every connectivity consumer.
 * `transport-companion.ts` re-exports `classifyWsHost` for backward
 * compatibility, so existing imports and tests keep working.
 */

// IPv4 ranges considered LAN/loopback per RFC1918 + RFC3927 + RFC5735.
const LAN_IPV4_RE = /^(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\.)/
// IPv6 loopback / link-local / unique-local prefixes.
const LAN_IPV6_RE = /^(?:::1$|fe80:|fc[0-9a-f]{2}:|fd[0-9a-f]{2}:)/i

/**
 * Decide whether a companion `baseUrl` points at the same LAN as the
 * mobile device (so the desktop is reachable directly) or at a public
 * tunnel hostname (so traffic flows through cloudflared / a forwarded
 * port).
 *
 * Unparseable URLs fall through to `"ws-tunnel"`: it is the safer
 * assumption (we'd rather under-claim "LAN" than over-claim it for a UI
 * that hints at trustworthiness).
 */
export function classifyWsHost(baseUrl: string): "ws-lan" | "ws-tunnel" {
  let hostname: string
  try {
    hostname = new URL(baseUrl).hostname
  } catch {
    return "ws-tunnel"
  }
  // `URL.hostname` returns "[::1]" for IPv6 literals — drop the brackets.
  const naked = hostname.replace(/^\[|\]$/g, "").toLowerCase()
  if (!naked) return "ws-tunnel"
  if (naked === "localhost") return "ws-lan"
  if (naked.endsWith(".local")) return "ws-lan"
  if (LAN_IPV4_RE.test(naked)) return "ws-lan"
  if (LAN_IPV6_RE.test(naked)) return "ws-lan"
  return "ws-tunnel"
}
