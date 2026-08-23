// GitHub plugin source — parse a repo reference, fetch a build-free preview
// (manifest + README + LICENSE) over the public GitHub API, and expose a
// `MarketplaceClient`-shaped adapter so the existing pre-install chain
// (`runMarketplaceInstall` / `usePluginPreInstall`) drives a GitHub install
// with no special-casing.
//
// The actual disk install is done by the Rust `plugin_install_from_github`
// command (via `getPluginManager().installPluginFromGithub`); this module
// only handles parsing + the read-only preview the UI shows before install.
//
// Every call uses `proxyFetch`: `api.github.com` is not on the packaged
// shell's `connect-src` allowlist, so a renderer `fetch` never leaves the
// WebView — and a user behind a corporate proxy reaches GitHub only through
// it.

import type { PluginManifest } from "@/types/plugin"
import { proxyFetch } from "@/lib/network/proxy-fetch"
import {
  convertPluginBundle,
  type PluginConversionReport,
  type PluginEcosystem,
} from "@/lib/plugin/convert/ecosystem"

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
  /** Source ecosystem detected before conversion. */
  sourceFormat: PluginEcosystem
  /** Explicit fidelity/loss report produced by the shared converter. */
  conversionReport: PluginConversionReport
  /** Files the installer must overlay after extracting the source tree. */
  generatedFiles: Record<string, string>
  /** Raw README markdown, or null when the repo ships none. */
  readme: string | null
  /** Raw LICENSE text, or null when the repo ships none. */
  license: string | null
  /** The reference with `subdir` resolved to where `plugin.json` was found. */
  ref: GithubPluginRef
}

const PLUGIN_MARKERS: Array<{ format: PluginEcosystem; path: string }> = [
  { format: "cognia", path: "plugin.json" },
  { format: "claude-code", path: ".claude-plugin/plugin.json" },
  { format: "codex", path: ".codex-plugin/plugin.json" },
  { format: "gemini-cli", path: "gemini-extension.json" },
]
const TEXT_FILE_PATTERN =
  /\.(?:md|markdown|txt|json|jsonc|toml|ya?ml|js|mjs|cjs|ts|tsx|jsx|sh|bash|zsh|py|rs|css|html)$/i
const MAX_SNAPSHOT_ENTRIES = 2_000
const MAX_TEXT_FILE_BYTES = 1_000_000

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

/**
 * Browser URL for a parsed reference — what "Open on GitHub" navigates to.
 * A pinned `ref` becomes a `/tree/<ref>` path (plus the subdir when present),
 * which is the form GitHub itself produces, so the round trip
 * `parseGithubPluginRef(githubRepoUrl(r))` yields `r` back.
 */
export function githubRepoUrl(ref: GithubPluginRef): string {
  const base = `https://github.com/${ref.owner}/${ref.repo}`
  if (!ref.ref) return ref.subdir ? `${base}/tree/HEAD/${ref.subdir}` : base
  const tree = `${base}/tree/${ref.ref}`
  return ref.subdir ? `${tree}/${ref.subdir}` : tree
}

function refQuery(ref?: string): string {
  return ref ? `?ref=${encodeURIComponent(ref)}` : ""
}

