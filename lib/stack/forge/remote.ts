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

export type ForgeRemote =
  /** GitHub proper. `fullName` is `owner/name`, with no `.git` suffix. */
  | { forge: "github"; fullName: string }
  /** A real host we have no adapter for — GitLab, Gitea, GHES. */
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

export function parseForgeRemote(raw: string): ForgeRemote | null {
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

  // Deliberately exact. GitHub Enterprise Server speaks a compatible API but
  // has no stacks endpoint and its own auth story; treating `github.acme.com`
  // as github.com would send the user's token to the wrong place.
  if (host === "github.com" || host === "www.github.com") {
    return { forge: "github", fullName }
  }
  return { forge: "unsupported", host }
}
