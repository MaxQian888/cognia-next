// GitHub plugin source — parse a repo reference, fetch a build-free preview
// (manifest + README + LICENSE) over the public GitHub API, and expose a
// `MarketplaceClient`-shaped adapter so the existing pre-install chain
// (`runMarketplaceInstall` / `usePluginPreInstall`) drives a GitHub install
// with no special-casing.
//
// The actual disk install is done by the Rust `plugin_install_from_github`
// command (via `getPluginManager().installPluginFromGithub`); this module
// only handles parsing + the read-only preview the UI shows before install.

import type { PluginManifest } from "@/types/plugin"

const GITHUB_API = "https://api.github.com"

/** A parsed GitHub plugin reference. Mirrors the Rust-side parser. */
export interface GithubPluginRef {
  owner: string
  repo: string
  /** Branch / tag / commit. Undefined → the repo's default branch. */
  ref?: string
  /** Repo-relative directory holding `plugin.json` (monorepo layouts). */
  subdir?: string
}

export interface GithubPluginPreview {
  manifest: PluginManifest
  /** Raw README markdown, or null when the repo ships none. */
  readme: string | null
  /** Raw LICENSE text, or null when the repo ships none. */
  license: string | null
  /** The reference with `subdir` resolved to where `plugin.json` was found. */
  ref: GithubPluginRef
}

const README_CANDIDATES = [
  "README.md",
  "readme.md",
  "README",
  "readme",
  "README.txt",
  "README.markdown",
]
const LICENSE_CANDIDATES = [
  "LICENSE",
  "LICENSE.md",
  "LICENSE.txt",
  "license",
  "license.md",
  "LICENCE",
  "COPYING",
]

/**
 * Parse a GitHub plugin reference. Accepts the same forms as the Rust parser:
 *   - `owner/repo`
 *   - `owner/repo@ref`
 *   - `owner/repo/sub/dir`
 *   - `owner/repo@ref/sub/dir`
 *   - `https://github.com/owner/repo`
 *   - `https://github.com/owner/repo/tree/<ref>/<sub...>`
 * Throws on input that doesn't contain at least `owner/repo`.
 */
export function parseGithubPluginRef(input: string): GithubPluginRef {
  let s = input.trim()
  if (!s) throw new Error("empty repository reference")

  for (const prefix of ["https://", "http://", "git@"]) {
    if (s.startsWith(prefix)) {
      s = s.slice(prefix.length)
      break
    }
  }
  for (const host of ["github.com/", "www.github.com/", "github.com:"]) {
    if (s.startsWith(host)) {
      s = s.slice(host.length)
      break
    }
  }

  const segs = s.split("/").filter(Boolean)
  if (segs.length < 2) {
    throw new Error(`expected 'owner/repo', got '${input}'`)
  }

  const owner = segs[0]
  let repoToken = segs[1]
  let ref: string | undefined
  const atIndex = repoToken.indexOf("@")
  if (atIndex !== -1) {
    const rf = repoToken.slice(atIndex + 1).trim()
    repoToken = repoToken.slice(0, atIndex)
    if (rf) ref = rf
  }
  const repo = repoToken.replace(/\.git$/, "")
  if (!owner || !repo) {
    throw new Error(`expected 'owner/repo', got '${input}'`)
  }

  let subdir: string | undefined
  const rest = segs.slice(2)
  if (rest.length > 0) {
    if ((rest[0] === "tree" || rest[0] === "blob") && rest.length >= 2) {
      ref = rest[1]
      if (rest.length > 2) subdir = rest.slice(2).join("/")
    } else {
      subdir = rest.join("/")
    }
  }

  return { owner, repo, ref, subdir }
}

function refQuery(ref?: string): string {
  return ref ? `?ref=${encodeURIComponent(ref)}` : ""
}

function decodeBase64Utf8(b64: string): string {
  const clean = b64.replace(/\s/g, "")
  const binary = atob(clean)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder("utf-8").decode(bytes)
}

/**
 * Fetch one repo file via the GitHub contents API. Returns its UTF-8 text,
 * or null when the file is absent (404) or the path isn't a file. Exported so
 * the marketplace-catalog fetcher can reuse the same default-branch handling.
 */
