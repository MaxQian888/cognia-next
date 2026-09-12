import { build } from "esbuild"
import { writeFile, mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import JSZip from "jszip"

const root = dirname(fileURLToPath(import.meta.url))
await mkdir(join(root, "dist"), { recursive: true })
// The runtime supplies the public SDK. Bundling it would duplicate the host capability layer.
await build({
  entryPoints: [join(root, "src/index.ts")],
  outfile: join(root, "dist/index.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  external: ["@cognia/plugin-sdk"],
  sourcemap: true,
})
const pluginModule = await import(join(root, "dist/index.js"))
await writeFile(join(root, "plugin.json"), JSON.stringify(pluginModule.manifest, null, 2) + "\n")
if (process.argv.includes("--pack")) {
  const { readFile } = await import("node:fs/promises")
  const zip = new JSZip()
  for (const path of ["plugin.json", "dist/index.js", "README.md"])
    zip.file(path, await readFile(join(root, path)), { date: new Date("1980-01-01T00:00:00.000Z") })
  await writeFile(
    join(root, "github-devin-bot.zip"),
    await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })
  )
}
