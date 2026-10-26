#!/usr/bin/env node
// Produce a plugin artifact set (`scripts/build/plugin-artifact-format.mjs`)
// from plugin source: the browser built-in chunks, their index and pre-boot
// snapshot, the plugin icons, and the installer-staged plugins with their seed
// catalog. The host build consumes the finished set through
// `scripts/build/stage-plugin-artifacts.mjs` and never reads plugin source.
//
//   node scripts/plugin/artifacts/produce.mjs --out <set dir> [--plugins <plugin source dir>]
//
// `--plugins` defaults to `<repo>/plugins`; curation is always the host's
// (`lib/plugin/distribution/`), because which plugins ship is the app's choice.

import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  PLUGIN_ARTIFACT_MANIFEST,
  PLUGIN_ARTIFACT_SCHEMA,
} from "../../build/plugin-artifact-format.mjs"
import { writeIfChanged } from "../../build/esbuild-input-cache.mjs"
import { buildBrowserBuiltinPlugins } from "./builtin-chunks.mjs"
import { stageBundledPlugins } from "./desktop-plugins.mjs"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")

/** Every regular file under `directory` as sorted `/`-separated relative paths. */
export function listSetFiles(directory) {
  const files = []
  const walk = (current, prefix) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      const absolute = path.join(current, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`Symlink in plugin artifact set: ${relative}`)
      if (entry.isDirectory()) walk(absolute, relative)
      else if (entry.isFile()) files.push(relative)
      else throw new Error(`Unsupported entry in plugin artifact set: ${relative}`)
    }
  }
  walk(directory, "")
  return files.sort()
}

/**
 * Build the whole set into `outDir`. The manifest is written last and lists
 * every file with its digest, so an interrupted run leaves a set the consumer
 * refuses rather than one it stages half of.
 */
export async function producePluginArtifacts({
  root = repoRoot,
  pluginsRoot,
  outDir,
  bundle,
  buildFrontend,
} = {}) {
  if (!outDir) throw new Error("producePluginArtifacts: `outDir` is required")
  root = path.resolve(root)
  outDir = path.resolve(outDir)
  pluginsRoot = path.resolve(pluginsRoot ?? path.join(root, "plugins"))
  if (!fs.existsSync(pluginsRoot))
    throw new Error(`producePluginArtifacts: plugin source directory ${pluginsRoot} does not exist`)
  fs.mkdirSync(outDir, { recursive: true })
  const manifestPath = path.join(outDir, PLUGIN_ARTIFACT_MANIFEST)
  // A set being rebuilt is not a valid set until its new manifest lands.
  fs.rmSync(manifestPath, { force: true })

  await buildBrowserBuiltinPlugins({ root, pluginsRoot, outDir, bundle })
  await stageBundledPlugins({
    root,
    pluginsRoot,
    outDir,
    ...(buildFrontend ? { buildFrontend } : {}),
  })

  const files = {}
  for (const relative of listSetFiles(outDir)) {
    if (relative === PLUGIN_ARTIFACT_MANIFEST) continue
    files[relative] = createHash("sha256")
      .update(fs.readFileSync(path.join(outDir, ...relative.split("/"))))
      .digest("hex")
  }
  const manifest = { schema: PLUGIN_ARTIFACT_SCHEMA, files }
  writeIfChanged(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return { outDir, manifest }
}

function argument(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outDir = argument("--out")
  if (!outDir) {
    console.error("usage: produce.mjs --out <set dir> [--plugins <plugin source dir>]")
    process.exit(2)
  }
  const pluginsRoot = argument("--plugins")
  const { manifest } = await producePluginArtifacts({
    outDir: path.resolve(outDir),
    ...(pluginsRoot ? { pluginsRoot: path.resolve(pluginsRoot) } : {}),
  })
  console.log(
    `[plugin-artifacts] produced ${Object.keys(manifest.files).length} file(s) into ${outDir}`
  )
}
