// Producer half of the installer-staged plugins.
//
// Frontend plugins ride inside the app as browser built-ins
// (`builtin-chunks.mjs`). Those declaring nodeRuntime also need a disk package
// of their UI and bounded provisioning sources. Everything else -- Python and
// WASM -- needs a real directory before the Tauri host can run it, and the
// host only ever scans `<appDataDir>/cognia/plugins`. This step packages the
// shipping files of every plugin the host's curation
// (`lib/plugin/distribution/distribution.json`) lists as bundled into the
// `desktop-plugins/` section of a plugin artifact set; the host stages that
// section under `src-tauri/resources/plugins/` for `bundle.resources` to pick
// up, and the renderer seeds them into the plugin directory on first run.
//
// Only what the plugin needs at runtime is copied. A Python plugin's working
// directory also holds `.venv/`, `__pycache__/`, `.pytest_cache/`, `tests/`
// and a lockfile, and putting a machine-local virtualenv inside an installer
// would be both enormous and wrong -- `pythonVenv: "isolated"` means the host
// provisions one per install.
//
// Every staged file is hashed into the seed catalog, the same integrity shape
// the browser built-in index uses, so the seeder can tell a truncated copy
// from a good one.

import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { buildFrontendPlugin } from "../build-frontend-plugins.mjs"
import {
  PLUGIN_ARTIFACT_SECTIONS,
  PLUGIN_CURATION_FILES,
} from "../../build/plugin-artifact-format.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..")

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

/** Read the host's installer curation. */
export function readDistribution(fsImpl = fs, root = ROOT) {
  const raw = JSON.parse(
    fsImpl.readFileSync(path.join(root, PLUGIN_CURATION_FILES.distribution), "utf8")
  )
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
  if (typeof pattern !== "string" || !pattern)
    throw new Error(`desktop-plugins: unsafe include path "${pattern}"`)
  const segments = pattern.split("/")
  if (
    path.isAbsolute(pattern) ||
    /[\\:\0]/.test(pattern) ||
    segments.some((part) => part === ".." || part === "." || !part)
  )
    throw new Error(`desktop-plugins: unsafe include path "${pattern}"`)
  if (segments.some((part) => NEVER_STAGE.has(part))) return []
  const assertSource = (relative) => {
    let current = pluginDir
    for (const part of relative.split("/")) {
      current = path.join(current, part)
      if (fsImpl.lstatSync(current).isSymbolicLink())
        throw new Error(`desktop-plugins: symlink source "${relative}"`)
    }
  }
  const recursive = pattern.match(/^(.*)\/\*\*\/\*(\.[A-Za-z0-9]+)?$/u)
  if (!recursive) {
    if (pattern.includes("*")) {
      throw new Error(
        `desktop-plugins: unsupported include pattern "${pattern}". Use a plain path or "<dir>/**/*[.ext]".`
      )
    }
    const absolute = path.join(pluginDir, pattern)
    if (!fsImpl.existsSync(absolute)) return []
    assertSource(pattern)
    if (!fsImpl.statSync(absolute).isFile())
      throw new Error(`desktop-plugins: expected file "${pattern}"`)
    return [pattern]
  }

  const [, subdir, extension] = recursive
  const base = path.join(pluginDir, subdir)
  if (!fsImpl.existsSync(base)) return []
  assertSource(subdir)

  const found = []
  const walk = (dir, relative) => {
    for (const entry of fsImpl.readdirSync(dir, { withFileTypes: true })) {
      if (NEVER_STAGE.has(entry.name)) continue
      if (entry.isSymbolicLink()) throw new Error(`desktop-plugins: symlink source "${entry.name}"`)
      const next = path.join(dir, entry.name)
      const nextRelative = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        walk(next, nextRelative)
        continue
      }
      if (!entry.isFile()) throw new Error(`desktop-plugins: unsupported source "${entry.name}"`)
      if (extension && !entry.name.endsWith(extension)) continue
      found.push(`${subdir}/${nextRelative}`)
    }
  }
  walk(base, "")
  return found.sort()
}

/**
 * Copy every bundled plugin's shipping files into the set's `desktop-plugins/`
 * section and write its seed catalog. Throws when a declared `include` matches
 * nothing, because that is always a rename that would otherwise ship a plugin
 * missing its own code.
 *
 * `outDir` is the artifact set directory; `stagedDir` / `catalogFile` override
 * the two outputs inside it. `root` is the toolchain and curation root,
 * `pluginsRoot` the plugin source directory.
 */
