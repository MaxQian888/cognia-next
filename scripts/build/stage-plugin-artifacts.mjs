#!/usr/bin/env node
// Stage a plugin artifact set (`plugin-artifact-format.mjs`) into the host
// tree: the browser built-in chunks and icons under `public/_cognia/`, the
// installer-staged plugins under `src-tauri/resources/plugins/`, and the three
// generated catalogs the app imports. This is the only plugin step of
// `predev` / `prebuild` / `mobile:prepare`; the build reads first-party
// plugins through it, never through plugin source.
//
// `--web-only` skips the installer section (Capacitor builds).
//
// Where the set comes from, in order:
//   1. `--from <dir>` or `COGNIA_PLUGIN_ARTIFACTS=<dir>`: a set produced
//      elsewhere (another checkout, a CI artifact). `plugins/` is not read.
//   2. A `plugins/` directory in this checkout: the set is produced from it
//      into `.cache/plugin-artifacts/` first (incremental), then staged.
//   3. Neither: the build stops and says how to provide one.
//
// Every file is verified against the set's manifest before anything is
// written, so a truncated or tampered set changes nothing in the host tree.

import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  PLUGIN_ARTIFACT_MANIFEST,
  PLUGIN_ARTIFACT_SCHEMA,
  PLUGIN_ARTIFACT_SECTIONS,
  assertSetRelativePath,
} from "./plugin-artifact-format.mjs"
import { writeIfChanged } from "./esbuild-input-cache.mjs"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

/** Environment variable naming a prebuilt set directory. */
export const PLUGIN_ARTIFACTS_ENV = "COGNIA_PLUGIN_ARTIFACTS"

/** Where an in-repo production writes its set. */
export const LOCAL_ARTIFACT_DIR = path.join(".cache", "plugin-artifacts")

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

/**
 * Decide where the set comes from. `produce` is only called for an in-repo
 * production and is imported lazily, so a checkout without the producer (or
 * without `plugins/`) never loads it.
 */
export async function resolvePluginArtifactSet({
  root = repoRoot,
  from,
  env = process.env,
  produce,
} = {}) {
  const explicit = from ?? env[PLUGIN_ARTIFACTS_ENV]
  if (explicit) return { dir: path.resolve(root, explicit), source: "external" }
  const pluginsRoot = path.join(root, "plugins")
  if (fs.existsSync(pluginsRoot)) {
    const outDir = path.join(root, LOCAL_ARTIFACT_DIR)
    const run =
      produce ??
      (await import("../plugin/artifacts/produce.mjs")).producePluginArtifacts
    await run({ root, pluginsRoot, outDir })
    return { dir: outDir, source: "produced" }
  }
  throw new Error(
    `No plugin artifact set. Point ${PLUGIN_ARTIFACTS_ENV} (or --from) at a set produced by ` +
      "`node scripts/plugin/artifacts/produce.mjs --out <dir>`, or check out the plugin sources under plugins/."
  )
}

/** Which section a set-relative path belongs to, or `undefined`. */
function sectionOf(relative) {
  for (const [name, section] of Object.entries(PLUGIN_ARTIFACT_SECTIONS)) {
    if (section.kind === "file" ? relative === section.set : relative.startsWith(`${section.set}/`))
      return { name, section }
  }
  return undefined
}

/**
 * Read and verify a set. Returns the bytes of every file, grouped by section.
 * Throws on a wrong schema, a path outside every section, a missing file, an
 * unlisted file, or a digest mismatch.
 */
