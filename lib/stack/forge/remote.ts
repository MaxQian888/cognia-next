/**
 * Which forge, if any, is behind a remote URL.
 *
 * `owner/name` alone is not enough to decide anything. A repository on
 * `gitlab.com` and one on a self-hosted GitHub Enterprise both parse to a
 * plausible-looking pair, and a caller that only asks "did it parse" ends up
 * sending GitHub API calls to a host that has never heard of them. So the
 * answer names the forge, and "some other host" is a distinct answer from
 * "this is not a remote we can read at all" — the two produce different
 * sentences in the panel, and only one of them is worth telling the user to
 * fix.
 *
 * A remote with no host (`file://`, a bare path, a relative worktree) is not a
 * forge and returns null: there is nothing to publish a pull request to.
 */

import { GITHUB_DOT_COM, type GithubHost } from "@/lib/github/host"

export type ForgeRemote =
  /**
   * GitHub proper. `fullName` is `owner/name`, with no `.git` suffix, and
   * `host` names which deployment it lives on (ADR-0176).
   */
  | { forge: "github"; fullName: string; host: GithubHost }
  /** A real host we have no adapter for — GitLab, Gitea, an unconfigured GHES. */
  | { forge: "unsupported"; host: string }

/**
 * Normalise git's scp-like syntax (`git@host:owner/repo`) into something
 * `URL` can parse.
 *
 * The negative lookahead matters: `ssh://host/path` also contains a colon and
 * must not be rewritten into `ssh://ssh:/…`.
 */
function normalize(url: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url
  return url.replace(/^([^@/]+@)?([^/:]+):(?!\/)(.+)$/, "ssh://$1$2/$3")
}

export function parseForgeRemote(
  raw: string,
  /**
   * Enterprise deployments the user has an account on (ADR-0176).
   *
   * A GHES host is "github" only once someone has configured it. Matching
   * `github.acme.com` on its shape alone would send the user's github.com
   * token to whatever server answered, which is why the list is the gate
   * rather than a pattern. `lib/stack/forge/github.ts` still probes for the
   * stacks endpoint, so a deployment that does not have one falls back on its
   * own without needing to be named here.
   */
  configuredHosts: readonly GithubHost[] = []
): ForgeRemote | null {
  const cleaned = raw.trim().replace(/\.git\/?$/i, "")
  if (!cleaned) return null

  let parsed: URL
  try {
    parsed = new URL(normalize(cleaned))
  } catch {
    return null
  }
  const host = parsed.hostname.toLowerCase()
  // No host means a local path — `file:///srv/repo`, or a plain directory that
  // never became a URL at all. Nothing to publish to.
  if (!host) return null

  const segments = parsed.pathname.split("/").filter(Boolean)
  if (segments.length < 2) return { forge: "unsupported", host }
  const fullName = `${segments[segments.length - 2]}/${segments[segments.length - 1]}`

  // Deliberately exact for the public host. Treating `github.acme.com` as
  // github.com on its shape alone would send the user's token to the wrong
  // place, so an enterprise deployment counts only once it is configured.
  if (host === "github.com" || host === "www.github.com") {
    return { forge: "github", fullName, host: GITHUB_DOT_COM }
  }
  const configured = configuredHosts.find((candidate) => candidate.id === host)
  if (configured) return { forge: "github", fullName, host: configured }
  return { forge: "unsupported", host }
}
