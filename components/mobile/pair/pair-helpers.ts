"use client"

/**
 * Pure helpers shared by the mobile pair coordinator and its child step
 * components. Extracted from `pair-onboarding-client.tsx` so the step
 * components can reuse them without forming an import cycle.
 *
 * Legacy URL + JWT pairing helpers were removed with the cgnp3 device-key
 * migration.
 */

export type WebPairingTransportError = "https_required"

export function validateWebPairingTransport(
  baseUrl: string,
  webMode: boolean
): WebPairingTransportError | null {
  if (!webMode) return null
  return new URL(baseUrl).protocol === "https:" ? null : "https_required"
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
