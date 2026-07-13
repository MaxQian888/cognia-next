/**
 * QQ Official Bot authentication.
 *
 * QQ's open platform uses an app-level access token (not a static bot token):
 *   POST https://bots.qq.com/app/getAppAccessToken { appId, clientSecret }
 *     → { access_token, expires_in }
 *
 * The token is short-lived (~2h) and shared by the gateway IDENTIFY and every
 * REST call (`Authorization: QQBot <access_token>`). We cache it per
 * (appId, clientSecret) and refresh a minute before expiry.
 */

import { connectorsHttpRequest } from "@/lib/connectors/tauri/commands"

const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken"
export const QQ_API_BASE = "https://api.sgroup.qq.com"

interface CacheEntry {
  token: string
  expiresAt: number
}

const cache = new Map<string, CacheEntry>()

export async function getQQAccessToken(appId: string, clientSecret: string): Promise<string> {
  const key = `${appId}:${clientSecret}`
  const now = Date.now()
  const cached = cache.get(key)
  if (cached && cached.expiresAt > now + 60_000) return cached.token

  const resp = await connectorsHttpRequest({
    url: TOKEN_URL,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appId, clientSecret }),
  })
  let parsed: { access_token?: string; expires_in?: string | number; message?: string }
  try {
    parsed = JSON.parse(resp.body)
  } catch {
    throw new Error(`QQ getAppAccessToken returned non-JSON (status ${resp.status})`)
  }
  if (!parsed.access_token) {
    throw new Error(`QQ getAppAccessToken failed: ${parsed.message ?? resp.body.slice(0, 200)}`)
  }
  const expiresInSec =
    typeof parsed.expires_in === "string"
      ? parseInt(parsed.expires_in, 10)
      : (parsed.expires_in ?? 7200)
  const entry: CacheEntry = { token: parsed.access_token, expiresAt: now + expiresInSec * 1000 }
  cache.set(key, entry)
  return entry.token
}

export function clearQQTokenCache(appId: string, clientSecret: string): void {
  cache.delete(`${appId}:${clientSecret}`)
}

/**
 * Invalidate whichever cache entry minted `token`.
 *
 * The adapter's send path only holds the resolved token (the appId/secret
 * pair lives behind the injected `accessToken` resolver), so when the
 * platform answers 401/403 — e.g. after a console-side secret rotation —
 * this is the targeted way to evict the stale entry and force a re-mint on
 * the next resolve.
 */
export function clearQQTokenCacheByToken(token: string): void {
  for (const [key, entry] of cache) {
    if (entry.token === token) cache.delete(key)
  }
}

/** `Authorization: QQBot <token>` is the auth scheme for every QQ REST/gateway call. */
export function qqAuthHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `QQBot ${accessToken}`, "Content-Type": "application/json" }
}

/** Resolve the gateway websocket URL via GET /gateway. */
export async function getQQGatewayUrl(accessToken: string, apiBase = QQ_API_BASE): Promise<string> {
  const resp = await connectorsHttpRequest({
    url: `${apiBase}/gateway`,
    method: "GET",
    headers: qqAuthHeaders(accessToken),
  })
  let parsed: { url?: string; message?: string }
  try {
    parsed = JSON.parse(resp.body)
  } catch {
    throw new Error(`QQ /gateway returned non-JSON (status ${resp.status})`)
  }
  if (!parsed.url)
    throw new Error(`QQ /gateway failed: ${parsed.message ?? resp.body.slice(0, 200)}`)
  return parsed.url
}
