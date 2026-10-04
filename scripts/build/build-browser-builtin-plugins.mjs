#!/usr/bin/env node

import { createHash } from "node:crypto"
import { readFile, readdir, rm } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  isBuildCacheFresh,
  readBuildCache,
  saveBuildCache,
  writeIfChanged,
} from "./esbuild-input-cache.mjs"

const generatorFile = fileURLToPath(import.meta.url)
const repoRoot = path.resolve(path.dirname(generatorFile), "../..")

export const BROWSER_BUILTIN_PLUGIN_IDS = [
  "cognia-office",
  "cognia-pdf",
  "cognia-documents",
  "cognia-presentations",
  "cognia-visualize",
]

const sharedModules = [
  "react",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "@cognia/plugin-sdk",
  "@cognia/plugin-ui",
  "lucide-react",
]

// Every published SDK subpath is host-shared (`lib/plugin/core/sdk-subpath-loaders.ts`):
// most are registries, and an inlined copy registers into a Map the host never reads.
const SDK_SUBPATH_PREFIX = "@cognia/plugin-sdk/"

function rejectHostPrivateImports() {
  return {
    name: "reject-host-private-imports",
    setup(buildApi) {
      buildApi.onResolve({ filter: /^@\// }, (args) => ({
        errors: [
          {
            text:
              `Browser builtin ${args.importer} imports host-private module ${args.path}. ` +
              "Use @cognia/plugin-ui or a permission-checked PluginContext capability.",
          },
        ],
      }))
    },
  }
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex")
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

async function buildPlugin(pluginId, { root, publicRoot, pdfWorkerUrl, bundle }) {
  const pluginRoot = path.join(root, "plugins", pluginId)
  const manifest = JSON.parse(await readFile(path.join(pluginRoot, "plugin.json"), "utf8"))
  const result = await bundle({
    absWorkingDir: root,
    bundle: true,
    define:
      pluginId === "cognia-pdf"
        ? { __COGNIA_PDF_WORKER_URL__: JSON.stringify(pdfWorkerUrl) }
        : undefined,
    entryPoints: [path.join(pluginRoot, "src/index.ts")],
    external: [...sharedModules, `${SDK_SUBPATH_PREFIX}*`],
    format: "cjs",
    legalComments: "none",
    metafile: true,
    minify: true,
    outdir: path.join(root, ".codex-tmp/browser-builtin-build", pluginId),
    platform: "browser",
    plugins: [rejectHostPrivateImports()],
    sourcemap: false,
    target: ["es2022"],
    treeShaking: true,
    write: false,
  })

  const javascript = result.outputFiles?.find((file) => file.path.endsWith(".js"))
  if (!javascript) throw new Error(`No JavaScript output produced for ${pluginId}`)

  const digest = sha256(javascript.contents)
  const pluginOutputRoot = path.join(publicRoot, pluginId)
  const outputs = [path.join(pluginOutputRoot, `${digest}.cjs`)]
  writeIfChanged(outputs[0], javascript.contents)

  const stylesheet = result.outputFiles?.find((file) => file.path.endsWith(".css"))
  let stylesUrl
  if (stylesheet) {
    const stylesDigest = sha256(stylesheet.contents)
    const stylesheetPath = path.join(pluginOutputRoot, `${stylesDigest}.css`)
    outputs.push(stylesheetPath)
    writeIfChanged(stylesheetPath, stylesheet.contents)
    stylesUrl = `/_cognia/builtin-plugins/${pluginId}/${stylesDigest}.css`
  }

  const externalImports = new Set()
  for (const output of Object.values(result.metafile?.outputs ?? {})) {
    for (const imported of output.imports ?? []) {
      if (
        imported.external &&
        (sharedModules.includes(imported.path) || imported.path.startsWith(SDK_SUBPATH_PREFIX))
      ) {
        externalImports.add(imported.path)
      }
    }
  }

  return {
    inputs: Object.keys(result.metafile.inputs),
    outputs,
    entry: {
      manifest,
      path: `builtin://${pluginId}`,
      compatibilityDiagnostics: [],
      asset: {
        url: `/_cognia/builtin-plugins/${pluginId}/${digest}.cjs`,
        sha256: digest,
        sharedModules: [...externalImports].sort(),
        ...(stylesUrl ? { stylesUrl } : {}),
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
    entries[pluginId] = result.entry
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
