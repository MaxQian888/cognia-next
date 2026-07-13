/**
 * Lark tenant access token cache + OAuth flow — Task 88, extended at
 * ADR-0009 v41 / A4 to close the Phase 2 marker by landing the
 * code → user-access-token exchange.
 *
 * Lark requires a tenant-access-token (TAT) for most API calls. The token
 * has a short TTL (typically 7200 s). We cache it in memory and refresh when
 * expired.
 *
 * OAuth 2.0 flow (aligned with Feishu's current authorization-code spec):
 *  1. Build the authorize URL with `buildLarkOAuthUrl` — hits
 *     `accounts.feishu.cn/open-apis/authen/v1/authorize` with `client_id`,
 *     `response_type=code`, `scope`, `state` and a PKCE `code_challenge`.
 *  2. Direct the user to the URL; they approve in Lark.
 *  3. Lark redirects to `redirect_uri?code=...&state=...`.
 *  4. Caller verifies `state`, then calls `exchangeCodeForUserAccessToken`
 *     with `client_id` + `client_secret` + the PKCE `code_verifier` to swap
 *     the code for a user access token + refresh token via the v2
 *     `authen/v2/oauth/token` endpoint (no tenant token needed).
 *  5. Refresh with `refreshUserAccessToken` before the TTL elapses. A
 *     `refresh_token` is only issued when the `offline_access` scope is
 *     granted (see `LARK_SENDAS_SCOPES`).
 *  6. The token endpoints return only tokens; `fetchLarkUserInfo` resolves the
 *     connected user's identity (open_id / name / …) for the UI.
 */

import {
  connectorsHttpRequest,
  connectorsKeyringGet,
  connectorsKeyringSet,
} from "@/lib/connectors/tauri/commands"
import { CODE_CHALLENGE_METHOD } from "./pkce"

const LARK_TOKEN_URL = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal"

/** OAuth 2.0 authorization endpoint (accounts host, client_id + response_type). */
const LARK_OAUTH_URL = "https://accounts.feishu.cn/open-apis/authen/v1/authorize"

/** OAuth 2.0 token endpoint — code→token and refresh both POST here. */
const LARK_TOKEN_V2_URL = "https://open.feishu.cn/open-apis/authen/v2/oauth/token"

/** User-identity endpoint — resolves open_id / name / email from a user token. */
const LARK_USER_INFO_URL = "https://open.feishu.cn/open-apis/authen/v1/user_info"

/**
 * Scopes requested for the send-as-user flow. `offline_access` is mandatory —
 * Feishu only issues a `refresh_token` when it is granted; `im:message` lets the
 * user token send messages. The exact set must be enabled + approved for the app
 * in the Lark console (Permissions), and the granted scopes must cover these.
 */
export const LARK_SENDAS_SCOPES = "offline_access im:message"

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
  /** The app's App ID — sent as the OAuth 2.0 `client_id`. */
  appId: string
  redirectUri: string
  state: string
  /** Space-separated scopes (e.g. `LARK_SENDAS_SCOPES`). */
  scope?: string
  /** PKCE challenge = base64url(SHA-256(verifier)); pairs with S256. */
  codeChallenge?: string
}

/**
 * Build the Lark OAuth 2.0 authorization URL.
 *
 * Directs the user to Feishu's authorize endpoint with `client_id` +
 * `response_type=code` (both required by the current spec), the requested
 * scopes, and — when supplied — the PKCE `code_challenge`. After the user
 * approves, Lark redirects to `redirectUri?code=<code>&state=<state>`. The
 * caller verifies `state` on redirect.
 */
export function buildLarkOAuthUrl(input: LarkOAuthUrlInput): string {
  const params = new URLSearchParams()
  params.set("client_id", input.appId)
  params.set("response_type", "code")
  params.set("redirect_uri", input.redirectUri)
  params.set("state", input.state)
  if (input.scope) params.set("scope", input.scope)
  if (input.codeChallenge) {
    params.set("code_challenge", input.codeChallenge)
    params.set("code_challenge_method", CODE_CHALLENGE_METHOD)
  }
  return `${LARK_OAUTH_URL}?${params.toString()}`
}

// ---------------------------------------------------------------------------
// OAuth code-exchange (Phase 2 — closed at ADR-0009 v41 / A4)
// ---------------------------------------------------------------------------

