/**
 * GitHub App installation token cache and refresh.
 *
 * GitHub App installation tokens expire 1 hour after creation. We cache them
 * per (appId, installationId) and refresh **5 minutes before expiry** so the
 * caller never sees a 401. The underlying token minting is delegated to
 * `@octokit/auth-app`'s `createAppAuth` strategy which signs JWTs with the
 * App's private key and exchanges them for an installation token.
 */

import { createAppAuth } from "@octokit/auth-app"

export interface AppAuthConfig {
  /** Numeric GitHub App id (from the App settings page). */
  appId: number
  /** PEM-encoded RSA private key. */
  privateKey: string
}

interface CachedToken {
  token: string
  /** Unix epoch ms. */
  expiresAt: number
}

/** Refresh `REFRESH_BEFORE_EXPIRY_MS` before expiry to avoid 401 race. */
const REFRESH_BEFORE_EXPIRY_MS = 5 * 60_000

/**
 * Cache for installation tokens keyed by `${appId}:${installationId}`.
 *
 * Module-scoped so multiple call sites in the same process share one cache.
 * Tests can call `clearInstallationTokenCache()` to reset.
 */
const cache = new Map<string, CachedToken>()

export function clearInstallationTokenCache(): void {
  cache.clear()
}

function cacheKey(appId: number, installationId: number): string {
  return `${appId}:${installationId}`
}

export interface RefreshDeps {
  /** Override for the time-source — useful in tests. Defaults to `Date.now`. */
  now?: () => number
  /**
   * Override for the token minter. Default uses `@octokit/auth-app`. Tests
   * inject a stub to avoid hitting GitHub.
   */
  mintToken?: (
    cfg: AppAuthConfig,
    installationId: number
  ) => Promise<{ token: string; expiresAt: number }>
}

/** Exported for tests. Production callers should use {@link getInstallationToken}. */
export async function _defaultMintToken(
  cfg: AppAuthConfig,
  installationId: number
): Promise<{ token: string; expiresAt: number }> {
  const auth = createAppAuth({
    appId: cfg.appId,
    privateKey: cfg.privateKey,
    installationId,
  })
  const result = (await auth({ type: "installation", installationId })) as {
    token: string
    expiresAt: string
  }
  return {
    token: result.token,
    // result.expiresAt is ISO-8601 string per the @octokit/auth-app contract.
    expiresAt: new Date(result.expiresAt).getTime(),
  }
}

/**
 * Get a fresh installation token. Returns the cached token when it has more
 * than `REFRESH_BEFORE_EXPIRY_MS` remaining; otherwise mints a new one.
 */
export async function getInstallationToken(
  cfg: AppAuthConfig,
  installationId: number,
  deps: RefreshDeps = {}
): Promise<string> {
  const now = deps.now ? deps.now() : Date.now()
  const mint = deps.mintToken ?? _defaultMintToken

  const key = cacheKey(cfg.appId, installationId)
  const cached = cache.get(key)
  if (cached && cached.expiresAt - now > REFRESH_BEFORE_EXPIRY_MS) {
    return cached.token
  }

  const minted = await mint(cfg, installationId)
  cache.set(key, { token: minted.token, expiresAt: minted.expiresAt })
  return minted.token
}

/**
 * Force-evict the cached token for a given installation. Call on observed 401
 * to ensure the next request mints fresh credentials rather than retrying
 * with the stale cached token.
 */
export function evictInstallationToken(appId: number, installationId: number): void {
  cache.delete(cacheKey(appId, installationId))
}

/** Test-only helper: peek at the cache. */
export function _peekInstallationCache(
  appId: number,
  installationId: number
): CachedToken | undefined {
  return cache.get(cacheKey(appId, installationId))
}
