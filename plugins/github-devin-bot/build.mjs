import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { runInNewContext } from "node:vm"
import { build } from "esbuild"
import JSZip from "jszip"

const pluginRoot = dirname(fileURLToPath(import.meta.url))

/**
 * The host evaluates an installed entry inside a CommonJS wrapper and hands
 * out its own `@cognia/plugin-sdk` (`lib/plugin/core/shared-modules.ts`), so
 * the bundle is CJS with the SDK external. `definePlugin` and
 * `definePluginManifest` are identity seams; this stand-in lets the build read
 * the module's manifest without loading the host.
 */
const SDK_STANDIN = {
  definePlugin: (definition) => definition,
  definePluginManifest: (manifest) => manifest,
}

/**
 * Bundle the entry. With `manifestBytes`, the entry's `../plugin.json` import
 * resolves to those bytes instead of the file on disk, so the bundle embeds
 * the manifest this build is about to write.
 */
async function bundle(manifestBytes) {
  const manifestPath = join(pluginRoot, "plugin.json")
  const result = await build({
    // Source-path comments in the bundle are relative to this; pin it so the
    // output does not depend on where the build was launched from.
    absWorkingDir: pluginRoot,
    entryPoints: [join(pluginRoot, "src/index.ts")],
    bundle: true,
    format: "cjs",
    platform: "neutral",
    target: "es2022",
    external: ["@cognia/plugin-sdk"],
    write: false,
    plugins: manifestBytes
      ? [
          {
            name: "generated-manifest",
            setup(pluginBuild) {
              pluginBuild.onResolve({ filter: /^\.\.\/plugin\.json$/ }, (args) =>
                resolve(args.resolveDir, args.path) === manifestPath
                  ? { path: manifestPath, namespace: "generated-manifest" }
                  : undefined
              )
              pluginBuild.onLoad({ filter: /.*/, namespace: "generated-manifest" }, () => ({
                contents: manifestBytes,
                loader: "json",
              }))
            },
          },
        ]
      : [],
  })
  return result.outputFiles[0].contents
}

/** Evaluate a bundle the way the host does; any dependency but the SDK fails. */
export function evaluateBundle(code) {
  const pluginModule = { exports: {} }
  runInNewContext(Buffer.from(code).toString("utf8"), {
    module: pluginModule,
    exports: pluginModule.exports,
    require: (id) => {
      if (id === "@cognia/plugin-sdk") return SDK_STANDIN
      throw new Error(`Unexpected runtime dependency: ${id}`)
    },
  })
  return pluginModule.exports
}

/**
 * Regenerate `plugin.json` from the module manifest, write `dist/index.js`,
 * and (with `pack`) the deterministic install ZIP.
 *
 * The entry imports `../plugin.json`, so the bundle is built a second time
 * with the regenerated manifest injected: one run is enough for the packaged
 * JSON, the bundled JSON and the module manifest to agree.
 */
export async function buildPlugin({ outputDirectory = pluginRoot, pack = false } = {}) {
  const manifestPath = join(outputDirectory, "plugin.json")
  const first = evaluateBundle(await bundle())
  const manifestBytes = Buffer.from(`${JSON.stringify(first.manifest, null, 2)}\n`)
  const code = await bundle(manifestBytes)
  await mkdir(outputDirectory, { recursive: true })
  await writeFile(manifestPath, manifestBytes)
  const entryPath = join(outputDirectory, "dist/index.js")
  await mkdir(dirname(entryPath), { recursive: true })
  await writeFile(entryPath, code)
  let archivePath
  if (pack) {
    const zip = new JSZip()
    const date = new Date("1980-01-01T00:00:00.000Z")
    zip.file("plugin.json", manifestBytes, { date, createFolders: false })
    zip.file("dist/index.js", code, { date, createFolders: false })
    zip.file("README.md", await readFile(join(pluginRoot, "README.md")), {
      date,
      createFolders: false,
    })
    archivePath = join(outputDirectory, "github-devin-bot.zip")
    await writeFile(
      archivePath,
      await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })
    )
  }
  return { manifestPath, entryPath, archivePath }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  buildPlugin({ pack: process.argv.includes("--pack") })
    .then(({ archivePath, entryPath }) => {
      console.log(`Built ${archivePath ?? entryPath}`)
    })
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
}