export function readPluginArtifactSet(dir) {
  const manifestPath = path.join(dir, PLUGIN_ARTIFACT_MANIFEST)
  if (!fs.existsSync(manifestPath))
    throw new Error(`Plugin artifact set ${dir} has no ${PLUGIN_ARTIFACT_MANIFEST}`)
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
  if (manifest?.schema !== PLUGIN_ARTIFACT_SCHEMA)
    throw new Error(
      `Plugin artifact set ${dir} has schema ${JSON.stringify(manifest?.schema)}; this host reads schema ${PLUGIN_ARTIFACT_SCHEMA}`
    )
  const listed = manifest.files ?? {}
  const sections = Object.fromEntries(
    Object.keys(PLUGIN_ARTIFACT_SECTIONS).map((name) => [name, new Map()])
  )
  for (const [relative, digest] of Object.entries(listed)) {
    assertSetRelativePath(relative)
    const owner = sectionOf(relative)
    if (!owner) throw new Error(`Plugin artifact set lists ${relative}, which belongs to no section`)
    const file = path.join(dir, ...relative.split("/"))
    let bytes
    try {
      bytes = fs.readFileSync(file)
    } catch (error) {
      if (error.code === "ENOENT") throw new Error(`Plugin artifact set is missing ${relative}`)
      throw error
    }
    if (sha256(bytes) !== digest)
      throw new Error(`Plugin artifact set file ${relative} does not match its manifest digest`)
    const key =
      owner.section.kind === "file" ? "" : relative.slice(owner.section.set.length + 1)
    sections[owner.name].set(key, bytes)
  }
  for (const [name, section] of Object.entries(PLUGIN_ARTIFACT_SECTIONS)) {
    if (section.kind === "file" && !sections[name].has(""))
      throw new Error(`Plugin artifact set has no ${section.set}`)
  }
  for (const relative of listFiles(dir)) {
    if (relative !== PLUGIN_ARTIFACT_MANIFEST && !(relative in listed))
      throw new Error(`Plugin artifact set contains ${relative}, which its manifest does not list`)
  }
  return sections
}

function listFiles(directory) {
  if (!fs.existsSync(directory)) return []
  const files = []
  const walk = (current, prefix) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(path.join(current, entry.name), relative)
      else files.push(relative)
    }
  }
  walk(directory, "")
  return files
}

function treeMatches(target, files) {
  const present = listFiles(target)
  if (present.length !== files.size) return false
  return present.every((relative) => {
    const expected = files.get(relative)
    return (
      expected !== undefined &&
      fs.readFileSync(path.join(target, ...relative.split("/"))).equals(expected)
    )
  })
}

function pruneEmptyDirectories(directory) {
  if (!fs.existsSync(directory)) return
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const child = path.join(directory, entry.name)
    pruneEmptyDirectories(child)
    if (fs.readdirSync(child).length === 0) fs.rmdirSync(child)
  }
}

/** Mirror `files` into `target`: write what differs, remove what the set lacks. */
function mirrorTree(target, files, { replaceWhole = false } = {}) {
  if (treeMatches(target, files)) return false
  if (replaceWhole) fs.rmSync(target, { recursive: true, force: true })
  for (const [relative, bytes] of files) writeIfChanged(path.join(target, ...relative.split("/")), bytes)
  for (const relative of listFiles(target)) {
    if (!files.has(relative)) fs.rmSync(path.join(target, ...relative.split("/")), { force: true })
  }
  pruneEmptyDirectories(target)
  return true
}

/** Sections a Capacitor build stages: everything but the installer-staged plugins. */
export const WEB_SECTIONS = Object.freeze(
  Object.keys(PLUGIN_ARTIFACT_SECTIONS).filter((name) => name !== "desktopPlugins")
)

/**
 * Stage a verified set into `root`. `sections` limits which host copies are
 * written (all by default); the whole set is still verified. Returns the set
 * directory, where it came from, and the sections whose host copy changed.
 */
export async function stagePluginArtifacts({
  root = repoRoot,
  from,
  env,
  produce,
  sections: only = Object.keys(PLUGIN_ARTIFACT_SECTIONS),
} = {}) {
  root = path.resolve(root)
  const { dir, source } = await resolvePluginArtifactSet({ root, from, env, produce })
  const sections = readPluginArtifactSet(dir)
  const changed = []
  for (const [name, section] of Object.entries(PLUGIN_ARTIFACT_SECTIONS)) {
    if (!only.includes(name)) continue
    const target = path.join(root, ...section.host.split("/"))
    if (section.kind === "file") {
      const bytes = sections[name].get("")
      const current = fs.existsSync(target) ? fs.readFileSync(target) : null
      if (!current?.equals(bytes)) {
        writeIfChanged(target, bytes)
        changed.push(name)
      }
    } else if (mirrorTree(target, sections[name], { replaceWhole: section.replaceWhole })) {
      changed.push(name)
    }
  }
  return { dir, source, changed }
}

function argument(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { dir, source, changed } = await stagePluginArtifacts({
      from: argument("--from"),
      ...(process.argv.includes("--web-only") ? { sections: WEB_SECTIONS } : {}),
    })
    console.log(
      `[plugin-artifacts] staged ${source} set ${path.relative(repoRoot, dir) || dir}` +
        (changed.length ? ` (updated: ${changed.join(", ")})` : " (unchanged)")
    )
  } catch (error) {
    console.error(`[plugin-artifacts] ${error.message}`)
    process.exitCode = 1
  }
}
