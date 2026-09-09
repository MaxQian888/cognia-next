/**
 * Which GitHub a request is talking to (ADR-0176).
 *
 * `https://api.github.com` was a literal in six places: installation discovery,
 * the App JWT request, the installation-token exchange, the Octokit factory,
 * the delivery plugin's API origin, and its browser allow-list. Every one of
 * them silently meant "github.com only", so a self-hosted GitHub Enterprise
 * Server was not unsupported so much as unreachable, with no message saying so.
 *
 * The fix is a value object rather than a loosened allow-list. A host is
 * something the user configured on an account, and it travels with that
 * account. Nothing here widens what may be reached by default: with no
 * configuration this module answers `github.com` and only `github.com`.
 *
 * # Why the API base cannot be derived from the web base
 *
 * github.com serves its API from a *different host* (`api.github.com`).
 * GitHub Enterprise Server serves it from a *path* on the same host
 * (`https://ghe.example.com/api/v3`). One rule cannot produce both, which is
 * why `GithubHost` carries the two URLs rather than one plus a convention.
 */

/** A GitHub deployment: github.com, or one GitHub Enterprise Server. */
export interface GithubHost {
  /**
   * Stable identity, the lowercase hostname repositories live on.
   * `github.com` for the public one, `ghe.example.com` for a GHES.
   */
  id: string
  /** REST root, no trailing slash. `https://api.github.com`, `https://ghe.example.com/api/v3`. */
  apiBaseUrl: string
  /** Where repositories and pull requests live in a browser, no trailing slash. */
  webBaseUrl: string
}

/** The public deployment. The default everywhere, and the only one by default. */
export const GITHUB_DOT_COM: GithubHost = Object.freeze({
  id: "github.com",
  apiBaseUrl: "https://api.github.com",
  webBaseUrl: "https://github.com",
})

/** The path GitHub Enterprise Server serves its REST API from. */
const GHES_API_PATH = "/api/v3"

/**
 * Turn what a user typed into a host, or `undefined` when it is not one.
 *
 * Accepts either the web root (`https://ghe.example.com`) or the API root
 * (`https://ghe.example.com/api/v3`), because a user copying a URL out of
 * their own documentation may have either, and guessing wrong produces 404s
 * that read like a broken token.
 *
 * **https only.** A credential is sent to this origin. Returning `undefined`
 * for `http://` is the refusal: the caller falls back to github.com or reports
 * the field as invalid, and neither of those leaks the token in clear text.
 */
export function parseGithubHost(input: string | null | undefined): GithubHost | undefined {
  const raw = input?.trim()
  if (!raw) return undefined

  let url: URL
  try {
    // A bare hostname is the common paste. Assume https rather than rejecting,
    // since the scheme is not optional below and http is refused outright.
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`)
  } catch {
    return undefined
  }
  if (url.protocol !== "https:") return undefined
  if (!url.hostname) return undefined

  const hostname = url.hostname.toLowerCase()
  if (hostname === "github.com" || hostname === "api.github.com" || hostname === "www.github.com") {
    return GITHUB_DOT_COM
  }

  // `https://ghe.example.com/api/v3/` and `https://ghe.example.com/` are the
  // same deployment. Strip the API suffix so the web base is the web base.
  const path = url.pathname.replace(/\/+$/, "")
  const webPath = path.endsWith(GHES_API_PATH) ? path.slice(0, -GHES_API_PATH.length) : path
  const webBaseUrl = `${url.origin}${webPath}`
  return {
    id: hostname,
    apiBaseUrl: `${webBaseUrl}${GHES_API_PATH}`,
    webBaseUrl,
  }
}

/**
 * Which configured host a git remote belongs to.
 *
 * `undefined` means "not a GitHub we know about", which is a refusal and not a
 * reason to try github.com: sending a github.com installation token to an
 * unrecognised host is exactly the mistake the per-account host exists to
 * prevent.
 */
export function resolveGithubHostForRemote(
  remote: string,
  configured: readonly GithubHost[] = []
): GithubHost | undefined {
  const hostname = remoteHostname(remote)
  if (!hostname) return undefined
  if (hostname === "github.com" || hostname === "www.github.com") return GITHUB_DOT_COM
  return configured.find((host) => host.id === hostname)
}

/**
 * The hostname a git remote points at, for `https://`, `ssh://` and the
 * `git@host:owner/repo.git` scp-like form git accepts.
 */
export function remoteHostname(remote: string): string | undefined {
  const raw = remote?.trim()
  if (!raw) return undefined
  const scpLike = /^[^/@]+@([^/:]+):/.exec(raw)
  if (scpLike) return scpLike[1].toLowerCase()
  try {
    const url = new URL(raw)
    return url.hostname ? url.hostname.toLowerCase() : undefined
  } catch {
    return undefined
  }
}

/**
 * `owner/repo` on `host`, as an https remote.
 *
 * The canonical remote is built from the host and the repository identity the
 * caller already holds, never read back out of the checkout's git config: a
 * workspace an agent has written to can rewrite its own `origin`, and the push
 * target must not be something the agent chose.
 */
export function repositoryRemoteUrl(host: GithubHost, repoFullName: string): string {
  const trimmed = repoFullName.trim().replace(/^\/+|\/+$/g, "")
  if (!/^[^/\s]+\/[^/\s]+$/.test(trimmed)) {
    throw new Error(`Not an "owner/repository" name: ${repoFullName}`)
  }
  return `${host.webBaseUrl}/${trimmed.replace(/\.git$/i, "")}.git`
}

/** True when this is the public deployment, so callers can skip GHES-only work. */
export function isGithubDotCom(host: GithubHost): boolean {
  return host.id === GITHUB_DOT_COM.id
}
