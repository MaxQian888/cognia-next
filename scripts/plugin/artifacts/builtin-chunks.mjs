// Producer half of the browser built-ins: compile each curated frontend plugin
// to its own content-addressed chunk, and write the registry index, the
// pre-boot manifest snapshot and the plugin icons into a plugin artifact set
// (`scripts/build/plugin-artifact-format.mjs`). The host never runs this
// against its own tree; `scripts/build/stage-plugin-artifacts.mjs` stages a
// finished set.

import { createHash } from "node:crypto"
import { readFile, readdir, rm } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { buildFrontendPlugin } from "../build-frontend-plugins.mjs"
import {
  BUILTIN_CHUNK_URL_PREFIX,
  PLUGIN_ARTIFACT_SECTIONS,
  PLUGIN_CURATION_FILES,
} from "../../build/plugin-artifact-format.mjs"
import {
  isBuildCacheFresh,
  readBuildCache,
  saveBuildCache,
  writeIfChanged,
} from "../../build/esbuild-input-cache.mjs"

const generatorFile = fileURLToPath(import.meta.url)
const repoRoot = path.resolve(path.dirname(generatorFile), "../../..")

/** Read the host's browser built-in curation (a JSON array of plugin directory names). */
export async function readBrowserBuiltinIds(root = repoRoot) {
  return JSON.parse(await readFile(path.join(root, PLUGIN_CURATION_FILES.browserBuiltins), "utf8"))
}

export const BROWSER_BUILTIN_PLUGIN_IDS = await readBrowserBuiltinIds()

/**
 * Manifest fields the host reads before the plugin manager boots. Database boot
 * applies `dexie` tables, and first-launch seeding writes the built-in
 * characters from `characterPacks`, both before any plugin is discovered. The
 * full asset index stays behind the manager's dynamic import, so these fields
 * are copied into a small snapshot the eager boot path can import instead of
 * reaching into plugin source.
 */
export const PREBOOT_MANIFEST_FIELDS = Object.freeze(["dexie", "characterPacks"])

/** Project the asset index down to the fields in `PREBOOT_MANIFEST_FIELDS`. */
export function prebootManifestSnapshot(entries) {
  const plugins = {}
  for (const id of Object.keys(entries).sort()) {
    const manifest = entries[id].manifest
    const fields = Object.fromEntries(
      PREBOOT_MANIFEST_FIELDS.filter((field) => manifest[field] !== undefined).map((field) => [
        field,
        manifest[field],
      ])
    )
    if (Object.keys(fields).length > 0) plugins[id] = { version: manifest.version, ...fields }
  }
  return { version: 1, plugins }
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex")
}

/**
 * Publish package-owned identity images for builtin:// roots on every shell.
 * Every plugin directory with an image icon contributes, not only the browser
 * built-ins: desktop-staged plugins show the same identity before they load.
 * Writes `<outDir>/<plugin id>/<icon path>` and removes anything else there.
 */
export async function stageBuiltinPluginIcons({ pluginsRoot, outDir }) {
  const expected = new Set()
  for (const directory of await readdir(pluginsRoot, { withFileTypes: true })) {
    if (!directory.isDirectory()) continue
    const pluginRoot = path.join(pluginsRoot, directory.name)
    let manifest
    try {
      manifest = JSON.parse(await readFile(path.join(pluginRoot, "plugin.json"), "utf8"))
    } catch (error) {
      if (error.code === "ENOENT") continue
      throw error
    }
    const icon = manifest.icon
    if (
      typeof icon !== "string" ||
      /^(?:[a-z]+:|\/)/i.test(icon) ||
      !/\.(?:png|svg|webp|jpe?g|gif|avif)$/i.test(icon)
    )
      continue
    if (typeof manifest.id !== "string" || !/^[a-z0-9][a-z0-9._-]*$/.test(manifest.id)) {
      throw new Error(`Invalid plugin id for icon staging: ${directory.name}`)
    }
    const relative = icon.replace(/\\/g, "/")
    const source = path.resolve(pluginRoot, relative)
    if (!source.startsWith(`${pluginRoot}${path.sep}`)) {
      throw new Error(`Plugin icon outside plugin root: ${directory.name}/${icon}`)
    }
    const output = path.join(outDir, manifest.id, relative)
    writeIfChanged(output, await readFile(source))
    expected.add(output)
  }
  await pruneStaleOutputs(outDir, expected)
}

async function preparePdfWorker(root, chunksRoot) {
  const source = path.join(root, "node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs")
  const contents = await readFile(source)
  const digest = sha256(contents)
  const output = path.join(chunksRoot, "_shared", `pdf.worker.${digest}.mjs`)
  writeIfChanged(output, contents)
  return { source, output, url: `${BUILTIN_CHUNK_URL_PREFIX}/_shared/pdf.worker.${digest}.mjs` }
}

