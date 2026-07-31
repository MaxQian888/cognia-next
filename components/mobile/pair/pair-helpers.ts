"use client"

/**
 * Pure helpers shared by the mobile pair coordinator and its child step
 * components. Extracted from `pair-onboarding-client.tsx` so the step
 * components can reuse them without forming an import cycle.
 *
 * The validate / describe helpers are also re-exported from
 * `pair-onboarding-client.tsx` to keep their public path stable for
 * existing test files.
 */

/**
 * Returns an error string if the URL is not a usable LAN companion server
 * URL, otherwise null. Accepts http or https with an explicit host;
 * rejects empty / non-http / IP-without-host strings.
 */
export function validateBaseUrl(input: string): string | null {
  if (!input) return "Server base URL is required."
  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    return "Enter a URL like http://192.168.1.42:7890."
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "URL must start with http:// or https://."
  }
  if (!parsed.host) return "URL is missing a host."
  return null
}

export type WebPairingTransportError = "https_required"

export function validateWebPairingTransport(
  baseUrl: string,
  webMode: boolean
): WebPairingTransportError | null {
  if (!webMode) return null
  return new URL(baseUrl).protocol === "https:" ? null : "https_required"
}

/**
 * Returns an error string if the JWT is not shaped like a JWT
 * (`header.payload.signature`, base64url of each part), otherwise null.
 * We don't verify the signature client-side — that's the server's job.
 */
export function validatePairJwt(input: string): string | null {
  if (!input) return "Pair JWT is required."
  const parts = input.split(".")
  if (parts.length !== 3) return "Pair JWT must have three dot-separated parts."
  if (parts.some((p) => p.length === 0)) return "Pair JWT segments must be non-empty."
  if (!parts.every(isBase64Url)) return "Pair JWT must be base64url encoded."
  return null
}

function isBase64Url(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value)
}

export function describeHttpError(status: number, body: string): string {
  if (status === 401) {
    return "Pairing code rejected — it may have expired (5-minute lifetime) or already been used. Generate a fresh one in desktop Settings → Companion."
  }
  if (status === 403) {
    return "Server refused the pairing request — check the desktop Companion settings for an allow-list."
  }
  if (status === 404) {
    return "Server doesn't expose /api/v1/auth/pair — confirm the desktop is running cognia v0.2+ with companion enabled."
  }
  if (status >= 500) {
    return `Server error (HTTP ${status}). Check the desktop's logs and try again.`
  }
  return body ? `pair failed (HTTP ${status}): ${body}` : `pair failed (HTTP ${status}).`
}

export function describeNetworkError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  if (/Failed to fetch|NetworkError|ENOTFOUND|ECONNREFUSED/i.test(raw)) {
    return "Could not reach the desktop server. Check the URL, that the desktop has the Companion server enabled, and that both devices are on the same network."
  }
  return raw
}

export type PairNetworkErrorKind =
  | "certificate"
  | "browser_policy"
  | "browser_blocked"
  | "offline"
  | "unreachable"
  | "unknown"

export function classifyPairNetworkError(
  err: unknown,
  online = typeof navigator === "undefined" ? true : navigator.onLine
): PairNetworkErrorKind {
  if (!online) return "offline"
  const raw = err instanceof Error ? err.message : String(err)
  if (/ERR_CERT|certificate|certificate verify|SSL|TLS handshake/i.test(raw)) {
    return "certificate"
  }
  if (
    /CORS|cross-origin|private network access|Access-Control-Allow|mixed content/i.test(
      raw
    )
  ) {
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
