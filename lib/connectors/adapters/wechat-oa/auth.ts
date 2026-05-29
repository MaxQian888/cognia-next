/**
 * WeChat Official Account access-token management.
 *
 *   GET https://api.weixin.qq.com/cgi-bin/token
 *       ?grant_type=client_credential&appid=<appId>&secret=<appSecret>
 *     → { access_token, expires_in } | { errcode, errmsg }
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

  const url = `${apiBase}/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(appId)}&secret=${encodeURIComponent(appSecret)}`
  const resp = await connectorsHttpRequest({ url, method: "GET" })
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

export function clearWechatOaTokenCache(appId: string, appSecret: string): void {
  cache.delete(`${appId}:${appSecret}`)
}