/**
 * Tokens returned by Lark's `authen/v2/oauth/token` endpoint. Stored in the
 * keyring by the caller (`oauth-handler.ts`) under `<adapterId>:user_token` +
 * `<adapterId>:user_refresh_token` so each configured Lark adapter can operate
 * on behalf of its own paired user. The v2 endpoint returns tokens only —
 * identity is resolved separately via `fetchLarkUserInfo`.
 */
export interface LarkUserAccessTokenResult {
  accessToken: string
  refreshToken: string
  /** Seconds until `accessToken` expires (Lark default is 7200 s). */
  expiresInSec: number
  /** Seconds until `refreshToken` expires (Lark default is 31104000 s — 360 d). */
  refreshExpiresInSec: number
  tokenType: string
  scope?: string
}

/** Connected-user identity resolved from `fetchLarkUserInfo`. */
export interface LarkUserInfo {
  openId: string
  unionId?: string
  name?: string
  avatarUrl?: string
  email?: string
  enterpriseEmail?: string
}

/**
 * `authen/v2/oauth/token` response. OAuth 2.0-flat: tokens at the top level,
 * with a Feishu `code` (0 = success) and `error`/`error_description` on failure.
 */
interface LarkTokenV2Response {
  code?: number
  error?: string
  error_description?: string
  access_token?: string
  refresh_token?: string
  token_type?: string
  expires_in?: number
  refresh_token_expires_in?: number
  scope?: string
}

interface LarkUserInfoResponse {
  code: number
  msg?: string
  data?: {
    open_id?: string
    union_id?: string
    name?: string
    avatar_url?: string
    email?: string
    enterprise_email?: string
  }
}

/**
 * Parse + validate a v2 token response into the internal token shape. Throws
 * with Feishu's own `error_description`/`error`/code when the exchange failed.
 */
function parseTokenV2Response(rawBody: string, context: string): LarkUserAccessTokenResult {
  const parsed = JSON.parse(rawBody) as LarkTokenV2Response
  if ((parsed.code !== undefined && parsed.code !== 0) || !parsed.access_token || !parsed.refresh_token) {
    const detail =
      parsed.error_description ?? parsed.error ?? (parsed.code !== undefined ? `code=${parsed.code}` : "unknown")
    throw new Error(`Lark ${context} failed: ${detail}`)
  }
  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token,
    expiresInSec: parsed.expires_in ?? 7200,
    refreshExpiresInSec: parsed.refresh_token_expires_in ?? 31_104_000,
    tokenType: parsed.token_type ?? "Bearer",
    scope: parsed.scope,
  }
}

/**
 * Exchange the authorization `code` Lark redirected to our callback for a
 * `user_access_token` + `refresh_token` pair via the v2 OAuth token endpoint.
 *
 * The v2 endpoint takes `client_id` + `client_secret` in the JSON body (no
 * tenant token / Bearer header). `redirect_uri` must match the value sent to
 * the authorize endpoint, and `code_verifier` must match the PKCE challenge.
 *
 * Throws when Lark returns a non-zero `code` / OAuth `error`; the detail is
 * propagated so OAuth UI surfaces can show the user a meaningful error.
 */
export async function exchangeCodeForUserAccessToken(opts: {
  /** Authorization code from the redirect URL. */
  code: string
  appId: string
  appSecret: string
  /** Must match the redirect_uri sent to the authorize endpoint. */
  redirectUri: string
  /** PKCE verifier matching the challenge sent to authorize. */
  codeVerifier?: string
}): Promise<LarkUserAccessTokenResult> {
  const body: Record<string, string> = {
    grant_type: "authorization_code",
    client_id: opts.appId,
    client_secret: opts.appSecret,
    code: opts.code,
    redirect_uri: opts.redirectUri,
  }
  if (opts.codeVerifier) body.code_verifier = opts.codeVerifier

  const resp = await connectorsHttpRequest({
    url: LARK_TOKEN_V2_URL,
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  })
  return parseTokenV2Response(resp.body, "oauth/token access")
}

/**
 * Refresh a Lark `user_access_token` using its `refresh_token` via the v2
 * token endpoint. Lark may rotate the refresh token (return a new
 * `refresh_token`); callers MUST persist whatever comes back rather than
 * re-using the old refresh token.
 */
