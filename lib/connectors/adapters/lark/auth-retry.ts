/**
 * Lark tenant-access-token refresh wrapper.
 *
 * The TAT cache in `auth.ts` keys on `appId:appSecret` and refreshes only
 * when its local TTL expires (7200 s by default). When the Lark server
 * invalidates the token early — credentials rotated, security audit,
 * app re-installed — every subsequent call fails with HTTP 401 or the
 * Lark error code 99991663 ("invalid access_token") until the cache
 * naturally expires, which can leave the adapter dead for nearly two
 * hours.
 *
 * `withTatRefresh` wraps a Lark API invocation: on TAT invalidation, it
 * clears the cache entry for the same `(appId, appSecret)` pair and
 * retries the call exactly once. Anything else propagates unchanged.
 *
 * The detection is intentionally broad — it inspects both `LarkApiError`
 * instances (thrown by the adapter's `doRequest`) and plain `Error`
 * objects whose message embeds a Lark error code (which is what the
 * Rust-side `connectors_lark_upload_*` commands surface).
 */

import { clearTokenCache, refreshUserToken } from "./auth"

/** Lark error codes signalling the tenant access token is no longer valid. */
export const TAT_INVALIDATION_CODES: ReadonlySet<number> = new Set([
  99991663, // invalid access_token (most common)
  99991664, // invalid app_id (returned when token signature is rejected)
  99991668, // app_access_token expired (variant code)
])

export interface LarkApiErrorInit {
  status: number
  code: number | null
  message: string
}

/**
 * Typed error thrown by Lark adapter call sites so refresh logic can
 * distinguish HTTP-layer failures from Lark business-error codes.
 */
export class LarkApiError extends Error {
  readonly status: number
  readonly code: number | null

  constructor(init: LarkApiErrorInit) {
    super(init.message)
    this.name = "LarkApiError"
    this.status = init.status
    this.code = init.code
  }
}

/**
 * Return true when the error looks like the Lark tenant access token has
 * been invalidated server-side. Matches HTTP 401, Lark error codes in
 * `TAT_INVALIDATION_CODES`, and substring patterns on plain `Error`
 * messages from the Rust-side upload commands.
 */
export function isLarkTatInvalidation(err: unknown): boolean {
  if (err instanceof LarkApiError) {
    if (err.status === 401) return true
    if (err.code !== null && TAT_INVALIDATION_CODES.has(err.code)) return true
    return false
  }
  if (err instanceof Error) {
    const msg = err.message
    if (/(^|\s)401(\b|\D)/.test(msg)) return true
    for (const code of TAT_INVALIDATION_CODES) {
      if (msg.includes(`code=${code}`) || msg.includes(`code: ${code}`)) {
        return true
      }
    }
  }
  return false
}

export interface TatRefreshContext {
  appId: string
  appSecret: string
}

/**
 * Run `fn` once. If it throws an error matching `isLarkTatInvalidation`,
 * clear the cached tenant access token for this `(appId, appSecret)`
 * pair and retry exactly once. The retry's outcome (success or failure)
 * is returned / propagated unchanged — we never retry more than once,
 * to avoid masking persistent credential failures.
 */
export async function withTatRefresh<T>(ctx: TatRefreshContext, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (!isLarkTatInvalidation(err)) throw err
    clearTokenCache(ctx.appId, ctx.appSecret)
    return await fn()
  }
}

// ---------------------------------------------------------------------------
// User access token refresh (send-as-user path)
// ---------------------------------------------------------------------------

/** Lark error codes signalling the user access token is no longer valid. */
export const USER_TOKEN_INVALIDATION_CODES: ReadonlySet<number> = new Set([
  99991677, // invalid user access token
  99991668, // access token expired (variant)
])

/**
 * Return true when the error looks like the Lark USER access token was
 * invalidated (HTTP 401, or a code in `USER_TOKEN_INVALIDATION_CODES`).
 */
export function isLarkUserTokenInvalidation(err: unknown): boolean {
  if (err instanceof LarkApiError) {
    if (err.status === 401) return true
    if (err.code !== null && USER_TOKEN_INVALIDATION_CODES.has(err.code)) return true
    return false
  }
  if (err instanceof Error) {
    const msg = err.message
    if (/(^|\s)401(\b|\D)/.test(msg)) return true
    for (const code of USER_TOKEN_INVALIDATION_CODES) {
      if (msg.includes(`code=${code}`) || msg.includes(`code: ${code}`)) return true
    }
  }
  return false
}

export interface UserTokenRefreshContext {
  adapterId: string
  appId: string
  appSecret: string
}

/**
 * Run `fn` once. If it throws a user-token-invalidation error, refresh the
 * user access token (rotating + persisting it) and retry exactly once. Any
 * other error — or a failure on the retry — propagates so the caller can
 * decide whether to fall back to the bot (tenant) identity.
 */
export async function withUserTokenRefresh<T>(
  ctx: UserTokenRefreshContext,
  fn: () => Promise<T>
): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (!isLarkUserTokenInvalidation(err)) throw err
    await refreshUserToken(ctx)
    return await fn()
  }
}
