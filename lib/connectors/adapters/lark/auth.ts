/**
 * Lark tenant access token cache + OAuth URL builder — Task 88.
 *
 * Lark requires a tenant-access-token (TAT) for most API calls. The token
 * has a short TTL (typically 7200 s). We cache it in memory and refresh when
 * expired.
 *
 * OAuth flow: redirect the user to Lark's authorize endpoint; on callback
 * exchange the code for a user access token (Phase 2). Phase 1 ships the URL
 * builder only.
 */

import { connectorsHttpRequest } from "@/lib/connectors/tauri/commands"

const LARK_TOKEN_URL = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal"

const LARK_OAUTH_URL = "https://open.feishu.cn/open-apis/authen/v1/authorize"

// ---------------------------------------------------------------------------
// Token cache
// ---------------------------------------------------------------------------

interface TokenCacheEntry {
  token: string
  expiresAtMs: number
}

// In-memory cache keyed by "appId:appSecret"
const tokenCache = new Map<string, TokenCacheEntry>()

interface TenantTokenResponse {
  code: number
  tenant_access_token?: string
  expire?: number
  msg?: string
}

/**
 * Fetch and cache a Lark tenant access token.
 *
 * Re-uses a cached token if it has more than 60 s remaining.
 * Otherwise fetches a fresh one via POST to /auth/v3/tenant_access_token/internal.
 *
 * @param opts.appId      Lark App ID (cli_...)
 * @param opts.appSecret  Lark App Secret
 * @returns The tenant access token string
 * @throws Error if the Lark API returns a non-zero code
 */
export async function getTenantAccessToken(opts: {
  appId: string
  appSecret: string
}): Promise<string> {
  const cacheKey = `${opts.appId}:${opts.appSecret}`
  const now = Date.now()

  const cached = tokenCache.get(cacheKey)
  if (cached && cached.expiresAtMs - now > 60_000) {
    return cached.token
  }

  const resp = await connectorsHttpRequest({
    url: LARK_TOKEN_URL,
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: opts.appId, app_secret: opts.appSecret }),
  })

  const parsed = JSON.parse(resp.body) as TenantTokenResponse

  if (parsed.code !== 0 || !parsed.tenant_access_token) {
    throw new Error(
      `Lark tenant_access_token failed: code=${parsed.code}, msg=${parsed.msg ?? "unknown"}`
    )
  }

  const ttlSec = parsed.expire ?? 7200
  const entry: TokenCacheEntry = {
    token: parsed.tenant_access_token,
    expiresAtMs: now + ttlSec * 1000,
  }
  tokenCache.set(cacheKey, entry)

  return entry.token
}

/**
 * Clear the token cache entry for a given app.
 *
 * Useful in tests or when credentials are rotated.
 */
export function clearTokenCache(appId: string, appSecret: string): void {
  tokenCache.delete(`${appId}:${appSecret}`)
}

// ---------------------------------------------------------------------------
// OAuth URL builder
// ---------------------------------------------------------------------------

export interface LarkOAuthUrlInput {
  appId: string
  redirectUri: string
  state: string
}

/**
 * Build the Lark OAuth 2.0 authorization URL.
 *
 * Directs the user to Lark's authorize endpoint. After the user approves,
 * Lark redirects to `redirectUri?code=<code>&state=<state>`.
 * The caller is responsible for verifying `state` on redirect.
 */
export function buildLarkOAuthUrl(input: LarkOAuthUrlInput): string {
  const params = new URLSearchParams()
  params.set("app_id", input.appId)
  params.set("redirect_uri", input.redirectUri)
  params.set("state", input.state)
  return `${LARK_OAUTH_URL}?${params.toString()}`
}
