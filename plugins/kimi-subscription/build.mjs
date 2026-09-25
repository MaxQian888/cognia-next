import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { build } from "esbuild"
import JSZip from "jszip"

const pluginRoot = dirname(fileURLToPath(import.meta.url))

/** Build the standalone CommonJS entry and the explicitly allowlisted install ZIP. */
export async function buildPlugin({ outputDirectory = resolve(pluginRoot, "dist") } = {}) {
  const manifestBytes = await readFile(resolve(pluginRoot, "plugin.json"))
  const manifest = JSON.parse(manifestBytes.toString("utf8"))
  const result = await build({
    entryPoints: [resolve(pluginRoot, "src/index.ts")],
    bundle: true,
    format: "cjs",
    platform: "neutral",
    target: "es2022",
    // The host loader hands out its own `@cognia/plugin-sdk` instance
    // (`lib/plugin/core/shared-modules.ts`); inlining it would bundle the
    // host's capability layer into a third-party plugin.
    external: ["@cognia/plugin-sdk"],
    write: false,
  })
  const bundle = result.outputFiles[0].contents
  const archive = new JSZip()
  const fileOptions = { date: new Date("1980-01-01T00:00:00Z"), createFolders: false }
  archive.file("plugin.json", manifestBytes, fileOptions)
  archive.file(manifest.main, bundle, fileOptions)
  for (const name of ["README.md", "README.zh-CN.md"]) {
    archive.file(name, await readFile(resolve(pluginRoot, name)), fileOptions)
  }
  const zipBytes = await archive.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })
  await mkdir(outputDirectory, { recursive: true })
  const entryPath = resolve(outputDirectory, "index.js")
  const archivePath = resolve(outputDirectory, `${manifest.id}-${manifest.version}.zip`)
  await writeFile(entryPath, bundle)
  await writeFile(archivePath, zipBytes)
  return { entryPath, archivePath }
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
