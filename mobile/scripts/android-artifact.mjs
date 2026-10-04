import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { lstat, readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { MOBILE_ASSET_EXCLUSIONS } from "./mobile-assets.mjs"

export const ARTIFACT_FILE = "cognia-mobile-artifact.json"

async function hashFile(file) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest("hex")
}

async function filesUnder(directory, prefix = "") {
  if (!(await lstat(directory)).isDirectory())
    throw new Error(`Artifact directory is not a real directory: ${directory}`)
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`Artifact contains a symlink: ${relative}`)
    if (entry.isDirectory())
      files.push(...(await filesUnder(path.join(directory, entry.name), relative)))
    else if (entry.isFile() && relative !== ARTIFACT_FILE) files.push(relative)
  }
  return files.sort()
}

export async function stampArtifact(directory, inputDigest) {
  const files = {}
  for (const relative of await filesUnder(directory))
    files[relative] = await hashFile(path.join(directory, relative))
  if (!files["index.html"]) throw new Error("Mobile export is missing index.html")
  const artifact = { version: 1, platform: "mobile", inputDigest, files }
  await writeFile(path.join(directory, ARTIFACT_FILE), `${JSON.stringify(artifact)}\n`)
  return artifact
}

export async function verifyArtifact(directory, inputDigest) {
  let artifact
  try {
    artifact = JSON.parse(await readFile(path.join(directory, ARTIFACT_FILE), "utf8"))
  } catch {
    throw new Error(
      `Missing mobile artifact provenance in ${directory}; run mobile:build:android first`
    )
  }
  if (
    artifact.version !== 1 ||
    artifact.platform !== "mobile" ||
    !artifact.files?.["index.html"] ||
    !artifact.inputDigest
  ) {
    throw new Error(`Invalid mobile artifact provenance in ${directory}`)
  }
  if (artifact.inputDigest !== inputDigest)
    throw new Error("Mobile web artifact is stale; rebuild with mobile:build:android")
  const actual = await filesUnder(directory)
  const generatedByCapacitor = new Set(["cordova.js", "cordova_plugins.js"])
  for (const relative of actual) {
    if (!(relative in artifact.files) && !generatedByCapacitor.has(relative))
      throw new Error(`Unexpected mobile artifact file: ${relative}`)
  }
  for (const [relative, digest] of Object.entries(artifact.files)) {
    if (
      !relative ||
      path.isAbsolute(relative) ||
      relative.includes("\\") ||
      relative.split("/").some((part) => part === ".." || part === ".")
    ) {
      throw new Error("Invalid mobile artifact path")
    }
    const file = path.join(directory, relative)
    if (!(await lstat(file)).isFile() || (await hashFile(file)) !== digest)
      throw new Error(`Mobile artifact mismatch: ${relative}`)
  }
  return artifact
}

/** Hash actual tracked/untracked build inputs, including local env files without recording their values. */
export async function sourceFingerprint(root, run, env) {
  const listed = await run(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root, capture: true }
  )
  const roots =
    /^(app|components|hooks|lib|stores|types|packages|i18n|public|generated|skills\/built-in|plugins|docs\/content\/docs|scripts\/build|scripts\/mobile|scripts\/i18n)\//
  const config =
    /^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|next\.config\.[^/]+|tsconfig[^/]*\.json|postcss\.config\.[^/]+|\.browserslistrc|\.npmrc|browserslist)$/
  const files = new Set(
    listed
      .split("\0")
      .filter(
        (file) =>
          (roots.test(file) || config.test(file)) && !/\.(test|spec|stories)\.[^/]+$/.test(file)
      )
  )
  for (const entry of await readdir(root)) if (/^\.env(?:\.|$)/.test(entry)) files.add(entry)
  const hash = createHash("sha256")
  // Packaging policy changes invalidate old exports. Keep source assets in the input hash:
  // authoring manifests or future static imports can turn them into generated build inputs.
  hash.update(JSON.stringify(MOBILE_ASSET_EXCLUSIONS)).update("\0")
  for (const relative of [...files].sort()) {
    hash.update(relative).update("\0")
    try {
      hash.update(await hashFile(path.join(root, relative)))
    } catch (error) {
      if (error.code === "ENOENT") hash.update("deleted")
      else throw error
    }
    hash.update("\0")
  }
  const buildEnv = Object.fromEntries(
    Object.entries(env)
      .filter(
        ([key]) =>
          key.startsWith("NEXT_PUBLIC_") &&
          key !== "NEXT_PUBLIC_BUILD_TIME" &&
          key !== "NEXT_PUBLIC_GIT_COMMIT"
      )
      .sort(([a], [b]) => a.localeCompare(b))
  )
  hash.update(JSON.stringify(buildEnv))
  return hash.digest("hex")
}

export async function verifyOfflineConfig(file) {
  const config = JSON.parse(await readFile(file, "utf8"))
  if (
    config.server?.url ||
    config.server?.cleartext ||
    config.android?.webContentsDebuggingEnabled
  ) {
    throw new Error(
      "Native assets contain live-reload configuration; run mobile:sync:android before packaging offline"
    )
  }
  if (config.appId !== "com.cognia.mobile")
    throw new Error("Unexpected Android application identity")
}
