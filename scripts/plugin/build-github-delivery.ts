import { readFile, mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { build } from "esbuild"
import JSZip from "jszip"
import { manifest } from "../../plugins/github-delivery/src/index"

const root = resolve(process.cwd())
const pluginRoot = resolve(root, "plugins/github-delivery")
const manifestPath = resolve(pluginRoot, "plugin.json")
const bundlePath = resolve(pluginRoot, "dist/index.js")
const archivePath = resolve(
  root,
  `packages/plugin-sdk/contract/compat/${manifest.id}-${manifest.version}.zip`
)
const check = process.argv.includes("--check")

async function main(): Promise<void> {
  const buildResult = await build({
    entryPoints: [resolve(pluginRoot, "src/index.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: true,
    banner: { js: "/* eslint-disable @typescript-eslint/no-unused-expressions */" },
    sourcemap: false,
    write: false,
  })
  const bundle = buildResult.outputFiles[0]?.contents
  if (!bundle) throw new Error("github-delivery esbuild produced no output")
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)

  const archive = new JSZip()
  const deterministicDate = new Date("1980-01-01T00:00:00.000Z")
  archive.file("plugin.json", manifestBytes, { date: deterministicDate, createFolders: false })
  archive.file("dist/index.js", bundle, { date: deterministicDate, createFolders: false })
  const archiveBytes = await archive.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "UNIX",
  })

  async function assertMatches(path: string, expected: Uint8Array): Promise<void> {
    const actual = await readFile(path).catch(() => undefined)
    if (!actual || !actual.equals(Buffer.from(expected))) {
      throw new Error(
        `${path} is stale; run: pnpm exec tsx scripts/plugin/build-github-delivery.ts`
      )
    }
  }

  if (check) {
    await assertMatches(manifestPath, manifestBytes)
    await assertMatches(bundlePath, bundle)
    await assertMatches(archivePath, archiveBytes)
  } else {
    await mkdir(resolve(pluginRoot, "dist"), { recursive: true })
    await mkdir(resolve(root, "packages/plugin-sdk/contract/compat"), { recursive: true })
    await writeFile(manifestPath, manifestBytes)
    await writeFile(bundlePath, bundle)
    await writeFile(archivePath, archiveBytes)
  }
}

void main()
