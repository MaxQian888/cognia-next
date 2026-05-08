"use client"

/**
 * Pair-QR encoding (M4.5 / #49).
 *
 * The desktop's Settings → Companion screen renders a QR encoding the
 * pair handoff payload. The phone scans and prefills its onboarding
 * form. Format is deliberately simple — JSON with two fields — so a
 * future cognia-server v2 can emit the same QR without changing the
 * phone code.
 */

export interface PairQrPayload {
  /** "http://192.168.1.42:7890" — desktop LAN companion server URL. */
  baseUrl: string
  /** 5-minute pair JWT issued from desktop Settings → Companion. */
  pairJwt: string
  /** Schema version for forward compat. Always 1 for now. */
  v?: number
}

/**
 * Returns a parsed payload, or null if the value isn't a valid pair-QR.
 * Callers should treat null as "show the form, let the user paste".
 */
export function parsePairQrPayload(raw: string): PairQrPayload | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null) return null
  const obj = parsed as { baseUrl?: unknown; pairJwt?: unknown; v?: unknown }
  if (typeof obj.baseUrl !== "string" || typeof obj.pairJwt !== "string") return null
  if (obj.baseUrl.length === 0 || obj.pairJwt.length === 0) return null
  if (obj.v !== undefined && typeof obj.v !== "number") return null
  return {
    baseUrl: obj.baseUrl,
    pairJwt: obj.pairJwt,
    v: typeof obj.v === "number" ? obj.v : 1,
  }
}

export function encodePairQrPayload(payload: PairQrPayload): string {
  return JSON.stringify({
    baseUrl: payload.baseUrl,
    pairJwt: payload.pairJwt,
    v: payload.v ?? 1,
  })
}
