import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { build } from "esbuild"
import JSZip from "jszip"

const pluginRoot = dirname(fileURLToPath(import.meta.url))

/**
 * Source → installed file. `main` / `runtimeCompatibility.*.entrypoint` point at
 * `dist/index.js`; the lazy factory the manifest names by `entry` is its own
 * bundle, because the host imports it separately on enable.
 */
export const ENTRIES = {
  "dist/index.js": "src/index.ts",
  "dist/context-provider.js": "src/context-provider.ts",
}

/**
 * Build the standalone CommonJS entries and the install ZIP.
 *
 * The host evaluates each installed entry in a CommonJS wrapper and supplies
 * `@cognia/plugin-sdk` and every published `@cognia/plugin-sdk/<subpath>`
 * itself (`lib/plugin/core/shared-modules.ts`), so those stay external;
 * everything else is inlined.
 */
export async function buildPlugin({ outputDirectory = pluginRoot } = {}) {
  const manifestBytes = await readFile(resolve(pluginRoot, "plugin.json"))
  const manifest = JSON.parse(manifestBytes.toString("utf8"))
  const archive = new JSZip()
  const fileOptions = { date: new Date("1980-01-01T00:00:00Z"), createFolders: false }
  archive.file("plugin.json", manifestBytes, fileOptions)
  const entryPaths = {}
  for (const [output, source] of Object.entries(ENTRIES)) {
    const result = await build({
      // Source-path comments are relative to this; pin it so the output does
      // not depend on where the build was launched from.
      absWorkingDir: pluginRoot,
      entryPoints: [resolve(pluginRoot, source)],
      bundle: true,
      format: "cjs",
      platform: "neutral",
      target: "es2022",
      external: ["@cognia/plugin-sdk", "@cognia/plugin-sdk/*"],
      write: false,
    })
    const bundle = result.outputFiles[0].contents
    archive.file(output, bundle, fileOptions)
    const entryPath = resolve(outputDirectory, output)
    await mkdir(dirname(entryPath), { recursive: true })
    await writeFile(entryPath, bundle)
    entryPaths[output] = entryPath
  }
  const zipBytes = await archive.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })
  const archivePath = resolve(outputDirectory, "dist", `${manifest.id}-${manifest.version}.zip`)
  await writeFile(archivePath, zipBytes)
  return { entryPaths, archivePath }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  buildPlugin()
    .then(({ archivePath }) => {
      console.log(`Built ${archivePath}`)
    })
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
}
