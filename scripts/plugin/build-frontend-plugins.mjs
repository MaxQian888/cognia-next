#!/usr/bin/env node
/** First-party distribution builder. Author code is evaluated for metadata, never activated. */
import {
  readFile,
  readdir,
  lstat,
  realpath,
  mkdir,
  mkdtemp,
  rename,
  rm,
  chmod,
} from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"
import { build } from "esbuild"
import { register } from "tsx/cjs/api"
import JSZip from "jszip"
import { writeIfChanged } from "../build/esbuild-input-cache.mjs"

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
register()
const requireSource = createRequire(import.meta.url)
const catalog = JSON.parse(
  await readFile(path.join(repository, "packages/plugin-sdk/contract/catalog.json"), "utf8")
)
export const SHARED_MODULES = [
  "react",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "@cognia/plugin-sdk",
  "@cognia/plugin-ui",
  "lucide-react",
]

function relativePath(value) {
  if (
    typeof value !== "string" ||
    !value ||
    /^(?:[a-z]+:|[\\/])/i.test(value) ||
    value.replaceAll("\\", "/").split("/").includes("..")
  )
    throw new Error(`Unsafe plugin path: ${value}`)
  return value.replaceAll("\\", "/").replace(/^\.\//, "")
}

function validateIdentity(manifest) {
  if (
    !/^[a-z0-9][a-z0-9._-]*$/.test(manifest.id ?? "") ||
    !/^[0-9][a-zA-Z0-9.+_-]*$/.test(manifest.version ?? "")
  ) {
    throw new Error("Invalid plugin id or version for distribution")
  }
}

function pathValues(object, expression) {
  const [part, ...rest] = expression.split(".")
  const array = part.endsWith("[]")
  const value = object?.[array ? part.slice(0, -2) : part]
  return (array ? (value ?? []) : [value]).flatMap((item) =>
    rest.length ? pathValues(item, rest.join(".")) : typeof item === "string" ? [item] : []
  )
}

async function exists(file) {
  try {
    await lstat(file)
    return true
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) return false
    throw error
  }
}

async function sourceEntry(pluginRoot, manifest) {
  const candidates = [
    manifest.tsEntry,
    /\.[cm]?[jt]sx?$/.test(manifest.main ?? "") && !manifest.main.startsWith("dist/")
      ? manifest.main
      : undefined,
    "src/index.ts",
    "src/index.tsx",
    "src/main.ts",
    manifest.main,
  ].filter(Boolean)
  for (const candidate of candidates) {
    const source = path.join(pluginRoot, relativePath(candidate))
    if (await exists(source)) return source
  }
  throw new Error(`No frontend source entry in ${pluginRoot}`)
}

