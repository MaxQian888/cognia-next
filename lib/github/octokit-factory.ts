/**
 * Octokit factory — single entry point for getting a request-ready Octokit
 * instance for a given repo.
 *
 * Routes between two credential strategies based on the repo's stored
 * `credentialMode`:
 *   - "app": uses `@octokit/auth-app` via {@link getInstallationToken} for
 *     auto-refreshing installation tokens.
 *   - "pat": uses `@octokit/auth-token` via {@link withPatAuth}.
 *
 * Each Octokit gets `@octokit/plugin-throttling` and `@octokit/plugin-retry`
 * applied so secondary rate-limit handling and idempotent retries are uniform
 * across all call sites — workflow nodes, polling task, setup wizard.
 */

import { Octokit } from "@octokit/core"
import { retry } from "@octokit/plugin-retry"
import { throttling } from "@octokit/plugin-throttling"
import { createTokenAuth } from "@octokit/auth-token"
import { getInstallationToken, type AppAuthConfig, type RefreshDeps } from "./auth-app"

const COGNIA_UA = "cognia-github-delivery/1.0"

const ThrottledRetriedOctokit = Octokit.plugin(retry, throttling)
type ConfiguredOctokit = InstanceType<typeof ThrottledRetriedOctokit>

export interface OctokitForRepoOptions {
  repoFullName: string
  /** Credential strategy. */
  mode: "app" | "pat"
  /** App credentials (when mode === "app"). */
  app?: AppAuthConfig & { installationId: number }
  /** PAT (when mode === "pat"). */
  pat?: { token: string }
  /**
   * Optional logger for throttle / retry events. Defaults to no-op.
   * Surface via the audit log in production.
   */
  onWarning?: (msg: string) => void
  /** For tests — see auth-app.RefreshDeps. */
  refreshDeps?: RefreshDeps
}

/** Exported for test coverage of the per-callback paths. */
export const _throttleHandlers = (
  onWarning: ((m: string) => void) | undefined
): {
  onRateLimit: (
    retryAfter: number,
    options: { method?: string; url?: string },
    _octokit: unknown,
    retryCount: number
  ) => boolean
  onSecondaryRateLimit: (
    retryAfter: number,
    options: { method?: string; url?: string },
    _octokit: unknown
  ) => void
} => {
  const log = onWarning ?? (() => {})
  return {
    onRateLimit: (retryAfter, options, _octokit, retryCount) => {
      log(`rate limit hit on ${options.method} ${options.url}; waiting ${retryAfter}s`)
      // Retry up to 3 times for primary rate limits.
      return retryCount < 3
    },
    onSecondaryRateLimit: (retryAfter, options) => {
      log(`secondary rate limit on ${options.method} ${options.url}; waiting ${retryAfter}s`)
    },
  }
}

/**
 * Build an Octokit for the given repo. Caller is responsible for caching the
 * returned instance per repo if desired — this function does not memoize.
 */
export async function getOctokitForRepo(opts: OctokitForRepoOptions): Promise<ConfiguredOctokit> {
  if (opts.mode === "pat") {
    if (!opts.pat?.token) {
      throw new Error(`PAT mode requires opts.pat.token (repo "${opts.repoFullName}")`)
    }
    return new ThrottledRetriedOctokit({
      auth: opts.pat.token,
      authStrategy: createTokenAuth,
      userAgent: COGNIA_UA,
      throttle: _throttleHandlers(opts.onWarning),
    })
  }

  if (!opts.app) {
    throw new Error(
      `App mode requires opts.app with appId, privateKey, installationId (repo "${opts.repoFullName}")`
    )
  }
  const token = await getInstallationToken(
    { appId: opts.app.appId, privateKey: opts.app.privateKey },
    opts.app.installationId,
    opts.refreshDeps
  )
  return new ThrottledRetriedOctokit({
    auth: token,
    authStrategy: createTokenAuth,
    userAgent: COGNIA_UA,
    throttle: _throttleHandlers(opts.onWarning),
  })
}
