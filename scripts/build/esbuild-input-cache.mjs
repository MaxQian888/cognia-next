// Content fingerprints for the two frontend esbuild generators. Match the
// artifact-runtime generator's metafile-input/output hashing, including config.
import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, statSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { parse } from "jsonc-parser"
import writeFileAtomic from "write-file-atomic"
import { sha256, hashSources } from "./build-artifact-runtime.mjs"

const self = fileURLToPath(import.meta.url)
const require = createRequire(import.meta.url)
const compilerPackage = require.resolve("esbuild/package.json")
const artifactHelpers = fileURLToPath(new URL("./build-artifact-runtime.mjs", import.meta.url))

export function readOptional(file) {
  try {
    return readFileSync(file)
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null
    throw error
  }
}

export function readBuildCache(file) {
  const bytes = readOptional(file)
  try {
    return bytes ? JSON.parse(bytes) : null
  } catch {
    return null
  }
}

export function writeIfChanged(file, bytes) {
  const content = Buffer.from(bytes)
  if (readOptional(file)?.equals(content)) return false
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileAtomic.sync(file, content)
  return true
}

function directoryEntries(directory) {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .map(
        (entry) =>
          `${entry.name}:${entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? `link:${readlinkSync(path.join(directory, entry.name))}` : "file"}`
      )
      .sort()
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null
    throw error
  }
}

function configFiles(file, files, visited = new Set()) {
  if (visited.has(file)) return
  visited.add(file)
  files.add(file)
  const contents = readOptional(file)
  if (!contents) return
  const config = parse(contents.toString())
  for (const extension of [config?.extends ?? []].flat()) {
    if (typeof extension !== "string") continue
    try {
      const base =
        extension.startsWith(".") || path.isAbsolute(extension)
          ? path.resolve(path.dirname(file), extension)
          : createRequire(file).resolve(extension)
      configFiles(existsSync(base) ? base : `${base}.json`, files, visited)
    } catch {
      // A previously unresolved config cannot be a cache hit once installed:
      // package manifests and the lock/install state are fingerprinted below.
    }
  }
}

export function captureBuildInputs(root, inputs, extraFiles) {
  const files = new Set([
    self,
    artifactHelpers,
    compilerPackage,
    ...extraFiles.map((file) => path.resolve(root, file)),
    ...[
      "package.json",
      "pnpm-lock.yaml",
      "tsconfig.build.json",
      "node_modules/.modules.yaml",
      "node_modules/.pnpm/lock.yaml",
    ].map((file) => path.join(root, file)),
  ])
  const directories = new Set()
  for (const input of inputs) {
    const file = path.resolve(root, input)
    files.add(file)
    // Detect a new sibling that changes extension/index resolution even when
    // the previously resolved file itself has not changed.
    if (!file.includes(`${path.sep}node_modules${path.sep}`)) directories.add(path.dirname(file))
    let directory = path.dirname(file)
    while (directory === root || directory.startsWith(root + path.sep)) {
      files.add(path.join(directory, "package.json"))
      configFiles(path.join(directory, "tsconfig.json"), files)
      if (directory === root) break
      directory = path.dirname(directory)
    }
  }
  configFiles(path.join(root, "tsconfig.json"), files)
  return {
    files: hashSources([...files], readOptional),
    directories: Object.fromEntries(
      [...directories].sort().map((directory) => [directory, directoryEntries(directory)])
    ),
  }
}

export function isBuildCacheFresh(cache, root, key, requiredOutputs) {
  if (cache?.schema !== 1 || cache.root !== root || cache.key !== key) return false
  if (!cache.inputs?.files || !cache.inputs?.directories || !cache.outputs) return false
  if (
    Object.keys(cache.inputs.files).length === 0 ||
    requiredOutputs.some((file) => typeof cache.outputs[file] !== "string")
  )
    return false
  for (const [file, digest] of Object.entries(cache.inputs.files)) {
    const bytes = readOptional(file)
    if ((bytes ? sha256(bytes) : null) !== digest) return false
  }
  for (const [directory, entries] of Object.entries(cache.inputs.directories)) {
    if (JSON.stringify(directoryEntries(directory)) !== JSON.stringify(entries)) return false
  }
  for (const [file, digest] of Object.entries(cache.outputs)) {
    const bytes = readOptional(file)
    if (!bytes || sha256(bytes) !== digest) return false
  }
  return true
}

export function saveBuildCache(file, { root, key, inputs, extraFiles, outputs, startedAt }) {
  const snapshot = captureBuildInputs(root, inputs, extraFiles)
  // Do not certify an input edited while esbuild was running. The next call
  // retries the build instead of trusting post-build bytes for an older bundle.
  if (
    Object.keys(snapshot.files).some(
      (file) => existsSync(file) && statSync(file).mtimeMs > startedAt
    )
  )
    return false
  writeIfChanged(
    file,
    JSON.stringify(
      { schema: 1, root, key, inputs: snapshot, outputs: hashSources(outputs, readOptional) },
      null,
      2
    ) + "\n"
  )
  return true
}