export async function buildFrontendPlugin({
  root = repository,
  directory,
  bundle = build,
  pdfWorkerUrl,
  moduleManifest,
} = {}) {
  root = path.resolve(root)
  const pluginRoot = path.join(root, "plugins", relativePath(directory))
  const base = JSON.parse(await readFile(path.join(pluginRoot, "plugin.json"), "utf8"))
  validateIdentity(base)
  const source = await sourceEntry(pluginRoot, base)
  let moduleStyles
  if (!moduleManifest) {
    for (const cached of Object.keys(requireSource.cache)) {
      if (cached.startsWith(`${pluginRoot}${path.sep}`)) delete requireSource.cache[cached]
    }
    // CSS side effects belong to the compiled release, not metadata discovery.
    const previousCssLoader = requireSource.extensions[".css"]
    let imported
    try {
      requireSource.extensions[".css"] = (module) => {
        module.exports = {}
      }
      imported = requireSource(source)
    } finally {
      if (previousCssLoader) requireSource.extensions[".css"] = previousCssLoader
      else delete requireSource.extensions[".css"]
    }
    const definition = imported.default?.default ?? imported.default ?? imported.plugin ?? imported
    moduleManifest = definition.manifest ?? imported.manifest ?? base
    moduleStyles = imported.styles
  }
  if (moduleManifest.id !== base.id) throw new Error(`Plugin identity mismatch in ${directory}`)
  const manifest = JSON.parse(JSON.stringify({ ...base, ...moduleManifest, id: base.id }))
  validateIdentity(manifest)
  const originalManifest = structuredClone(manifest)
  const files = new Map()
  const fileModes = new Map()
  const inputs = new Set([path.join(pluginRoot, "plugin.json"), source])
  const mapping = {
    [manifest.main]: "dist/index.js",
    [path.relative(pluginRoot, source).replaceAll(path.sep, "/")]: "dist/index.js",
  }
  const entries = new Map([[source, "dist/index.js"]])
  for (const contract of catalog.pathFields.filter((field) => field.runtime === "javascript")) {
    for (const value of pathValues(manifest, contract.path)) {
      if (contract.sentinels?.includes(value)) continue
      const relative = relativePath(value)
      if (mapping[value]) continue
      const output = `dist/entries/${relative.replace(/\.[cm]?[jt]sx?$/, "")}.js`
      mapping[value] = output
      entries.set(path.join(pluginRoot, relative), output)
    }
  }
  function normalize(value) {
    if (typeof value === "string") return mapping[value] ?? value
    if (Array.isArray(value)) return value.map(normalize)
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]))
    return value
  }
  const packaged = normalize(manifest)
  delete packaged.tsEntry
  if (manifest.styles && typeof moduleStyles === "string")
    files.set(relativePath(manifest.styles), Buffer.from(moduleStyles))
  async function collect(relative, required = true, origin = pluginRoot) {
    relative = relativePath(relative)
    const sourceFile = path.join(origin, relative)
    if (!(await exists(sourceFile))) {
      if (files.has(relative)) return
      const mirror = path.join(root, "public/plugins", manifest.id)
      if (origin === pluginRoot && (await exists(path.join(mirror, relative))))
        return collect(relative, required, mirror)
      if (!required) return
      throw new Error(`Missing plugin resource ${directory}/${relative}`)
    }
    const actual = await realpath(sourceFile)
    const realRoot = await realpath(origin)
    if (!actual.startsWith(`${realRoot}${path.sep}`))
      throw new Error(`Unsafe plugin path: ${relative}`)
    const info = await lstat(sourceFile)
    if (info.isSymbolicLink()) throw new Error(`Unsafe plugin path (symlink): ${relative}`)
    if (info.isDirectory()) {
      for (const child of (await readdir(sourceFile)).sort()) {
        if (["node_modules", ".git", "__pycache__"].includes(child)) continue
        await collect(`${relative}/${child}`, true, origin)
      }
    } else {
      inputs.add(sourceFile)
      fileModes.set(relative, info.mode & 0o111 ? 0o755 : 0o644)
      if (!files.has(relative)) files.set(relative, await readFile(sourceFile))
    }
  }
  for (const name of ["assets", "public", "locales", "skills", "vendor", "pi", "bin"])
    await collect(name, false)
  for (const contract of catalog.pathFields.filter(
    (field) => field.runtime === "asset" && field.kind !== "contained-only"
  )) {
    for (const value of pathValues(manifest, contract.path)) await collect(value)
  }
  if (
    manifest.icon &&
    /\.(png|svg|webp|jpe?g|gif|avif)$/i.test(manifest.icon) &&
    !/^(?:[a-z]+:|\/)/i.test(manifest.icon)
  )
    await collect(manifest.icon)
  for (const value of manifest.bundle_include ?? []) await collect(value)
  if (manifest.styles && typeof moduleStyles === "string")
    files.set(relativePath(manifest.styles), Buffer.from(moduleStyles))
  // Older first-party themes keep their package data in the public mirror.
  const mirror = path.join(root, "public/plugins", manifest.id)
  if (await exists(mirror))
    for (const child of await readdir(mirror)) {
      if (["dist", "plugin.json"].includes(child)) continue
      await collect(child, true, mirror)
    }
  const define = {}
  if (manifest.id === "cognia-pdf") {
    const workerPath = path.join(root, "node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs")
    const worker = await readFile(workerPath)
    inputs.add(workerPath)
    // A data module has no dependency on the app's public directory or install location.
    define.__COGNIA_PDF_WORKER_URL__ = JSON.stringify(
      pdfWorkerUrl ?? `data:text/javascript;base64,${worker.toString("base64")}`
    )
  }
  const shared = new Set()
  const emittedStyles = []
  for (const [entry, output] of entries) {
    const result = await bundle({
      absWorkingDir: root,
      entryPoints: [entry],
      outfile: path.join(pluginRoot, output),
      bundle: true,
      platform: "browser",
      format: "cjs",
      target: "es2022",
      minify: true,
      sourcemap: false,
      metafile: true,
      write: false,
      define,
      loader: Object.fromEntries(
        [
          ".png",
          ".jpg",
          ".jpeg",
          ".gif",
          ".webp",
          ".svg",
          ".woff",
          ".woff2",
          ".ttf",
          ".otf",
          ".wasm",
        ].map((extension) => [extension, "dataurl"])
      ),
      external: [...SHARED_MODULES, "@cognia/plugin-sdk/*"],
      plugins: [
        {
          name: "reject-host-private-imports",
          setup(api) {
            api.onResolve({ filter: /^@\// }, (args) => ({
              errors: [
                { text: `Plugin imports host-private module ${args.path}; use the public SDK.` },
              ],
            }))
          },
        },
      ],
    })
    for (const input of Object.keys(result.metafile.inputs)) inputs.add(path.resolve(root, input))
    for (const out of Object.values(result.metafile.outputs))
      for (const item of out.imports) if (item.external) shared.add(item.path)
    for (const file of result.outputFiles) {
      const name = path.relative(pluginRoot, file.path).replaceAll(path.sep, "/")
      const bytes = Buffer.from(file.contents)
      if (name.endsWith(".css")) emittedStyles.push(bytes)

      files.set(name, bytes)
    }
  }
  if (emittedStyles.length) {
    const authored = packaged.styles ? files.get(packaged.styles) : undefined
    packaged.styles = "dist/plugin.css"
    files.set(
      packaged.styles,
      Buffer.concat(
        [...(authored ? [authored] : []), ...emittedStyles].flatMap((bytes) => [
          bytes,
          Buffer.from("\n"),
        ])
      )
    )
  }
  {
    let bytes = files.get("dist/index.js")
    {
      // Normalize paths on the live manifest without JSON-roundtripping executable adapters.
      bytes = Buffer.concat([
        bytes,
        Buffer.from(
          `\n;(()=>{const p=${JSON.stringify(packaged)},m=${JSON.stringify(mapping)};const n=v=>typeof v==='string'?(m[v]??v):Array.isArray(v)?v.map(n):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,n(x)])):v;const d=module.exports.default??module.exports.plugin??module.exports;if(d&&typeof d==='object'){d.manifest={...p,...n(d.manifest??{})};delete d.manifest.tsEntry;if(p.styles)d.manifest.styles=p.styles;}})();\n`
        ),
      ])
    }
    files.set("dist/index.js", bytes)
  }
  files.set("plugin.json", Buffer.from(`${JSON.stringify(packaged, null, 2)}\n`))
  return {
    manifest: packaged,
    originalManifest,
    files,
    fileModes,
    inputs: [...inputs],
    sharedModules: [...shared].sort(),
  }
}

