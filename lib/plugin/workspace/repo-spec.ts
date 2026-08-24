/**
 * Normalizes the several ways a repository gets named into one shape.
 *
 * `owner/repo`, an https URL, an `git@host:owner/repo.git` remote and a local
 * path all mean "this repository" to a user, and nothing in the app turned them
 * into a single thing: `cloneToWorkspace` accepted only `owner/repo` and
 * hard-coded github.com, while `git_clone` accepted a URL and validated
 * nothing. A consumer that wants to accept what a person would type had to
 * invent this, so it lives here once.
 *
 * Parsing only — no filesystem, no network. The host's clone guard
 * (`validate_clone_url` in `crates/cognia-git/src/repo.rs`) is what actually
 * decides whether a remote may be fetched; this decides what the user meant.
 */

/** A repository that must be fetched. */
export interface RemoteRepoSpec {
  kind: "remote"
  host: string
  owner: string
  repo: string
  /** Canonical https URL — the only form the clone guard accepts. */
  url: string
  /** Branch/tag/SHA the caller asked for, when they named one. */
  ref?: string
}

/** A repository already on disk. */
export interface LocalRepoSpec {
  kind: "local"
  path: string
}

export type RepoSpec = RemoteRepoSpec | LocalRepoSpec

export class RepoSpecError extends Error {
  constructor(
    readonly input: string,
    reason: string
  ) {
    super(`cannot read "${input}" as a repository: ${reason}`)
    this.name = "RepoSpecError"
  }
}

/** Host assumed when the input is a bare `owner/repo`. */
export const DEFAULT_REPO_HOST = "github.com"

const SEGMENT = /^[A-Za-z0-9._-]+$/
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/

function isLocalPath(input: string): boolean {
  return (
    input.startsWith("/") ||
    input.startsWith("./") ||
    input.startsWith("../") ||
    input.startsWith("~") ||
    input === "." ||
    input === ".." ||
    WINDOWS_ABSOLUTE.test(input)
  )
}

function stripGitSuffix(repo: string): string {
  return repo.endsWith(".git") ? repo.slice(0, -".git".length) : repo
}

function validateSegments(input: string, host: string, owner: string, repo: string): void {
  for (const [label, value] of [
    ["host", host],
    ["owner", owner],
    ["repo", repo],
  ] as const) {
    if (!value) throw new RepoSpecError(input, `missing ${label}`)
    if (!SEGMENT.test(value)) throw new RepoSpecError(input, `${label} has unsupported characters`)
    if (value === "." || value === "..") throw new RepoSpecError(input, `${label} is not a name`)
  }
}

function remote(
  input: string,
  host: string,
  owner: string,
  repo: string,
  ref?: string
): RemoteRepoSpec {
  const cleanRepo = stripGitSuffix(repo)
  const cleanHost = host.toLowerCase()
  validateSegments(input, cleanHost, owner, cleanRepo)
  return {
    kind: "remote",
    host: cleanHost,
    owner,
    repo: cleanRepo,
    url: `https://${cleanHost}/${owner}/${cleanRepo}.git`,
    ...(ref ? { ref } : {}),
  }
}

/**
 * Read one user-supplied repository reference.
 *
 * Accepts: an absolute or `./`-relative local path; `owner/repo`;
 * `host/owner/repo`; `https://host/owner/repo[.git]`; `git@host:owner/repo.git`;
 * `ssh://git@host/owner/repo.git`. A `#ref` suffix on any remote form pins a
 * branch, tag or SHA.
 *
 * Rejects rather than guesses. `http://` in particular is refused outright
 * instead of being upgraded: silently rewriting a scheme the user typed hides
 * that their remote was never reachable over TLS.
 */
export function parseRepoSpec(raw: string): RepoSpec {
  const input = (raw ?? "").trim()
  if (!input) throw new RepoSpecError(raw ?? "", "empty")
  if (input.startsWith("-")) throw new RepoSpecError(input, "may not begin with '-'")

  if (isLocalPath(input)) {
    return { kind: "local", path: input }
  }

  const [body, hashRef] = input.split("#", 2)
  const ref = hashRef?.trim() || undefined

  if (body.startsWith("http://")) {
    throw new RepoSpecError(input, "only https:// remotes are accepted")
  }

  if (body.startsWith("https://")) {
    let url: URL
    try {
      url = new URL(body)
    } catch {
      throw new RepoSpecError(input, "not a valid URL")
    }
    if (url.username || url.password) {
      throw new RepoSpecError(input, "may not embed credentials")
    }
    const parts = url.pathname.split("/").filter(Boolean)
    if (parts.length < 2) throw new RepoSpecError(input, "expected <owner>/<repo> in the path")
    return remote(input, url.hostname, parts[0], parts.slice(1).join("/").replace(/\//g, "-"), ref)
  }

  // scp-style: git@host:owner/repo.git
  const scp = /^(?:([A-Za-z0-9._-]+)@)?([A-Za-z0-9._-]+):(.+)$/.exec(body)
  if (scp && !body.startsWith("ssh://") && scp[3] && !/^\d+\//.test(scp[3])) {
    const parts = scp[3].split("/").filter(Boolean)
    if (parts.length < 2) throw new RepoSpecError(input, "expected <owner>/<repo> after the host")
    return remote(input, scp[2], parts[0], parts.slice(1).join("-"), ref)
  }

  if (body.startsWith("ssh://")) {
    const withoutScheme = body.slice("ssh://".length)
    const at = withoutScheme.indexOf("@")
    const authorityAndPath = at >= 0 ? withoutScheme.slice(at + 1) : withoutScheme
    const slash = authorityAndPath.indexOf("/")
    if (slash < 0) throw new RepoSpecError(input, "expected <owner>/<repo> after the host")
    const host = authorityAndPath.slice(0, slash).split(":")[0]
    const parts = authorityAndPath
      .slice(slash + 1)
      .split("/")
      .filter(Boolean)
    if (parts.length < 2) throw new RepoSpecError(input, "expected <owner>/<repo> after the host")
    return remote(input, host, parts[0], parts.slice(1).join("-"), ref)
  }

  const parts = body.split("/").filter(Boolean)
  if (parts.length === 2) {
    return remote(input, DEFAULT_REPO_HOST, parts[0], parts[1], ref)
  }
  if (parts.length === 3) {
    return remote(input, parts[0], parts[1], parts[2], ref)
  }
  throw new RepoSpecError(
    input,
    "expected a path, <owner>/<repo>, <host>/<owner>/<repo>, or a git URL"
  )
}

/** Path segments a remote's checkout is cached under, host-first. */
export function repoCacheSegments(spec: RemoteRepoSpec): string[] {
  return [spec.host, spec.owner, spec.repo]
}
