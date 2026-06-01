/**
 * DingTalk (钉钉) open-platform authentication.
 *
 * Enterprise-internal apps mint a short-lived app access token from their
 * AppKey + AppSecret:
 *   POST https://api.dingtalk.com/v1.0/oauth2/accessToken { appKey, appSecret }
 *     → { accessToken, expireIn }   (expireIn in seconds, ~7200)
 *
 * The token authorises every new-style `/v1.0/…` OpenAPI call via the
 * `x-acs-dingtalk-access-token` header. We cache it per (appKey, appSecret)
 * and refresh a minute before expiry. The Stream-mode gateway registration
 * uses the raw appKey/appSecret instead (see stream-client.ts), not this token.
 */

import { connectorsHttpRequest } from "@/lib/connectors/tauri/commands"

const TOKEN_URL = "https://api.dingtalk.com/v1.0/oauth2/accessToken"
export const DINGTALK_API_BASE = "https://api.dingtalk.com"

interface CacheEntry {
  token: string
  expiresAt: number
}

const cache = new Map<string, CacheEntry>()

export async function getDingTalkAccessToken(appKey: string, appSecret: string): Promise<string> {
  const key = `${appKey}:${appSecret}`
  const now = Date.now()
  const cached = cache.get(key)
  if (cached && cached.expiresAt > now + 60_000) return cached.token

  const resp = await connectorsHttpRequest({
    url: TOKEN_URL,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appKey, appSecret }),
  })
  let parsed: { accessToken?: string; expireIn?: number; message?: string; code?: string }
  try {
    parsed = JSON.parse(resp.body)
  } catch {
    throw new Error(`DingTalk accessToken returned non-JSON (status ${resp.status})`)
  }
  if (!parsed.accessToken) {
    throw new Error(`DingTalk accessToken failed: ${parsed.message ?? resp.body.slice(0, 200)}`)
  }
  const expiresInSec = typeof parsed.expireIn === "number" ? parsed.expireIn : 7200
  const entry: CacheEntry = { token: parsed.accessToken, expiresAt: now + expiresInSec * 1000 }
  cache.set(key, entry)
  return entry.token
}

export function clearDingTalkTokenCache(appKey: string, appSecret: string): void {
  cache.delete(`${appKey}:${appSecret}`)
}

/** Header carrying the app access token for new-style `/v1.0/…` OpenAPI calls. */
export function dingtalkAuthHeaders(accessToken: string): Record<string, string> {
  return {
    "x-acs-dingtalk-access-token": accessToken,
    "Content-Type": "application/json",
  }
}
