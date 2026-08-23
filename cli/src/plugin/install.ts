/**
 * Node-side GitHub plugin installer for the CLI. The desktop installs via the
 * Rust `plugin_install_from_github` command; the standalone CLI has no Tauri,
 * so this fetches the plugin's directory tree over the public GitHub contents
 * API (reusing `github-source.ts`) and writes it under `~/.cognia/plugins/<id>/`.
 *
 * Frontend-only — non-frontend manifests are rejected (they need the Tauri host).
 */
import nodeFs from "node:fs/promises"
import path from "node:path"

import {
  parseGithubPluginRef,
  fetchGithubPluginPreview,
  type GithubPluginRef,
} from "@/lib/plugin/package/github-source"
import type { PluginManifest } from "@/types/plugin"

import { createRuntimeHasher } from "../runtime/crypto-hasher"

const GITHUB_API = "https://api.github.com"

export interface InstallFs {
  mkdir: (p: string, opts?: { recursive?: boolean }) => Promise<unknown>
  writeFile: (p: string, data: string | Uint8Array) => Promise<void>
}

export interface InstallDeps {
  home: string
  fs?: InstallFs
}

export interface InstallResult {
  id: string
  dir: string
  manifest: PluginManifest
  /** SHA-256 of the installed bundle (rel-path-sorted contents), lowercase hex. */
  fingerprint: string
}

const defaultFs: InstallFs = {
  mkdir: (p, o) => nodeFs.mkdir(p, o),
  writeFile: (p, d) => nodeFs.writeFile(p, d),
}

interface ContentNode {
  type?: string
  path?: string
  content?: string
}

function refQuery(ref?: string): string {
  return ref ? `?ref=${encodeURIComponent(ref)}` : ""
}

async function ghJson(ref: GithubPluginRef, repoPath: string): Promise<unknown> {
  const url = `${GITHUB_API}/repos/${ref.owner}/${ref.repo}/contents/${repoPath}${refQuery(ref.ref)}`
  const res = await fetch(url, { headers: { Accept: "application/vnd.github+json" } })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${repoPath || "/"}`)
  return res.json()
}

/** Recursively collect files (relative to `base`) under a repo directory. */
async function walk(
  ref: GithubPluginRef,
  dir: string,
  base: string,
  out: Array<{ rel: string; repoPath: string }>
): Promise<void> {
  const listing = await ghJson(ref, dir)
  if (!Array.isArray(listing)) return
  for (const node of listing as ContentNode[]) {
    if (!node.path) continue
    if (node.type === "file") {
      const rel = base ? node.path.slice(base.length).replace(/^\/+/, "") : node.path
      out.push({ rel, repoPath: node.path })
    } else if (node.type === "dir") {
      await walk(ref, node.path, base, out)
    }
  }
}

async function fetchFileContent(ref: GithubPluginRef, repoPath: string): Promise<Uint8Array> {
  const json = (await ghJson(ref, repoPath)) as ContentNode | null
  if (!json || json.type !== "file" || typeof json.content !== "string") {
    throw new Error(`not a file: ${repoPath}`)
  }
  return Buffer.from(json.content.replace(/\s/g, ""), "base64")
}

/**
 * Install a plugin from a GitHub reference (`owner/repo[@ref][/subdir]`) into
 * `~/.cognia/plugins/<id>/`. Returns the installed id, dir, and manifest.
 */
export async function installFromGithubRef(
  repoRef: string,
  deps: InstallDeps
): Promise<InstallResult> {
  const fs = deps.fs ?? defaultFs
  const parsed = parseGithubPluginRef(repoRef)

  // Resolve manifest + the dir it actually lives in (handles monorepo probing).
  const preview = await fetchGithubPluginPreview(parsed)
  const manifest = preview.manifest
  if (manifest.type !== "frontend") {
    throw new Error(
      `Plugin "${manifest.id}" type "${manifest.type}" is unsupported in CLI (needs the desktop host).`
    )
  }
  const baseDir = preview.ref.subdir ?? ""

  const files: Array<{ rel: string; repoPath: string }> = []
  await walk(preview.ref, baseDir, baseDir, files)

  const destRoot = path.join(deps.home, ".cognia", "plugins", manifest.id)
  await fs.mkdir(destRoot, { recursive: true })
  const installed = new Map<string, string | Uint8Array>()
  for (const file of files) {
    const content = await fetchFileContent(preview.ref, file.repoPath)
    installed.set(file.rel, content)
    const destPath = path.join(destRoot, file.rel)
    await fs.mkdir(path.dirname(destPath), { recursive: true })
    await fs.writeFile(destPath, content)
  }
  for (const [rel, content] of Object.entries(preview.generatedFiles)) {
    const normalized = path.posix.normalize(rel.replaceAll("\\", "/"))
    if (
      normalized !== rel.replaceAll("\\", "/") ||
      normalized.startsWith("../") ||
      path.posix.isAbsolute(normalized)
    ) {
      throw new Error(`generated conversion file escapes the plugin directory: ${rel}`)
    }
    installed.set(normalized, content)
    const destPath = path.join(destRoot, ...normalized.split("/"))
    await fs.mkdir(path.dirname(destPath), { recursive: true })
    await fs.writeFile(destPath, content)
  }
  return {
    id: manifest.id,
    dir: destRoot,
    manifest,
    fingerprint: bundleFingerprint(Array.from(installed, ([rel, content]) => ({ rel, content }))),
  }
}

/**
 * Stable SHA-256 over a bundle's contents — sorts by rel path so the order in
 * which GitHub lists files never changes the hash. Used to detect whether an
 * update actually changed anything ("content changed" vs "already up to date").
 */
export function bundleFingerprint(
  files: Array<{ rel: string; content: string | Uint8Array }>
): string {
  const hash = createRuntimeHasher("sha256")
  for (const f of [...files].sort((a, b) => a.rel.localeCompare(b.rel))) {
    hash.update(f.rel)
    hash.update("\0")
    hash.update(f.content)
    hash.update("\0")
  }
  return hash.digest("hex")
}