export async function fetchGithubFile(ref: GithubPluginRef, path: string): Promise<string | null> {
  const url = `${GITHUB_API}/repos/${ref.owner}/${ref.repo}/contents/${path}${refQuery(ref.ref)}`
  const res = await fetch(url, { headers: { Accept: "application/vnd.github+json" } })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${path}`)
  const json = (await res.json()) as
    | { type?: string; content?: string; encoding?: string }
    | unknown[]
  if (Array.isArray(json) || json.type !== "file" || typeof json.content !== "string") {
    return null
  }
  return decodeBase64Utf8(json.content)
}

/** List the immediate sub-directory paths of `path` (default: repo root). */
async function listRepoDirs(ref: GithubPluginRef, path = ""): Promise<string[]> {
  const url = `${GITHUB_API}/repos/${ref.owner}/${ref.repo}/contents/${path}${refQuery(ref.ref)}`
  const res = await fetch(url, { headers: { Accept: "application/vnd.github+json" } })
  if (!res.ok) return []
  const json = (await res.json()) as unknown
  if (!Array.isArray(json)) return []
  return (json as Array<{ type?: string; path?: string }>)
    .filter((e) => e.type === "dir" && typeof e.path === "string")
    .map((e) => e.path as string)
}

/** First matching file (by exact name candidates) under `dir`, else null. */
async function firstRepoFile(
  ref: GithubPluginRef,
  dir: string,
  names: string[]
): Promise<string | null> {
  for (const name of names) {
    const path = dir ? `${dir}/${name}` : name
    const text = await fetchGithubFile(ref, path)
    if (text !== null) return text
  }
  return null
}

/**
 * Fetch a build-free install preview: the manifest plus README / LICENSE
 * text. When `subdir` is omitted and the repo root has no `plugin.json`, one
 * level of sub-directories is probed (monorepo layouts), mirroring the Rust
 * installer's manifest discovery.
 */
export async function fetchGithubPluginPreview(ref: GithubPluginRef): Promise<GithubPluginPreview> {
  const dir = ref.subdir?.replace(/\/+$/, "") ?? ""
  const manifestPath = dir ? `${dir}/plugin.json` : "plugin.json"

  let resolvedDir = dir
  let manifestText = await fetchGithubFile(ref, manifestPath)
  if (manifestText === null && !dir) {
    for (const d of await listRepoDirs(ref)) {
      const text = await fetchGithubFile(ref, `${d}/plugin.json`)
      if (text !== null) {
        manifestText = text
        resolvedDir = d
        break
      }
    }
  }
  if (manifestText === null) {
    throw new Error("no plugin.json found in this repository")
  }

  let manifest: PluginManifest
  try {
    manifest = JSON.parse(manifestText) as PluginManifest
  } catch {
    throw new Error("plugin.json is not valid JSON")
  }
  if (!manifest.id || typeof manifest.id !== "string") {
    throw new Error("plugin.json is missing a string `id`")
  }

  const readme = await firstRepoFile(ref, resolvedDir, README_CANDIDATES)
  const license = await firstRepoFile(ref, resolvedDir, LICENSE_CANDIDATES)

  return {
    manifest,
    readme,
    license,
    ref: { ...ref, subdir: resolvedDir || undefined },
  }
}

/**
 * The minimal `MarketplaceClient` shape the pre-install chain consumes
 * (`{ getPlugin, installPlugin }`). `getPlugin` returns the already-fetched
 * preview manifest (the chain only needs it for permission / config / binary
 * gating); `installPlugin` delegates to the manager's GitHub install path,
 * which does the authoritative download + validation + disk write.
 */
export interface GithubMarketplaceClient {
  getPlugin: (id: string) => Promise<{ manifest: PluginManifest; name?: string } | null>
  installPlugin: (id: string, version?: string) => Promise<unknown>
}

export function makeGithubMarketplaceClient(
  ref: GithubPluginRef,
  preview: GithubPluginPreview
): GithubMarketplaceClient {
  return {
    getPlugin: async () => ({ manifest: preview.manifest, name: preview.manifest.name }),
    installPlugin: async () => {
      const { getPluginManager } = await import("@/lib/plugin/core/manager")
      return getPluginManager().installPluginFromGithub(
        `${ref.owner}/${ref.repo}`,
        ref.ref,
        ref.subdir
      )
    },
  }
}
