/**
 * Package-spec parsing and identity, ported from Pi 0.84.1's own
 * `getPackageIdentity` / `parseNpmSpec`.
 *
 * Identity is what decides whether a project entry *replaces* a user entry or
 * sits alongside it, so getting it wrong would either hide an installed
 * package or show it twice. Pi's rules:
 *
 *   - `npm:<name>` — the version is stripped, so `npm:pkg@1.0.0` and
 *     `npm:pkg@2.0.0` are the same package at different pins.
 *   - `git:<host>/<path>` — SSH and HTTPS forms collapse onto one identity,
 *     which is why the host and path are extracted rather than the URL kept.
 *   - `local:<resolved path>` — resolved against the *scope's* base dir
 *     (`<cwd>/.pi` for project, the agent dir for user), so the same relative
 *     path in two scopes is genuinely two different packages.
 *
 * Pure: no filesystem, no process. The caller supplies the base dir.
 */

import type { ParsedPiSource } from "./types"

/** Pi's own npm spec regex, verbatim. */
const NPM_SPEC = /^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/

/** `git@host:owner/repo` (scp-like syntax, no scheme). */
const SCP_LIKE = /^(?:([^@]+)@)?([^:/]+):(.+)$/

/**
 * Split a trailing `@ref` off a git path and drop a `.git` suffix, leaving
 * `owner/repo`.
 *
 * Order matters: `user/repo.git@v1` only ends in `.git` *after* the ref has
 * been removed, so stripping first would leave `user/repo.git` and give the
 * same repo two identities depending on whether it was pinned.
 */
function gitPathParts(path: string): { path: string; version?: string } {
  const at = path.lastIndexOf("@")
  // A leading `@` belongs to a scope, not a ref.
  const version = at > 0 ? path.slice(at + 1) : undefined
  const withoutRef = at > 0 ? path.slice(0, at) : path
  return { path: withoutRef.replace(/\.git$/i, ""), version }
}

function parseGitLocator(locator: string): { host?: string; path?: string; version?: string } {
  const trimmed = locator.trim()

  // ssh://git@github.com/user/repo, https://github.com/user/repo
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed)
      const { path, version } = gitPathParts(url.pathname.replace(/^\//, ""))
      return { host: url.hostname.toLowerCase(), path, version }
    } catch {
      return {}
    }
  }

  // git@github.com:user/repo
  const scp = SCP_LIKE.exec(trimmed)
  if (scp) {
    const { path, version } = gitPathParts(scp[3])
    return { host: scp[2].toLowerCase(), path, version }
  }

  // github.com/user/repo
  const slash = trimmed.indexOf("/")
  if (slash > 0) {
    const { path, version } = gitPathParts(trimmed.slice(slash + 1))
    return { host: trimmed.slice(0, slash).toLowerCase(), path, version }
  }

  return {}
}

/** Parse a Pi package spec into its kind and parts. Never throws. */
export function parsePiSource(source: string): ParsedPiSource {
  const raw = source
  const trimmed = source.trim()

  if (trimmed.startsWith("npm:")) {
    const spec = trimmed.slice(4)
    const match = NPM_SPEC.exec(spec)
    if (!match) return { raw, kind: "npm", name: spec }
    return { raw, kind: "npm", name: match[1], version: match[2] }
  }

  if (trimmed.startsWith("git:")) {
    const { host, path, version } = parseGitLocator(trimmed.slice(4))
    return { raw, kind: "git", host, path, version }
  }

  // Bare URLs are git sources too — Pi accepts
  // `https://github.com/user/repo` and `ssh://git@github.com/user/repo`.
  if (/^(https?|ssh|git):\/\//i.test(trimmed)) {
    const { host, path, version } = parseGitLocator(trimmed)
    return { raw, kind: "git", host, path, version }
  }

  return { raw, kind: "local", path: trimmed }
}

/**
 * Pi's identity string for a spec.
 *
 * `baseDir` is only consulted for local paths; pass the scope's base dir
 * (`<cwd>/.pi` or the Pi agent dir). Omitting it leaves a relative local path
 * unresolved, which is fine for display but must not be used for dedupe.
 */
export function piPackageIdentity(source: string, baseDir?: string): string {
  const parsed = parsePiSource(source)

  if (parsed.kind === "npm") return `npm:${parsed.name ?? parsed.raw}`
  if (parsed.kind === "git") {
    // A locator we could not split is still deterministic on its raw form —
    // better a stable private identity than collapsing two repos into one.
    if (!parsed.host || !parsed.path) return `git:${parsed.raw.trim()}`
    return `git:${parsed.host}/${parsed.path}`
  }

  const path = parsed.path ?? parsed.raw
  return `local:${resolveLocalPath(path, baseDir)}`
}

/** Join a relative local path onto its scope base, normalizing `.`/`..`. */
function resolveLocalPath(path: string, baseDir?: string): string {
  const isAbsolute = path.startsWith("/") || /^[a-z]:[\\/]/i.test(path)
  const joined = isAbsolute || !baseDir ? path : `${baseDir.replace(/[\\/]+$/, "")}/${path}`
  return normalizeSegments(joined.replace(/\\/g, "/"))
}

function normalizeSegments(path: string): string {
  const leadingSlash = path.startsWith("/")
  const out: string[] = []
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue
    if (segment === ".." && out.length > 0 && out[out.length - 1] !== "..") {
      out.pop()
      continue
    }
    out.push(segment)
  }
  const joined = out.join("/")
  return leadingSlash ? `/${joined}` : joined
}

/** Human-facing short name — the npm name, the git repo, or the basename. */
export function piPackageDisplayName(source: string): string {
  const parsed = parsePiSource(source)
  if (parsed.kind === "npm") return parsed.name ?? parsed.raw
  if (parsed.kind === "git") return parsed.path?.split("/").pop() ?? parsed.raw
  return (
    parsed.path
      ?.replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() || parsed.raw
  )
}

/** The pinned version/ref, when the spec carries one. */
export function piPackageVersion(source: string): string | undefined {
  return parsePiSource(source).version
}