async function resolveGithubCommit(ref: GithubPluginRef): Promise<GithubPluginRef> {
  const requested = ref.ref ?? "HEAD"
  const url = `${GITHUB_API}/repos/${ref.owner}/${ref.repo}/commits/${encodeURIComponent(requested)}`
  const res = await proxyFetch(url, { headers: { Accept: "application/vnd.github+json" } })
  if (!res.ok) throw new Error(`GitHub API ${res.status} while resolving ${requested}`)
  const json = (await res.json()) as { sha?: unknown }
  if (typeof json.sha !== "string" || !/^[0-9a-f]{40}$/i.test(json.sha)) {
    throw new Error(`GitHub returned an invalid commit for ${requested}`)
  }
  return { ...ref, ref: json.sha }
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
  const res = await proxyFetch(url, { headers: { Accept: "application/vnd.github+json" } })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${path}`)
  const json = (await res.json()) as
    { type?: string; content?: string; encoding?: string } | unknown[]
  if (Array.isArray(json) || json.type !== "file" || typeof json.content !== "string") {
    return null
  }
  return decodeBase64Utf8(json.content)
}

/** List the immediate sub-directory paths of `path` (default: repo root). */
async function listRepoDirs(ref: GithubPluginRef, path = ""): Promise<string[]> {
  const url = `${GITHUB_API}/repos/${ref.owner}/${ref.repo}/contents/${path}${refQuery(ref.ref)}`
  const res = await proxyFetch(url, { headers: { Accept: "application/vnd.github+json" } })
  if (!res.ok) return []
  const json = (await res.json()) as unknown
  if (!Array.isArray(json)) return []
  return (json as Array<{ type?: string; path?: string }>)
    .filter((e) => e.type === "dir" && typeof e.path === "string")
    .map((e) => e.path as string)
}

interface GithubRepoEntry {
  type?: string
  path?: string
  size?: number
}

async function listRepoEntries(ref: GithubPluginRef, path = ""): Promise<GithubRepoEntry[]> {
  const url = `${GITHUB_API}/repos/${ref.owner}/${ref.repo}/contents/${path}${refQuery(ref.ref)}`
  const res = await proxyFetch(url, { headers: { Accept: "application/vnd.github+json" } })
  if (!res.ok) return []
  const json = (await res.json()) as unknown
  return Array.isArray(json) ? (json as GithubRepoEntry[]) : []
}

async function collectRepoEntries(ref: GithubPluginRef, root: string): Promise<GithubRepoEntry[]> {
  const queue = [root]
  const entries: GithubRepoEntry[] = []
  while (queue.length > 0) {
    const directory = queue.shift() ?? ""
    for (const entry of await listRepoEntries(ref, directory)) {
      if (typeof entry.path !== "string") continue
      entries.push(entry)
      if (entries.length > MAX_SNAPSHOT_ENTRIES) {
        throw new Error(
          `plugin source contains more than ${MAX_SNAPSHOT_ENTRIES} entries; choose a narrower subdir`
        )
      }
      if (entry.type === "dir") queue.push(entry.path)
    }
  }
  return entries
}

function joinRepoPath(dir: string, path: string): string {
  return dir ? `${dir}/${path}` : path
}

async function findManifestMarker(
  ref: GithubPluginRef
): Promise<{ root: string; marker: (typeof PLUGIN_MARKERS)[number]; text: string }> {
  const requestedRoot = ref.subdir?.replace(/^\/+|\/+$/g, "") ?? ""
  const probeRoot = async (root: string) => {
    for (const marker of PLUGIN_MARKERS) {
      const text = await fetchGithubFile(ref, joinRepoPath(root, marker.path))
      if (text !== null) return { root, marker, text }
    }
    return null
  }

  const direct = await probeRoot(requestedRoot)
  if (direct) return direct
  if (requestedRoot) {
    throw new Error(`no supported plugin manifest found under ${requestedRoot}`)
  }

  // Preserve the one-directory monorepo fast path, but inspect every
  // immediate directory before choosing so sibling plugins are never picked
  // by API response order.
  const immediate: Array<{
    root: string
    marker: (typeof PLUGIN_MARKERS)[number]
    text: string
  }> = []
  for (const directory of await listRepoDirs(ref)) {
    const found = await probeRoot(directory)
    if (found) immediate.push(found)
  }
  if (immediate.length > 1) {
    throw new Error(
      `multiple plugin roots found (${immediate.map((candidate) => candidate.root).join(", ")}); specify the plugin subdir`
    )
  }
  if (immediate.length === 1) return immediate[0]

  // Fall back to a full tree walk for deeper monorepos. Multiple plugin roots
  // are ambiguous and require an explicit subdir instead of an arbitrary pick.
  const entries = await collectRepoEntries(ref, "")
  const candidates = new Map<string, { root: string; marker: (typeof PLUGIN_MARKERS)[number] }>()
  for (const entry of entries) {
    if (entry.type !== "file" || typeof entry.path !== "string") continue
    for (const marker of PLUGIN_MARKERS) {
      if (entry.path === marker.path || entry.path.endsWith(`/${marker.path}`)) {
        const root = entry.path.slice(0, entry.path.length - marker.path.length).replace(/\/$/, "")
        candidates.set(`${root}\0${marker.format}`, { root, marker })
      }
    }
  }
  if (candidates.size === 0) {
    throw new Error(
      "no supported plugin manifest found (plugin.json, .claude-plugin/plugin.json, " +
        ".codex-plugin/plugin.json, or gemini-extension.json)"
    )
  }
  const roots = new Set(Array.from(candidates.values(), (candidate) => candidate.root))
  if (roots.size > 1) {
    throw new Error(
      `multiple plugin roots found (${Array.from(roots).join(", ")}); specify the plugin subdir`
    )
  }
  const root = Array.from(roots)[0]
  const candidate = PLUGIN_MARKERS.map((marker) =>
    candidates.get(`${root}\0${marker.format}`)
  ).find((value) => value !== undefined)
  if (!candidate) throw new Error("plugin manifest candidate could not be resolved")
  const text = await fetchGithubFile(ref, joinRepoPath(candidate.root, candidate.marker.path))
  if (text === null) throw new Error("plugin manifest disappeared while fetching the preview")
  return { ...candidate, text }
}

async function fetchPluginSnapshot(
  ref: GithubPluginRef,
  root: string,
  markerPath: string,
  markerText: string
): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>([[markerPath, markerText]])
  const entries = await collectRepoEntries(ref, root)
  for (const entry of entries) {
    if (entry.type !== "file" || typeof entry.path !== "string") continue
    const relative = root ? entry.path.slice(root.length + 1) : entry.path
    if (!relative || relative === markerPath) continue
    if (!TEXT_FILE_PATTERN.test(relative)) {
      // Keep the path so resource-bearing skills stay bundles. The installer
      // retains the original binary from the tarball; it is never overlaid.
      snapshot.set(relative, "")
      continue
    }
    if (typeof entry.size === "number" && entry.size > MAX_TEXT_FILE_BYTES) {
      throw new Error(`plugin text file is too large to convert safely: ${relative}`)
    }
    const text = await fetchGithubFile(ref, entry.path)
    if (text !== null) snapshot.set(relative, text)
  }
  return snapshot
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
  // Pin every preview request and the later installer handoff to one commit.
  // Otherwise a mutable branch could change after the user approves the
  // generated manifest but before the Rust installer downloads the archive.
  const pinnedRef = await resolveGithubCommit(ref)
  const found = await findManifestMarker(pinnedRef)
  const snapshot = await fetchPluginSnapshot(pinnedRef, found.root, found.marker.path, found.text)
  let converted
  try {
    converted = convertPluginBundle(snapshot, "cognia")
  } catch (error) {
    if (found.marker.format === "cognia" && error instanceof SyntaxError) {
      throw new Error("plugin.json is not valid JSON")
    }
    throw error
  }
  const generatedFiles: Record<string, string> = {}
  for (const [path, contents] of converted.files) {
    if (snapshot.get(path) !== contents) generatedFiles[path] = contents
  }

  const readme = await firstRepoFile(pinnedRef, found.root, README_CANDIDATES)
  const license = await firstRepoFile(pinnedRef, found.root, LICENSE_CANDIDATES)

  return {
    manifest: converted.manifest,
    sourceFormat: converted.source,
    conversionReport: converted.report,
    generatedFiles,
    readme,
    license,
    ref: { ...pinnedRef, subdir: found.root || undefined },
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
        ref.subdir,
        preview.generatedFiles
      )
    },
  }
}
