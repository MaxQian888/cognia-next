import { mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { build, type Plugin } from "esbuild"
import JSZip from "jszip"
import { manifest } from "../../plugins/github-delivery/src/index"

export interface GithubDeliveryPaths {
  root: string
  manifestPath: string
  bundlePath: string
  archivePath: string
}

export interface GithubDeliveryArtifacts {
  manifestBytes: Buffer
  bundle: Uint8Array
  archiveBytes: Buffer
}

export function githubDeliveryPaths(root = resolve(process.cwd())): GithubDeliveryPaths {
  const pluginRoot = resolve(root, "plugins/github-delivery")
  return {
    root,
    manifestPath: resolve(pluginRoot, "plugin.json"),
    bundlePath: resolve(pluginRoot, "dist/index.js"),
    archivePath: resolve(
      root,
      `packages/plugin-sdk/contract/compat/${manifest.id}-${manifest.version}.zip`
    ),
  }
}

const DETERMINISTIC_DATE = new Date("1980-01-01T00:00:00.000Z")

/**
 * Build the bundle, the regenerated `plugin.json` and the install ZIP in
 * memory.
 *
 * CommonJS with `@cognia/plugin-sdk` external: the host evaluates an installed
 * entry inside a CJS wrapper and hands out its own SDK instance
 * (`lib/plugin/core/loader.ts` → `evaluatePluginCode`, `shared-modules.ts`).
 * An ESM bundle's `export` statements are a syntax error in that wrapper, and
 * an inlined SDK would drag the host's capability layer into the plugin.
 */
export async function buildGithubDeliveryArtifacts(
  paths: GithubDeliveryPaths = githubDeliveryPaths()
): Promise<GithubDeliveryArtifacts> {
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
  // The entry imports `../plugin.json`; feed it the manifest this build is
  // about to write rather than whatever is on disk, so one build is enough for
  // `--check` to pass even when a TypeScript-derived contribution changed.
  const generatedManifest: Plugin = {
    name: "github-delivery-generated-manifest",
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: /^\.\.\/plugin\.json$/ }, (args) =>
        resolve(args.resolveDir, args.path) === paths.manifestPath
          ? { path: paths.manifestPath, namespace: "github-delivery-manifest" }
          : undefined
      )
      pluginBuild.onLoad({ filter: /.*/, namespace: "github-delivery-manifest" }, () => ({
        contents: manifestBytes,
        loader: "json",
      }))
    },
  }
  const buildResult = await build({
    entryPoints: [resolve(paths.root, "plugins/github-delivery/src/index.ts")],
    bundle: true,
    format: "cjs",
    platform: "neutral",
    target: "es2022",
    minify: true,
    external: ["@cognia/plugin-sdk"],
    banner: { js: "/* eslint-disable @typescript-eslint/no-unused-expressions */" },
    sourcemap: false,
    write: false,
    plugins: [generatedManifest],
  })
  const bundle = buildResult.outputFiles[0]?.contents
  if (!bundle) throw new Error("github-delivery esbuild produced no output")

  const archive = new JSZip()
  archive.file("plugin.json", manifestBytes, { date: DETERMINISTIC_DATE, createFolders: false })
  archive.file(manifest.main ?? "dist/index.js", bundle, {
    date: DETERMINISTIC_DATE,
    createFolders: false,
  })
  const archiveBytes = await archive.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "UNIX",
  })
  return { manifestBytes, bundle, archiveBytes }
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"))
  } catch {
    return Symbol("unparseable")
  }
}

/**
 * Deep equality over parsed JSON values, ignoring key order. `plugin.json` is
 * reformatted by prettier on commit, so its bytes never match
 * `JSON.stringify` output even when the manifest is identical — the check
 * compares what the file means, not how it is laid out.
 */
export function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (typeof left !== "object" || typeof right !== "object" || !left || !right) return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((item, index) => jsonEqual(item, right[index]))
    )
  }
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord).sort()
  const rightKeys = Object.keys(rightRecord).sort()
  return (
    jsonEqual(leftKeys, rightKeys) &&
    leftKeys.every((key) => jsonEqual(leftRecord[key], rightRecord[key]))
  )
}

/** Compare a ZIP by entry: `plugin.json` by parsed JSON, everything else by bytes. */
export async function archivesEquivalent(
  actual: Uint8Array,
  expected: Uint8Array
): Promise<boolean> {
  const [left, right] = await Promise.all([JSZip.loadAsync(actual), JSZip.loadAsync(expected)])
  const names = (zip: JSZip) =>
    Object.values(zip.files)
      .filter((entry) => !entry.dir)
      .map((entry) => entry.name)
      .sort()
  const leftNames = names(left)
  if (!jsonEqual(leftNames, names(right))) return false
  for (const name of leftNames) {
    const [leftBytes, rightBytes] = await Promise.all([
      left.file(name)!.async("uint8array"),
      right.file(name)!.async("uint8array"),
    ])
    if (name.endsWith(".json")) {
      if (!jsonEqual(parseJson(leftBytes), parseJson(rightBytes))) return false
    } else if (!Buffer.from(leftBytes).equals(Buffer.from(rightBytes))) {
      return false
    }
  }
  return true
}

/** Paths whose on-disk content disagrees with a fresh build. Empty means in sync. */
export async function findStaleArtifacts(
  paths: GithubDeliveryPaths,
  artifacts: GithubDeliveryArtifacts
): Promise<string[]> {
  const read = (path: string) => readFile(path).catch(() => undefined)
  const [manifestOnDisk, bundleOnDisk, archiveOnDisk] = await Promise.all([
    read(paths.manifestPath),
    read(paths.bundlePath),
    read(paths.archivePath),
  ])
  const stale: string[] = []
  if (!manifestOnDisk || !jsonEqual(parseJson(manifestOnDisk), parseJson(artifacts.manifestBytes)))
    stale.push(paths.manifestPath)
  if (!bundleOnDisk || !bundleOnDisk.equals(Buffer.from(artifacts.bundle)))
    stale.push(paths.bundlePath)
  if (!archiveOnDisk || !(await archivesEquivalent(archiveOnDisk, artifacts.archiveBytes)))
    stale.push(paths.archivePath)
  return stale
}

export async function writeGithubDeliveryArtifacts(
  paths: GithubDeliveryPaths,
  artifacts: GithubDeliveryArtifacts
): Promise<void> {
  await mkdir(resolve(paths.bundlePath, ".."), { recursive: true })
  await mkdir(resolve(paths.archivePath, ".."), { recursive: true })
  await writeFile(paths.manifestPath, artifacts.manifestBytes)
  await writeFile(paths.bundlePath, artifacts.bundle)
  await writeFile(paths.archivePath, artifacts.archiveBytes)
}

async function main(): Promise<void> {
  const paths = githubDeliveryPaths()
  const artifacts = await buildGithubDeliveryArtifacts(paths)
  if (!process.argv.includes("--check")) {
    await writeGithubDeliveryArtifacts(paths, artifacts)
    return
  }
  const stale = await findStaleArtifacts(paths, artifacts)
  if (stale.length) {
    throw new Error(
      `${stale.join(", ")} ${stale.length === 1 ? "is" : "are"} stale; run: pnpm exec tsx scripts/plugin/build-github-delivery.ts`
    )
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