async function buildPlugin(directory, { root, pluginsRoot, chunksRoot, pdfWorkerUrl, bundle }) {
  const result = await buildFrontendPlugin({ root, pluginsRoot, directory, pdfWorkerUrl, bundle })
  const { manifest } = result
  const javascript = result.files.get(manifest.main)
  const digest = sha256(javascript)
  const pluginOutputRoot = path.join(chunksRoot, manifest.id)
  const outputs = [path.join(pluginOutputRoot, `${digest}.cjs`)]
  writeIfChanged(outputs[0], javascript)
  // Every package resource also has a builtin:// mirror. The independent ZIP
  // contains these exact bytes, so plugins never depend on a host source path.
  for (const [relative, contents] of result.files) {
    const output = path.join(pluginOutputRoot, "resources", relative)
    writeIfChanged(output, contents)
    outputs.push(output)
  }
  const stylesheet = manifest.styles ? result.files.get(manifest.styles) : undefined
  return {
    inputs: result.inputs,
    outputs,
    entry: {
      manifest,
      path: `builtin://${manifest.id}`,
      compatibilityDiagnostics: [],
      ...(stylesheet ? { bundledStyles: stylesheet.toString("utf8") } : {}),
      asset: {
        url: `${BUILTIN_CHUNK_URL_PREFIX}/${manifest.id}/${digest}.cjs`,
        sha256: digest,
        sharedModules: result.sharedModules,
        resourcesUrl: `${BUILTIN_CHUNK_URL_PREFIX}/${manifest.id}/resources/`,
        entryHashes: Object.fromEntries(
          [...result.files]
            .filter(([name]) => /\.[cm]?js$/.test(name))
            .map(([name, bytes]) => [name, sha256(bytes)])
        ),
      },
    },
  }
}

async function pruneStaleOutputs(directory, expected) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error.code === "ENOENT") return
    throw error
  }
  for (const entry of entries) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      await pruneStaleOutputs(file, expected)
      if ((await readdir(file)).length === 0) await rm(file, { recursive: true })
    } else if (!expected.has(file)) {
      await rm(file, { force: true })
    }
  }
}

/**
 * Build the browser built-ins into the artifact set at `outDir`.
 *
 * `root` is the toolchain root (esbuild, `node_modules`, the SDK contract) and
 * `pluginsRoot` the plugin source directory. Returns the index entries.
 */
export async function buildBrowserBuiltinPlugins({
  root = repoRoot,
  pluginsRoot,
  pluginIds,
  bundle,
  outDir,
} = {}) {
  if (!outDir) throw new Error("buildBrowserBuiltinPlugins: `outDir` is required")
  root = path.resolve(root)
  outDir = path.resolve(outDir)
  pluginsRoot = path.resolve(pluginsRoot ?? path.join(root, "plugins"))
  pluginIds ??= await readBrowserBuiltinIds(root)
  if (pluginIds.some((id) => !/^[a-z0-9][a-z0-9-]*$/.test(id)))
    throw new Error("Invalid browser builtin plugin id")
  // Icons also belong to plugins that are not browser built-ins, and must
  // refresh even when no chunk needs recompilation.
  await stageBuiltinPluginIcons({
    pluginsRoot,
    outDir: path.join(outDir, PLUGIN_ARTIFACT_SECTIONS.pluginIcons.set),
  })
  const chunksRoot = path.join(outDir, PLUGIN_ARTIFACT_SECTIONS.builtinChunks.set)
  const generatedIndexPath = path.join(outDir, PLUGIN_ARTIFACT_SECTIONS.builtinIndex.set)
  const prebootPath = path.join(outDir, PLUGIN_ARTIFACT_SECTIONS.prebootManifests.set)
  const cachePath = path.join(root, ".cache/build/browser-builtin-plugins.json")
  const key = JSON.stringify({ pluginIds, pluginsRoot, outDir })
  const cache = readBuildCache(cachePath)
  if (isBuildCacheFresh(cache, root, key, [generatedIndexPath, prebootPath])) {
    await pruneStaleOutputs(chunksRoot, new Set(Object.keys(cache.outputs)))
    return JSON.parse(await readFile(generatedIndexPath, "utf8")).entries
  }

  const startedAt = performance.timeOrigin + performance.now()
  const build = bundle ?? (await import("esbuild")).build
  const pdfWorker = await preparePdfWorker(root, chunksRoot)
  const entries = {}
  const inputs = []
  const outputs = [pdfWorker.output, generatedIndexPath, prebootPath]
  for (const pluginId of pluginIds) {
    const result = await buildPlugin(pluginId, {
      root,
      pluginsRoot,
      chunksRoot,
      pdfWorkerUrl: pdfWorker.url,
      bundle: build,
    })
    entries[result.entry.manifest.id] = result.entry
    inputs.push(...result.inputs)
    outputs.push(...result.outputs)
  }

  // Publish the index only after every new content-addressed asset is durable.
  // On failure the previous index and its assets remain usable.
  writeIfChanged(generatedIndexPath, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`)
  writeIfChanged(prebootPath, `${JSON.stringify(prebootManifestSnapshot(entries), null, 2)}\n`)
  await pruneStaleOutputs(chunksRoot, new Set(outputs))
  saveBuildCache(cachePath, {
    root,
    key,
    inputs,
    outputs,
    startedAt,
    extraFiles: [
      generatorFile,
      fileURLToPath(new URL("../build-frontend-plugins.mjs", import.meta.url)),
      path.join(root, PLUGIN_CURATION_FILES.browserBuiltins),
      pdfWorker.source,
      ...pluginIds.map((id) => path.join(pluginsRoot, id, "plugin.json")),
    ],
  })
  return entries
}
