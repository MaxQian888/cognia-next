/**
 * Browser-side Lark web session handling (plan 2026-07-24 P3.1).
 *
 * The SSO callback delivers the 8-hour session JWT in the URL FRAGMENT
 * (`#lark_session=…`) so it never reaches server logs or Referer headers.
 * This module captures it into sessionStorage (tab-scoped, dies with the
 * tab), strips the fragment, and exposes typed readers. The browser never
 * holds anything else — no app secret, no bot token, no device JWT.
 */

import { decodeJwtPayload } from "@/lib/security/jwt-payload"

export const LARK_WEB_SESSION_STORAGE_KEY = "cognia-lark-web-session-v1"

const FRAGMENT_PARAM = "lark_session"

/**
 * Unverified base64url payload decode — claim EXTRACTION only, never trust.
 * Re-exported so this module keeps its name at every call site while there is
 * exactly one implementation, in `lib/security/jwt-payload.ts`.
 */
export { decodeJwtPayload }

/**
 * Capture a session token from `location.hash`, persist it, and strip the
 * fragment from the address bar. Returns the captured token, if any.
 */
export function captureLarkSessionFromLocation(): string | null {
  if (typeof window === "undefined") return null
  const hash = window.location.hash.replace(/^#/, "")
  if (!hash) return null
  const params = new URLSearchParams(hash)
  const token = params.get(FRAGMENT_PARAM)
  if (!token) return null
  try {
    window.sessionStorage.setItem(LARK_WEB_SESSION_STORAGE_KEY, token)
  } catch {
    // Storage unavailable (private-mode quota) — the in-URL token still
    // works for this navigation via the returned value.
  }
  params.delete(FRAGMENT_PARAM)
  const remainder = params.toString()
  const url = window.location.pathname + window.location.search + (remainder ? `#${remainder}` : "")
  window.history.replaceState(null, "", url)
  return token
}

/** Stored session token, dropped when its `exp` claim has passed. */
export function getLarkWebSession(now = Date.now()): string | null {
  if (typeof window === "undefined") return null
  let token: string | null = null
  try {
    token = window.sessionStorage.getItem(LARK_WEB_SESSION_STORAGE_KEY)
  } catch {
    return null
  }
  if (!token) return null
  const payload = decodeJwtPayload(token)
  const exp = typeof payload?.exp === "number" ? payload.exp : 0
  if (exp * 1000 <= now) {
    clearLarkWebSession()
    return null
  }
  return token
}

export function clearLarkWebSession(): void {
  try {
    window.sessionStorage.removeItem(LARK_WEB_SESSION_STORAGE_KEY)
  } catch {
    // ignore
  }
}

/** Login URL on the companion origin, bouncing back to `returnTo`. */
export function buildLarkLoginUrl(apiBase: string, adapterId: string, returnTo: string): string {
  const params = new URLSearchParams({ adapter_id: adapterId, return_to: returnTo })
  return `${apiBase}/integrations/lark/web/login?${params.toString()}`
}
