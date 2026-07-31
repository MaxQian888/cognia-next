/**
 * Dev-plugin discovery: load the repo's in-tree `plugins/<id>/plugin.json` as
 * live disk plugins, so a developer running the CLI from source (`cli:dev`, tsx)
 * sees their edited plugin without rebuilding the static `browser-builtin-registry`.
 *
 * Layout mirrors the repo: `<pluginsDir>/<id>/plugin.json` (NOT the `.cognia/
 * plugins` layout `discover-plugins` scans). The resolved entries feed the SAME
 * `registerDiskPlugins` host path the marketplace/disk plugins use, so lifecycle
 * (load / enable / disable / reload) and the plugin-tool round-trip are real.
 *
 * Only `type: "frontend"` plugins are CLI-runnable. Their `main` is dynamically
 * imported by `makeNodeFrontendImporter`; under `cli:dev` (tsx) the `@/` aliases
 * the in-tree plugins use resolve via tsconfig paths — the packaged binary can't
 * resolve them, which is why this is a dev-only opt-in.
 */
import nodeFs from "node:fs"
import nodeFsPromises from "node:fs/promises"
import path from "node:path"

import type { PluginManifest } from "@/types/plugin"
import type { DiskPluginEntry } from "./host"

/** Sync fs surface used by {@link resolveDevPluginsDir} (injected in tests). */
export interface DevPluginsDirFs {
  existsDir(p: string): boolean
  existsFile(p: string): boolean
}

const defaultDirFs: DevPluginsDirFs = {
  existsDir(p) {
    try {
      return nodeFs.statSync(p).isDirectory()
    } catch {
      return false
    }
  },
  existsFile(p) {
    try {
      return nodeFs.statSync(p).isFile()
    } catch {
      return false
    }
  },
}

/**
 * Resolve the directory to scan for dev plugins.
 *   - `explicit` (from `--dev-plugins-dir` / config) wins; resolved against `cwd`.
 *   - else walk up from `cwd` for the nearest ancestor that has BOTH a `plugins/`
 *     directory and a `package.json` (the repo root), returning `<root>/plugins`.
 * Returns `null` when nothing resolves (degrade to builtins-only).
 */
export function resolveDevPluginsDir(
  explicit: string | undefined,
  cwd: string,
  fs: DevPluginsDirFs = defaultDirFs
): string | null {
  if (explicit && explicit.trim()) {
    const dir = path.isAbsolute(explicit) ? explicit : path.resolve(cwd, explicit)
    return fs.existsDir(dir) ? dir : null
  }
  let dir = path.resolve(cwd)
  // Bound the walk by the filesystem root (path.dirname is idempotent at root).
  for (let prev = ""; dir !== prev; prev = dir, dir = path.dirname(dir)) {
    const pluginsDir = path.join(dir, "plugins")
    if (fs.existsDir(pluginsDir) && fs.existsFile(path.join(dir, "package.json"))) {
      return pluginsDir
    }
  }
  return null
}

/** Async fs surface used by {@link discoverDevPlugins} (injected in tests). */
export interface DevPluginsScanFs {
  readDir(p: string): Promise<string[]>
  readText(p: string): Promise<string>
}

const defaultScanFs: DevPluginsScanFs = {
  async readDir(p) {
    try {
      return await nodeFsPromises.readdir(p)
    } catch {
      return []
    }
  },
  readText: (p) => nodeFsPromises.readFile(p, "utf8"),
}

/** Parse a manifest's required identity, returning null when malformed. */
function parseManifest(text: string): PluginManifest | null {
  let m: unknown
  try {
    m = JSON.parse(text)
  } catch {
    return null
  }
  if (!m || typeof m !== "object") return null
  const r = m as Record<string, unknown>
  if (typeof r.id !== "string" || typeof r.name !== "string" || typeof r.type !== "string") {
    return null
  }
  return m as PluginManifest
}

/**
 * Scan `<dir>/<id>/plugin.json` and return registrable disk entries. Ids in
 * `skipIds` (already loaded as compiled-in builtins) are dropped so re-registering
 * them doesn't noisily fail — dev plugins SUPPLEMENT the static builtin set.
 */
export async function discoverDevPlugins(
  dir: string,
  skipIds: Set<string> = new Set(),
  fs: DevPluginsScanFs = defaultScanFs
): Promise<DiskPluginEntry[]> {
  const byId = new Map<string, DiskPluginEntry>()
  for (const entry of await fs.readDir(dir)) {
    const pluginDir = path.join(dir, entry)
    const manifestPath = path.join(pluginDir, "plugin.json")
    let text: string
    try {
      text = await fs.readText(manifestPath)
    } catch {
      continue // no manifest in this subdir
    }
    const manifest = parseManifest(text)
    if (!manifest) continue
    if (skipIds.has(manifest.id) || byId.has(manifest.id)) continue
    byId.set(manifest.id, {
      id: manifest.id,
      dir: pluginDir,
      manifest,
      supported: manifest.type === "frontend",
    })
  }
  return [...byId.values()]
}