export async function refreshUserAccessToken(opts: {
  refreshToken: string
  appId: string
  appSecret: string
}): Promise<LarkUserAccessTokenResult> {
  const resp = await connectorsHttpRequest({
    url: LARK_TOKEN_V2_URL,
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: opts.appId,
      client_secret: opts.appSecret,
      refresh_token: opts.refreshToken,
    }),
  })
  return parseTokenV2Response(resp.body, "oauth/token refresh")
}

/**
 * Resolve the connected user's identity (open_id / name / email / …) from a
 * `user_access_token` via `authen/v1/user_info`. Called once after the code
 * exchange so the UI can render "Connected as Alice". Sensitive fields
 * (email, enterprise_email) are only present when the app was granted the
 * matching scope — the caller tolerates their absence.
 */
export async function fetchLarkUserInfo(accessToken: string): Promise<LarkUserInfo> {
  const resp = await connectorsHttpRequest({
    url: LARK_USER_INFO_URL,
    method: "GET",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${accessToken}`,
    },
  })
  const parsed = JSON.parse(resp.body) as LarkUserInfoResponse
  if (parsed.code !== 0 || !parsed.data) {
    throw new Error(`Lark user_info failed: code=${parsed.code}, msg=${parsed.msg ?? "unknown"}`)
  }
  const d = parsed.data
  return {
    openId: d.open_id ?? "",
    unionId: d.union_id,
    name: d.name,
    avatarUrl: d.avatar_url,
    email: d.email,
    enterpriseEmail: d.enterprise_email,
  }
}

// ---------------------------------------------------------------------------
// User access token — send-as-user path (ADR-0009 v41 / A4 completion)
//
// `oauth-handler.ts` persists `user_token` + `user_refresh_token` in the
// keyring after the OAuth exchange. Until now nothing read them. These helpers
// resolve + silently refresh the user access token so the adapter's `send()`
// can act on behalf of the connected user (opt-in via `settings.sendAsUser`).
// ---------------------------------------------------------------------------

interface UserTokenCacheEntry {
  token: string
  /**
   * Wall-clock ms the token expires, when known (only after an in-process
   * refresh). Undefined on a cold keyring read — we can't know the persisted
   * token's remaining TTL, so we serve it optimistically and let the 401 /
   * invalid-code refresh path (`withUserTokenRefresh`) recover on expiry.
   */
  expiresAtMs?: number
}

const userTokenCache = new Map<string, UserTokenCacheEntry>()

/**
 * Resolve the current user access token for `adapterId`. Returns the cached
 * in-memory token when fresh, else reads the persisted `user_token` from the
 * keyring. Returns null when the adapter has no connected user.
 */
export async function getUserAccessToken(adapterId: string): Promise<string | null> {
  const now = Date.now()
  const cached = userTokenCache.get(adapterId)
  if (cached && (cached.expiresAtMs === undefined || cached.expiresAtMs - now > 60_000)) {
    return cached.token
  }
  const stored = await connectorsKeyringGet(adapterId, "user_token")
  if (!stored) return null
  userTokenCache.set(adapterId, { token: stored })
  return stored
}

/**
 * Refresh the user access token for `adapterId` using the persisted
 * `user_refresh_token` via the v2 token endpoint (`client_id` + `client_secret`
 * in the body — no tenant token needed). Persists the rotated pair back to the
 * keyring (Lark may rotate the refresh token) and updates the in-memory cache.
 * Throws when no refresh token is stored or Lark rejects it.
 */
export async function refreshUserToken(opts: {
  adapterId: string
  appId: string
  appSecret: string
}): Promise<string> {
  const refreshToken = await connectorsKeyringGet(opts.adapterId, "user_refresh_token")
  if (!refreshToken) {
    throw new Error(`Lark user token refresh: no refresh token stored for ${opts.adapterId}`)
  }
  const tokens = await refreshUserAccessToken({
    refreshToken,
    appId: opts.appId,
    appSecret: opts.appSecret,
  })
  await connectorsKeyringSet(opts.adapterId, "user_token", tokens.accessToken)
  await connectorsKeyringSet(opts.adapterId, "user_refresh_token", tokens.refreshToken)
  userTokenCache.set(opts.adapterId, {
    token: tokens.accessToken,
    expiresAtMs: Date.now() + tokens.expiresInSec * 1000,
  })
  return tokens.accessToken
}

/** Clear the in-memory user-token cache for an adapter (tests / disconnect). */
export function clearUserTokenCache(adapterId: string): void {
  userTokenCache.delete(adapterId)
}
