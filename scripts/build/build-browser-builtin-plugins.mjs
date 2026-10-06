#!/usr/bin/env node

import { createHash } from "node:crypto"
import { readFile, readdir, rm } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { buildFrontendPlugin } from "../plugin/build-frontend-plugins.mjs"

import {
  isBuildCacheFresh,
  readBuildCache,
  saveBuildCache,
  writeIfChanged,
} from "./esbuild-input-cache.mjs"

const generatorFile = fileURLToPath(import.meta.url)
const repoRoot = path.resolve(path.dirname(generatorFile), "../..")

export const BROWSER_BUILTIN_PLUGIN_IDS = JSON.parse(
  await readFile(new URL("../../plugins/browser-builtins.json", import.meta.url), "utf8")
)

function sha256(content) {
  return createHash("sha256").update(content).digest("hex")
}

/** Publish package-owned identity images for builtin:// roots on every shell. */
export async function stageBuiltinPluginIcons(root) {
  const pluginsRoot = path.join(root, "plugins")
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
    ) continue
    if (typeof manifest.id !== "string" || !/^[a-z0-9][a-z0-9._-]*$/.test(manifest.id)) {
      throw new Error(`Invalid plugin id for icon staging: ${directory.name}`)
    }
    const relative = icon.replace(/\\/g, "/")
    const source = path.resolve(pluginRoot, relative)
    if (!source.startsWith(`${pluginRoot}${path.sep}`)) {
      throw new Error(`Plugin icon outside plugin root: ${directory.name}/${icon}`)
    }
    const output = path.join(root, "public/_cognia/plugin-icons", manifest.id, relative)
    writeIfChanged(output, await readFile(source))
  }
}

async function preparePdfWorker(root, publicRoot) {
  const source = path.join(root, "node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs")
  const contents = await readFile(source)
  const digest = sha256(contents)
  const outputRoot = path.join(publicRoot, "_shared")
  const output = path.join(outputRoot, `pdf.worker.${digest}.mjs`)
  writeIfChanged(output, contents)
  return { source, output, url: `/_cognia/builtin-plugins/_shared/pdf.worker.${digest}.mjs` }
}

async function buildPlugin(directory, { root, publicRoot, pdfWorkerUrl, bundle }) {
  const result = await buildFrontendPlugin({ root, directory, pdfWorkerUrl, bundle })
  const { manifest } = result
  const javascript = result.files.get(manifest.main)
  const digest = sha256(javascript)
  const pluginOutputRoot = path.join(publicRoot, manifest.id)
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
        url: `/_cognia/builtin-plugins/${manifest.id}/${digest}.cjs`,
        sha256: digest,
        sharedModules: result.sharedModules,
        resourcesUrl: `/_cognia/builtin-plugins/${manifest.id}/resources/`,
        entryHashes: Object.fromEntries(
          [...result.files].filter(([name]) => name.endsWith(".js")).map(([name, bytes]) => [name, sha256(bytes)])
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

export async function buildBrowserBuiltinPlugins({
  root = repoRoot,
  pluginIds = BROWSER_BUILTIN_PLUGIN_IDS,
  bundle,
} = {}) {
  root = path.resolve(root)
  if (pluginIds.some((id) => !/^[a-z0-9][a-z0-9-]*$/.test(id)))
    throw new Error("Invalid browser builtin plugin id")
  // Icons also belong to statically imported built-ins, and must refresh even
  // when none of the five separately bundled plugins need recompilation.
  await stageBuiltinPluginIcons(root)
  const publicRoot = path.join(root, "public/_cognia/builtin-plugins")
  const generatedIndexPath = path.join(
    root,
    "lib/plugin/core/browser-builtin-assets.generated.json"
  )
  const cachePath = path.join(root, ".cache/build/browser-builtin-plugins.json")
  const key = JSON.stringify(pluginIds)
  const cache = readBuildCache(cachePath)
  if (isBuildCacheFresh(cache, root, key, [generatedIndexPath])) {
    await pruneStaleOutputs(publicRoot, new Set(Object.keys(cache.outputs)))
    return JSON.parse(await readFile(generatedIndexPath, "utf8")).entries
  }

  const startedAt = performance.timeOrigin + performance.now()
  const build = bundle ?? (await import("esbuild")).build
  const pdfWorker = await preparePdfWorker(root, publicRoot)
  const entries = {}
  const inputs = []
  const outputs = [pdfWorker.output, generatedIndexPath]
  for (const pluginId of pluginIds) {
    const result = await buildPlugin(pluginId, {
      root,
      publicRoot,
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
  await pruneStaleOutputs(publicRoot, new Set(outputs))
  saveBuildCache(cachePath, {
    root,
    key,
    inputs,
    outputs,
    startedAt,
    extraFiles: [
      generatorFile,
      fileURLToPath(new URL("../plugin/build-frontend-plugins.mjs", import.meta.url)),
      fileURLToPath(new URL("../../plugins/browser-builtins.json", import.meta.url)),
      pdfWorker.source,
      ...pluginIds.map((id) => path.join(root, "plugins", id, "plugin.json")),
    ],
  })
  return entries
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const entries = await buildBrowserBuiltinPlugins()
  process.stdout.write(`Built ${Object.keys(entries).length} browser builtin plugin assets.\n`)
}
