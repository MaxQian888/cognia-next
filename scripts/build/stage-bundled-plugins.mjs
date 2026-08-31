// Stage the curated on-disk plugins into the Tauri resource tree.
//
// Frontend plugins ride inside the JS bundle and are curated by
// `lib/plugin/core/browser-builtin-registry.ts`. Everything else -- Python and
// WASM -- needs a real directory before the Tauri host can run it, and the
// host only ever scans `<appDataDir>/cognia/plugins`. Nothing copied anything
// there, and `plugins/` was not in `bundle.resources`, so RepoWiki (ADR-0146,
// a whole subsystem) did not exist at all in an installed build. This script
// is the missing half: it stages the shipping files under
// `src-tauri/resources/plugins/` for `bundle.resources` to pick up, and the
// renderer seeds them into the plugin directory on first run.
//
// Only what the plugin needs at runtime is copied. A Python plugin's working
// directory also holds `.venv/`, `__pycache__/`, `.pytest_cache/`, `tests/`
// and a lockfile, and putting a machine-local virtualenv inside an installer
// would be both enormous and wrong -- `pythonVenv: "isolated"` means the host
// provisions one per install.
//
// Every staged file is hashed, the same integrity shape
// `browser-builtin-assets.generated.json` already uses, so the seeder can tell
// a truncated copy from a good one.

import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const PLUGINS_ROOT = path.join(ROOT, "plugins")
const DISTRIBUTION_FILE = path.join(PLUGINS_ROOT, "distribution.json")

/** Where `bundle.resources` expects to find the staged tree. */
export const STAGED_PLUGIN_DIR = path.join("src-tauri", "resources", "plugins")
/**
 * The catalog is written into the app tree and imported, not read from disk at
 * runtime. Reading it back out of the resource directory would need an
 * `fs:scope` entry for `$RESOURCE`, and a denied read is indistinguishable
 * from an absent catalog, which is how a seeder goes quietly dormant. Same
 * shape and same reasoning as `browser-builtin-assets.generated.json`, which
 * is likewise generated and committed.
 */
export const CATALOG_FILE = path.join(
  "lib",
  "plugin",
  "distribution",
  "bundled-plugins.generated.json"
)

/**
 * Directory names that never ship, whatever an `include` pattern says. These
 * are development residue rather than deliberate content, and a plugin author
 * adding a new one should not have to remember to exclude it.
 */
const NEVER_STAGE = new Set([
  ".git",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".venv",
  "__pycache__",
  "node_modules",
  "target",
  "tests",
  "venv",
])

export function readDistribution(fsImpl = fs) {
  const raw = JSON.parse(fsImpl.readFileSync(DISTRIBUTION_FILE, "utf8"))
  return { bundled: raw.bundled ?? {}, devOnly: raw.devOnly ?? {} }
}

/**
 * Expand one `include` entry against a plugin directory.
 *
 * Deliberately a small matcher rather than a glob dependency: the patterns are
 * ours, the vocabulary is exactly `dir/**\/*.ext` plus plain relative paths,
 * and a build step that silently matches nothing is worse than one that
 * refuses an unfamiliar pattern.
 */
export function expandInclude(pluginDir, pattern, fsImpl = fs) {
  const recursive = pattern.match(/^(.*)\/\*\*\/\*(\.[A-Za-z0-9]+)?$/u)
  if (!recursive) {
    if (pattern.includes("*")) {
      throw new Error(
        `stage-bundled-plugins: unsupported include pattern "${pattern}". Use a plain path or "<dir>/**/*[.ext]".`
      )
    }
    const absolute = path.join(pluginDir, pattern)
    if (!fsImpl.existsSync(absolute)) return []
    return [pattern]
  }

  const [, subdir, extension] = recursive
  const base = path.join(pluginDir, subdir)
  if (!fsImpl.existsSync(base)) return []

  const found = []
  const walk = (dir, relative) => {
    for (const entry of fsImpl.readdirSync(dir, { withFileTypes: true })) {
      if (NEVER_STAGE.has(entry.name)) continue
      const next = path.join(dir, entry.name)
      const nextRelative = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        walk(next, nextRelative)
        continue
      }
      if (extension && !entry.name.endsWith(extension)) continue
      found.push(`${subdir}/${nextRelative}`)
    }
  }
  walk(base, "")
  return found.sort()
}

/**
 * Copy every bundled plugin's shipping files into `outDir` and return the
 * catalog. Throws when a declared `include` matches nothing, because that is
 * always a rename that would otherwise ship a plugin missing its own code.
 */
export function stageBundledPlugins({ outDir, catalogFile, fsImpl = fs } = {}) {
  const target = outDir ?? path.join(ROOT, STAGED_PLUGIN_DIR)
  const { bundled } = readDistribution(fsImpl)

  fsImpl.rmSync(target, { recursive: true, force: true })
  fsImpl.mkdirSync(target, { recursive: true })

  const catalog = { entries: {} }
  for (const [dir, entry] of Object.entries(bundled)) {
    const source = path.join(PLUGINS_ROOT, dir)
    const manifestPath = path.join(source, "plugin.json")
    if (!fsImpl.existsSync(manifestPath)) {
      throw new Error(
        `stage-bundled-plugins: plugins/${dir} is listed as bundled but has no plugin.json.`
      )
    }
    const manifest = JSON.parse(fsImpl.readFileSync(manifestPath, "utf8"))
    if (manifest.id !== entry.id) {
      throw new Error(
        `stage-bundled-plugins: plugins/${dir} declares id "${manifest.id}" but distribution.json says "${entry.id}".`
      )
    }

    const files = []
    for (const pattern of entry.include ?? []) {
      const matched = expandInclude(source, pattern, fsImpl)
      if (matched.length === 0) {
        throw new Error(
          `stage-bundled-plugins: include "${pattern}" for plugins/${dir} matched no files. A rename here ships a plugin without its own code.`
        )
      }
      files.push(...matched)
    }
    if (!files.includes("plugin.json")) {
      throw new Error(
        `stage-bundled-plugins: plugins/${dir} must include plugin.json — the host discovers a plugin by its manifest.`
      )
    }

    const staged = []
    for (const relative of [...new Set(files)].sort()) {
      const from = path.join(source, relative)
      const to = path.join(target, dir, relative)
      fsImpl.mkdirSync(path.dirname(to), { recursive: true })
      const bytes = fsImpl.readFileSync(from)
      fsImpl.writeFileSync(to, bytes)
      staged.push({
        path: relative,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      })
    }

    catalog.entries[dir] = {
      id: manifest.id,
      version: manifest.version,
      files: staged,
    }
  }

  const catalogPath = catalogFile ?? path.join(ROOT, CATALOG_FILE)
  fsImpl.mkdirSync(path.dirname(catalogPath), { recursive: true })
  fsImpl.writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`)
  return { stagedDir: target, catalogPath, catalog }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  const { stagedDir, catalog } = stageBundledPlugins()
  const ids = Object.values(catalog.entries).map((e) => `${e.id}@${e.version}`)
  console.log(
    ids.length > 0
      ? `[stage-bundled-plugins] staged ${ids.join(", ")} into ${path.relative(ROOT, stagedDir)}`
      : "[stage-bundled-plugins] nothing to stage"
  )
}