export async function stageBundledPlugins({
  outDir,
  stagedDir,
  catalogFile,
  fsImpl = fs,
  root = ROOT,
  pluginsRoot,
  buildFrontend = buildFrontendPlugin,
} = {}) {
  if (!outDir && !(stagedDir && catalogFile))
    throw new Error("stageBundledPlugins: `outDir` (or `stagedDir` and `catalogFile`) is required")
  const target = stagedDir ?? path.join(outDir, PLUGIN_ARTIFACT_SECTIONS.desktopPlugins.set)
  pluginsRoot ??= path.join(root, "plugins")
  const { bundled = {} } = readDistribution(fsImpl, root)
  const browserBuiltins = JSON.parse(
    fsImpl.readFileSync(path.join(root, PLUGIN_CURATION_FILES.browserBuiltins), "utf8")
  )

  // Everything is collected first and written last: a failing include leaves
  // the previous stage intact, and an unchanged stage is not rewritten.
  const pending = new Map()
  const catalog = { entries: {} }
  for (const [dir, entry] of Object.entries(bundled)) {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(dir))
      throw new Error(`Unsafe bundled plugin directory: ${dir}`)
    const source = path.join(pluginsRoot, dir)
    if (fsImpl.lstatSync(source).isSymbolicLink())
      throw new Error(`Unsafe bundled plugin directory (symlink): ${dir}`)
    const manifestPath = path.join(source, "plugin.json")
    if (!fsImpl.existsSync(manifestPath)) {
      throw new Error(
        `desktop-plugins: plugins/${dir} is listed as bundled but has no plugin.json.`
      )
    }
    const manifest = JSON.parse(fsImpl.readFileSync(manifestPath, "utf8"))
    if (manifest.id !== entry.id) {
      throw new Error(
        `desktop-plugins: plugins/${dir} declares id "${manifest.id}" but distribution.json says "${entry.id}".`
      )
    }

    const files = []
    for (const pattern of entry.include ?? []) {
      const matched = expandInclude(source, pattern, fsImpl)
      if (matched.length === 0) {
        throw new Error(
          `desktop-plugins: include "${pattern}" for plugins/${dir} matched no files. A rename here ships a plugin without its own code.`
        )
      }
      files.push(...matched)
    }
    if (!files.includes("plugin.json")) {
      throw new Error(
        `desktop-plugins: plugins/${dir} must include plugin.json — the host discovers a plugin by its manifest.`
      )
    }

    const staged = []
    for (const relative of [...new Set(files)].sort()) {
      const from = path.join(source, relative)
      const bytes = fsImpl.readFileSync(from)
      pending.set(`${dir}/${relative}`, bytes)
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

  // Frontend UI stays on the existing builtin registration path. Only those
  // declaring a host runtime also need an installable package on disk.
  for (const dir of browserBuiltins) {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(dir))
      throw new Error(`Unsafe bundled plugin directory: ${dir}`)
    const source = path.join(pluginsRoot, dir)
    if (fsImpl.lstatSync(source).isSymbolicLink())
      throw new Error(`Unsafe bundled plugin directory (symlink): ${dir}`)
    const manifest = JSON.parse(fsImpl.readFileSync(path.join(source, "plugin.json"), "utf8"))
    if (manifest.type !== "frontend" || !manifest.nodeRuntime) continue
    if (catalog.entries[dir]) throw new Error(`Duplicate bundled plugin directory: ${dir}`)
    const built = await buildFrontend({ root, pluginsRoot, directory: dir })
    const staged = []
    for (const [relative, bytes] of [...built.files].sort(([left], [right]) =>
      left.localeCompare(right)
    )) {
      if (
        path.isAbsolute(relative) ||
        /[\\:\0]/.test(relative) ||
        relative
          .split("/")
          .some((part) => part === ".." || part === "." || !part || NEVER_STAGE.has(part))
      )
        throw new Error(`Unsafe built plugin path: ${relative}`)
      pending.set(`${dir}/${relative}`, Buffer.from(bytes))
      staged.push({
        path: relative,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      })
    }
    catalog.entries[dir] = { id: built.manifest.id, version: built.manifest.version, files: staged }
  }

  // An unchanged section is left alone, so the consumer's own unchanged-tree
  // check (which keeps `tauri dev` from restarting) sees stable mtimes too.
  const changed = !stagedTreeMatches(target, pending, fsImpl)
  if (changed) {
    fsImpl.rmSync(target, { recursive: true, force: true })
    fsImpl.mkdirSync(target, { recursive: true })
    for (const [relative, bytes] of pending) {
      const to = path.join(target, ...relative.split("/"))
      fsImpl.mkdirSync(path.dirname(to), { recursive: true })
      fsImpl.writeFileSync(to, bytes)
    }
  }

  const catalogPath = catalogFile ?? path.join(outDir, PLUGIN_ARTIFACT_SECTIONS.desktopCatalog.set)
  const catalogText = `${JSON.stringify(catalog, null, 2)}\n`
  const currentCatalog = fsImpl.existsSync(catalogPath)
    ? fsImpl.readFileSync(catalogPath, "utf8")
    : null
  if (currentCatalog !== catalogText) {
    fsImpl.mkdirSync(path.dirname(catalogPath), { recursive: true })
    fsImpl.writeFileSync(catalogPath, catalogText)
  }
  return { stagedDir: target, catalogPath, catalog, changed }
}

/**
 * True when `target` holds exactly the files in `pending` (keys are
 * `/`-separated paths relative to `target`) with identical bytes.
 */
export function stagedTreeMatches(target, pending, fsImpl = fs) {
  if (!fsImpl.existsSync(target)) return pending.size === 0
  const present = []
  const walk = (dir, prefix) => {
    for (const entry of fsImpl.readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(path.join(dir, entry.name), relative)
      else present.push(relative)
    }
  }
  walk(target, "")
  if (present.length !== pending.size) return false
  return present.every((relative) => {
    const expected = pending.get(relative)
    return (
      expected !== undefined &&
      fsImpl.readFileSync(path.join(target, ...relative.split("/"))).equals(expected)
    )
  })
}
