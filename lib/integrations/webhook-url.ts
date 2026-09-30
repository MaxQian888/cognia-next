/**
 * Where a SaaS sender can actually deliver a webhook.
 *
 * The desktop ingress listener binds to 127.0.0.1 only, so the URL the host
 * reports for a route (`http://127.0.0.1:<port>/integration/<route>`) is
 * reachable from this machine and nowhere else. GitHub refuses loopback and
 * private addresses outright, and even where a sender would accept one it could
 * never connect. Delivery needs a public URL that forwards to the listener — a
 * tunnel (cloudflared, ngrok, tailscale funnel) or a reverse proxy — which the
 * user supplies as a base URL.
 *
 * Everything that would push a webhook URL to a remote service goes through
 * {@link isPubliclyDeliverableUrl} first, so a loopback URL is never written
 * over a working remote configuration.
 */

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

function isPrivateIpv4(hostname: string): boolean {
  const match = IPV4_RE.exec(hostname)
  if (!match) return false
  const [a, b] = [Number(match[1]), Number(match[2])]
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  )
}

function isPrivateIpv6(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/g, "").toLowerCase()
  if (!bare.includes(":")) return false
  return (
    bare === "::" ||
    bare === "::1" ||
    bare.startsWith("fc") ||
    bare.startsWith("fd") ||
    bare.startsWith("fe80") ||
    bare.startsWith("::ffff:127.") ||
    bare.startsWith("::ffff:10.") ||
    bare.startsWith("::ffff:192.168.")
  )
}

/** True for a host no public sender can reach: loopback, private, link-local, mDNS. */
export function isNonPublicHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "")
  return (
    host === "" ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    isPrivateIpv4(host) ||
    isPrivateIpv6(host)
  )
}

/**
 * True when `url` is an https URL on a public host. https only: the delivery
 * carries a signature over the payload, and the payload is the repository's
 * private activity.
 */
export function isPubliclyDeliverableUrl(url: string | undefined): boolean {
  if (!url) return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return (
    parsed.protocol === "https:" &&
    !parsed.username &&
    !parsed.password &&
    !isNonPublicHostname(parsed.hostname)
  )
}

/**
 * Normalise what the user typed as the public base URL, or `undefined` when it
 * cannot receive deliveries. A bare hostname is taken as https. Query and
 * fragment are dropped; a path prefix is kept (a reverse proxy may mount the
 * listener under one).
 */
export function normalizePublicBaseUrl(input: string | undefined): string | undefined {
  const raw = input?.trim()
  if (!raw) return undefined
  let parsed: URL
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`)
  } catch {
    return undefined
  }
  const base = `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`
  return isPubliclyDeliverableUrl(base) ? base : undefined
}

/**
 * The public URL for a route: the local listener URL's path on the public
 * base. `undefined` when either half is missing or the result is not
 * deliverable.
 */
export function toPublicWebhookUrl(
  localUrl: string | undefined,
  publicBaseUrl: string | undefined
): string | undefined {
  const base = normalizePublicBaseUrl(publicBaseUrl)
  if (!base || !localUrl) return undefined
  let path: string
  try {
    path = new URL(localUrl).pathname
  } catch {
    return undefined
  }
  const url = `${base}${path}`
  return isPubliclyDeliverableUrl(url) ? url : undefined
}
