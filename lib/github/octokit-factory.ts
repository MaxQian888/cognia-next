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
import { isGithubDotCom, type GithubHost } from "./host"

const COGNIA_UA = "cognia-agent-team/1.0"

const ThrottledRetriedOctokit = Octokit.plugin(retry, throttling)
type ConfiguredOctokit = InstanceType<typeof ThrottledRetriedOctokit>

/**
 * E2E seam: in a bundle built with NEXT_PUBLIC_E2E=1 (the flag is inlined at
 * build time, so this whole branch is dead-code-eliminated from production
 * builds) specs can point every Octokit at the mock GitHub server by
 * publishing `{ github: "<url>" }` through `window.__cogniaSetMockBaseUrls`,
 * which persists to this localStorage key. Without it the workflow github
 * executors always target api.github.com and no E2E assertion can ever see
 * their requests. Exported for the co-located test only.
 */
export function _e2eGithubBaseUrl(): string | undefined {
  if (process.env.NEXT_PUBLIC_E2E !== "1") return undefined
  if (typeof window === "undefined") return undefined
  try {
    const raw = window.localStorage.getItem("cognia.e2e.mockBaseUrls.v1")
    const parsed = raw ? (JSON.parse(raw) as { github?: string }) : undefined
    const url = parsed?.github
    return typeof url === "string" && url.length > 0 ? url.replace(/\/$/, "") : undefined
  } catch {
    return undefined
  }
}

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
  /**
   * Which GitHub deployment this repository lives on (ADR-0176).
   *
   * Defaults to github.com, which is what every caller meant before this
   * existed. Pass the account's host to reach a GitHub Enterprise Server:
   * Octokit's own default is `https://api.github.com`, so without it an
   * enterprise repository is not merely unsupported, it is a 404 against the
   * wrong server.
   */
  host?: GithubHost
}

/**
 * The REST root this Octokit should use, or `undefined` to take Octokit's own
 * default.
 *
 * Precedence is E2E override, then the configured host, then github.com. The
 * E2E override wins because a spec that pointed every request at its mock
 * server must not be silently redirected by a host someone configured, and
 * that branch is dead-code-eliminated from production builds anyway.
 */
export function _resolveBaseUrl(host: GithubHost | undefined): string | undefined {
  const e2e = _e2eGithubBaseUrl()
  if (e2e) return e2e
  if (!host || isGithubDotCom(host)) return undefined
  return host.apiBaseUrl
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
  const baseUrl = _resolveBaseUrl(opts.host)
  if (opts.mode === "pat") {
    if (!opts.pat?.token) {
      throw new Error(`PAT mode requires opts.pat.token (repo "${opts.repoFullName}")`)
    }
    return new ThrottledRetriedOctokit({
      auth: opts.pat.token,
      authStrategy: createTokenAuth,
      userAgent: COGNIA_UA,
      throttle: _throttleHandlers(opts.onWarning),
      ...(baseUrl ? { baseUrl } : {}),
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
    ...(baseUrl ? { baseUrl } : {}),
  })
}
