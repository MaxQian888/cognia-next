/**
 * WeChat Official Account access-token management.
 *
 *   POST https://api.weixin.qq.com/cgi-bin/stable_token
 *     { grant_type: "client_credential", appid, secret }
 *     → { access_token, expires_in } | { errcode, errmsg }
 *
 * Uses the stable_token endpoint (the recommended replacement for the legacy
 * GET /cgi-bin/token) with the default `force_refresh: false` semantics —
 * repeated calls return the same token until it nears expiry, so a crashed
 * peer cannot invalidate our cached token.
 * Doc: https://developers.weixin.qq.com/doc/offiaccount/Basic_Information/getStableAccessToken.html
 *
 * Tokens are app-wide and short-lived (~2h). Cached per (appId, appSecret)
 * and refreshed a minute before expiry. Used to call the 客服 message API for
 * outbound replies.
 */

import { connectorsHttpRequest } from "@/lib/connectors/tauri/commands"

export const WECHAT_API_BASE = "https://api.weixin.qq.com"

interface CacheEntry {
  token: string
  expiresAt: number
}

const cache = new Map<string, CacheEntry>()

export async function getWechatOaAccessToken(
  appId: string,
  appSecret: string,
  apiBase = WECHAT_API_BASE
): Promise<string> {
  const key = `${appId}:${appSecret}`
  const now = Date.now()
  const cached = cache.get(key)
  if (cached && cached.expiresAt > now + 60_000) return cached.token

  const resp = await connectorsHttpRequest({
    url: `${apiBase}/cgi-bin/stable_token`,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // force_refresh defaults to false server-side: WeChat returns the current
    // valid token instead of minting (and invalidating) a new one.
    body: JSON.stringify({ grant_type: "client_credential", appid: appId, secret: appSecret }),
  })
  let parsed: { access_token?: string; expires_in?: number; errcode?: number; errmsg?: string }
  try {
    parsed = JSON.parse(resp.body)
  } catch {
    throw new Error(`WeChat OA token returned non-JSON (status ${resp.status})`)
  }
  if (!parsed.access_token) {
    throw new Error(
      `WeChat OA token failed: ${parsed.errmsg ?? parsed.errcode ?? resp.body.slice(0, 200)}`
    )
  }
  const entry: CacheEntry = {
    token: parsed.access_token,
    expiresAt: now + (parsed.expires_in ?? 7200) * 1000,
  }
  cache.set(key, entry)
  return entry.token
}

/**
 * Drop cached token(s) so the next `getWechatOaAccessToken` re-fetches.
 *
 * With both arguments, clears the single (appId, appSecret) entry. Without
 * arguments, clears every entry — used by the adapter's send-path auth
 * recovery and `refreshCredentials()`, which only hold an opaque token
 * resolver and cannot name the credential pair.
 */
export function clearWechatOaTokenCache(appId?: string, appSecret?: string): void {
  if (appId !== undefined && appSecret !== undefined) {
    cache.delete(`${appId}:${appSecret}`)
  } else {
    cache.clear()
  }
}