export async function writeFrontendPackage(result, outputRoot) {
  validateIdentity(result.manifest)
  const archive = new JSZip()
  const date = new Date("1980-01-01T00:00:00Z")
  await mkdir(outputRoot, { recursive: true })
  const staged = await mkdtemp(path.join(outputRoot, `.${result.manifest.id}-`))
  const destination = path.join(outputRoot, result.manifest.id)
  const backup = `${staged}.previous`
  let backedUp = false
  try {
    for (const [relative, content] of [...result.files].sort(([a], [b]) => a.localeCompare(b))) {
      relativePath(relative)
      writeIfChanged(path.join(staged, relative), content)
      const mode = result.fileModes?.get(relative) ?? 0o644
      await chmod(path.join(staged, relative), mode)
      archive.file(relative, content, { date, createFolders: false, unixPermissions: mode })
    }
    if (await exists(destination)) {
      await rename(destination, backup)
      backedUp = true
    }
    try {
      await rename(staged, destination)
    } catch (error) {
      if (backedUp) {
        await rename(backup, destination)
        backedUp = false
      }
      throw error
    }
  } finally {
    await rm(staged, { recursive: true, force: true })
    if (backedUp) await rm(backup, { recursive: true, force: true })
  }
  const archivePath = path.join(outputRoot, `${result.manifest.id}-${result.manifest.version}.zip`)
  writeIfChanged(
    archivePath,
    await archive.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 9 },
      platform: "UNIX",
    })
  )
  return archivePath
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const requested = process.argv.slice(2)
  const unmatched = new Set(requested)
  const outputRoot = path.join(repository, "dist/plugins")
  await mkdir(outputRoot, { recursive: true })
  for (const directory of (await readdir(path.join(repository, "plugins"))).sort()) {
    const file = path.join(repository, "plugins", directory, "plugin.json")
    if (!(await exists(file))) continue
    const manifest = JSON.parse(await readFile(file, "utf8"))
    if (
      manifest.type !== "frontend" ||
      (requested.length && !requested.includes(directory) && !requested.includes(manifest.id))
    )
      continue
    unmatched.delete(directory)
    unmatched.delete(manifest.id)
    const result = await buildFrontendPlugin({ directory })
    process.stdout.write(`${await writeFrontendPackage(result, outputRoot)}\n`)
  }
  if (unmatched.size) throw new Error(`Unknown frontend plugins: ${[...unmatched].join(", ")}`)
}
