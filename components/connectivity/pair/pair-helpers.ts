"use client"

import { isLoopbackHostname } from "@/lib/connectivity/origin-reachability"

/**
 * Pure helpers shared by the mobile pair coordinator and its child step
 * components. Extracted from `pair-onboarding-client.tsx` so the step
 * components can reuse them without forming an import cycle.
 *
 * Legacy URL + JWT pairing helpers were removed with the cgnp3 device-key
 * migration.
 */

export type WebPairingTransportError = "https_required"

/**
 * Reject a browser pairing whose credential would cross the network in
 * cleartext.
 *
 * Loopback is exempt, and has to be: `http://127.0.0.1:27891` is the Host's
 * *intended* door for a browser (see `browser_access.rs` — a tab cannot pin the
 * self-signed cert the HTTPS listener presents, and loopback is "potentially
 * trustworthy" per the Secure Contexts spec, so nothing leaves the machine).
 * Holding it to `https:` would ban the only transport that works. This mirrors
 * the Host's own `web_origin::is_secure_or_loopback`, so client and server agree
 * on what counts as safe plaintext.
 *
 * Fails CLOSED on a URL that will not parse. `null` here means "this transport
 * is acceptable", and a base URL the platform cannot even parse is not — every
 * request built from it is going nowhere, and answering "acceptable" spends the
 * user's one-shot invitation before reporting a generic `unknown` failure
 * instead of naming the transport as the problem.
 */
export function validateWebPairingTransport(
  baseUrl: string,
  webMode: boolean
): WebPairingTransportError | null {
  if (!webMode) return null
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    return "https_required"
  }
  if (url.protocol === "https:") return null
  return isLoopbackHostname(url.hostname) ? null : "https_required"
}

export type PairNetworkErrorKind =
  "certificate" | "browser_policy" | "browser_blocked" | "offline" | "unreachable" | "unknown"

export function classifyPairNetworkError(
  err: unknown,
  online = typeof navigator === "undefined" ? true : navigator.onLine
): PairNetworkErrorKind {
  if (!online) return "offline"
  const raw = err instanceof Error ? err.message : String(err)
  if (/ERR_CERT|certificate|certificate verify|SSL|TLS handshake/i.test(raw)) {
    return "certificate"
  }
  if (/CORS|cross-origin|private network access|Access-Control-Allow|mixed content/i.test(raw)) {
    return "browser_policy"
  }
  if (/Failed to fetch|NetworkError when attempting to fetch resource/i.test(raw)) {
    return "browser_blocked"
  }
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|timeout/i.test(raw)) {
    return "unreachable"
  }
  return "unknown"
}

export function getDeviceLabel(): string {
  if (typeof navigator === "undefined") return "unknown-device"
  return navigator.userAgent || "unknown-device"
}

export function getDevicePlatform(): string {
  if (typeof window === "undefined") return "unknown"
  const cap = (window as { Capacitor?: { getPlatform?: () => string } }).Capacitor
  if (cap?.getPlatform) {
    return cap.getPlatform()
  }
  return "web"
}

export async function safeText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ""
  }
}
