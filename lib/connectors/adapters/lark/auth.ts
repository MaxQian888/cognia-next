/**
 * Lark tenant access token cache + OAuth flow — Task 88, extended at
 * ADR-0009 v41 / A4 to close the Phase 2 marker by landing the
 * code → user-access-token exchange.
 *
 * Lark requires a tenant-access-token (TAT) for most API calls. The token
 * has a short TTL (typically 7200 s). We cache it in memory and refresh when
 * expired.
 *
 * OAuth flow:
 *  1. Build the authorize URL with `buildLarkOAuthUrl`.
 *  2. Direct the user to the URL; they approve in Lark.
 *  3. Lark redirects to `redirect_uri?code=...&state=...`.
 *  4. Caller verifies `state`, then calls `exchangeCodeForUserAccessToken`
 *     to swap the code + TAT for a user access token + refresh token.
 *  5. Refresh with `refreshUserAccessToken` before the TTL elapses.
 *
 * The exchange endpoint requires an `app_access_token` header — for
 * internal apps that's the TAT (Lark treats `app_access_token` and
 * `tenant_access_token` interchangeably on the OIDC endpoint). The
 * helper accepts both names for clarity.
 */

import { connectorsHttpRequest } from "@/lib/connectors/tauri/commands"

const LARK_TOKEN_URL = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal"

const LARK_OAUTH_URL = "https://open.feishu.cn/open-apis/authen/v1/authorize"

const LARK_OIDC_ACCESS_TOKEN_URL = "https://open.feishu.cn/open-apis/authen/v1/oidc/access_token"

const LARK_OIDC_REFRESH_TOKEN_URL =
  "https://open.feishu.cn/open-apis/authen/v1/oidc/refresh_access_token"

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

// ---------------------------------------------------------------------------
// OAuth code-exchange (Phase 2 — closed at ADR-0009 v41 / A4)
// ---------------------------------------------------------------------------

/**
 * Credentials returned by Lark's `/oidc/access_token` endpoint. Stored
 * in the keyring by the caller (typically `oauth-registry.ts`) under
 * `<adapterId>:user_token` + `<adapterId>:user_refresh_token` so each
 * configured Lark adapter can operate on behalf of its own paired user.
 *
 * Lark's payload also returns `open_id` / `union_id` / `name` / `avatar_url`
 * — the helper surfaces those alongside the tokens so the renderer can
 * show "Connected as Alice" without a second `/authen/v1/userinfo` call.
 */
export interface LarkUserAccessTokenResult {
  accessToken: string
  refreshToken: string
  /** Seconds until `accessToken` expires (Lark default is 7200 s). */
  expiresInSec: number
  /** Seconds until `refreshToken` expires (Lark default is 31104000 s — 360 d). */
  refreshExpiresInSec: number
  openId: string
  unionId?: string
  tokenType: string
  scope?: string
  name?: string
  avatarUrl?: string
  email?: string
  enterpriseEmail?: string
}

interface LarkOidcAccessTokenResponse {
  code: number
  msg?: string
  data?: {
    access_token?: string
    refresh_token?: string
    token_type?: string
    expires_in?: number
    refresh_expires_in?: number
    scope?: string
    open_id?: string
    union_id?: string
    name?: string
    avatar_url?: string
    email?: string
    enterprise_email?: string
  }
}

/**
 * Exchange the authorization `code` Lark redirected to our callback for
 * a `user_access_token` + `refresh_token` pair via the OIDC endpoint.
 *
 * Requires the caller to have already fetched a tenant access token for
 * the same app (via `getTenantAccessToken`) — Lark uses the TAT as the
 * `Authorization: Bearer …` header on `/authen/v1/oidc/access_token`.
 *
 * Throws when Lark returns a non-zero `code`. The original `msg` is
 * propagated so OAuth UI surfaces can show the user a meaningful error.
 */
export async function exchangeCodeForUserAccessToken(opts: {
  /** Authorization code from the redirect URL. */
  code: string
  /** Tenant access token (acts as the app access token on this endpoint). */
  appAccessToken: string
}): Promise<LarkUserAccessTokenResult> {
  const resp = await connectorsHttpRequest({
    url: LARK_OIDC_ACCESS_TOKEN_URL,
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${opts.appAccessToken}`,
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code: opts.code,
    }),
  })

  const parsed = JSON.parse(resp.body) as LarkOidcAccessTokenResponse
  if (parsed.code !== 0 || !parsed.data?.access_token || !parsed.data?.refresh_token) {
    throw new Error(
      `Lark OIDC access_token failed: code=${parsed.code}, msg=${parsed.msg ?? "unknown"}`
    )
  }
  const d = parsed.data
  return {
    accessToken: d.access_token!,
    refreshToken: d.refresh_token!,
    expiresInSec: d.expires_in ?? 7200,
    refreshExpiresInSec: d.refresh_expires_in ?? 31_104_000,
    openId: d.open_id ?? "",
    unionId: d.union_id,
    tokenType: d.token_type ?? "Bearer",
    scope: d.scope,
    name: d.name,
    avatarUrl: d.avatar_url,
    email: d.email,
    enterpriseEmail: d.enterprise_email,
  }
}

/**
 * Refresh a Lark `user_access_token` using its `refresh_token` before the
 * 7200 s TTL elapses. Lark may rotate the refresh token (return a new
 * `refresh_token` in the response); callers MUST persist whatever comes
 * back rather than re-using the old refresh token.
 */
export async function refreshUserAccessToken(opts: {
  refreshToken: string
  appAccessToken: string
}): Promise<LarkUserAccessTokenResult> {
  const resp = await connectorsHttpRequest({
    url: LARK_OIDC_REFRESH_TOKEN_URL,
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${opts.appAccessToken}`,
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: opts.refreshToken,
    }),
  })

  const parsed = JSON.parse(resp.body) as LarkOidcAccessTokenResponse
  if (parsed.code !== 0 || !parsed.data?.access_token || !parsed.data?.refresh_token) {
    throw new Error(
      `Lark OIDC refresh_access_token failed: code=${parsed.code}, msg=${parsed.msg ?? "unknown"}`
    )
  }
  const d = parsed.data
  return {
    accessToken: d.access_token!,
    refreshToken: d.refresh_token!,
    expiresInSec: d.expires_in ?? 7200,
    refreshExpiresInSec: d.refresh_expires_in ?? 31_104_000,
    openId: d.open_id ?? "",
    unionId: d.union_id,
    tokenType: d.token_type ?? "Bearer",
    scope: d.scope,
    name: d.name,
    avatarUrl: d.avatar_url,
    email: d.email,
    enterpriseEmail: d.enterprise_email,
  }
}
