#!/usr/bin/env node

import { createHash } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { build } from "esbuild"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const publicRoot = path.join(root, "public/_cognia/builtin-plugins")
const generatedIndexPath = path.join(
  root,
  "lib/plugin/core/browser-builtin-assets.generated.json"
)

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

async function writeAtomic(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${process.pid}.tmp`
  await writeFile(temporaryPath, content)
  await rename(temporaryPath, filePath)
}

async function preparePdfWorker() {
  const source = path.join(root, "node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs")
  const contents = await readFile(source)
  const digest = sha256(contents)
  const outputRoot = path.join(publicRoot, "_shared")
  await mkdir(outputRoot, { recursive: true })
  await writeFile(path.join(outputRoot, `pdf.worker.${digest}.mjs`), contents)
  return `/_cognia/builtin-plugins/_shared/pdf.worker.${digest}.mjs`
}

async function buildPlugin(pluginId, { pdfWorkerUrl }) {
  const pluginRoot = path.join(root, "plugins", pluginId)
  const manifest = JSON.parse(await readFile(path.join(pluginRoot, "plugin.json"), "utf8"))
  const result = await build({
    absWorkingDir: root,
    bundle: true,
    define:
      pluginId === "cognia-pdf"
        ? { __COGNIA_PDF_WORKER_URL__: JSON.stringify(pdfWorkerUrl) }
        : undefined,
    entryPoints: [path.join(pluginRoot, "src/index.ts")],
    external: sharedModules,
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
  await mkdir(pluginOutputRoot, { recursive: true })
  await writeFile(path.join(pluginOutputRoot, `${digest}.cjs`), javascript.contents)

  const stylesheet = result.outputFiles?.find((file) => file.path.endsWith(".css"))
  let stylesUrl
  if (stylesheet) {
    const stylesDigest = sha256(stylesheet.contents)
    await writeFile(path.join(pluginOutputRoot, `${stylesDigest}.css`), stylesheet.contents)
    stylesUrl = `/_cognia/builtin-plugins/${pluginId}/${stylesDigest}.css`
  }

  const externalImports = new Set()
  for (const output of Object.values(result.metafile?.outputs ?? {})) {
    for (const imported of output.imports ?? []) {
      if (imported.external && sharedModules.includes(imported.path)) {
        externalImports.add(imported.path)
      }
    }
  }

  return {
    manifest,
    path: `builtin://${pluginId}`,
    compatibilityDiagnostics: [],
    asset: {
      url: `/_cognia/builtin-plugins/${pluginId}/${digest}.cjs`,
      sha256: digest,
      sharedModules: [...externalImports].sort(),
      ...(stylesUrl ? { stylesUrl } : {}),
    },
  }
}

export async function buildBrowserBuiltinPlugins() {
  await rm(publicRoot, { recursive: true, force: true })
  const pdfWorkerUrl = await preparePdfWorker()
  const entries = {}
  for (const pluginId of BROWSER_BUILTIN_PLUGIN_IDS) {
    entries[pluginId] = await buildPlugin(pluginId, { pdfWorkerUrl })
  }

  await writeAtomic(
    generatedIndexPath,
    `${JSON.stringify({ version: 1, entries }, null, 2)}\n`
  )
  return entries
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const entries = await buildBrowserBuiltinPlugins()
  process.stdout.write(`Built ${Object.keys(entries).length} browser builtin plugin assets.\n`)
}
