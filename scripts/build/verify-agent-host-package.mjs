import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const TARGETS = {
  "darwin-arm64": {
    packageDir: "agent-host-darwin-arm64",
    executable: "cognia-agent",
    claude: "claude",
  },
  "linux-x64": {
    packageDir: "agent-host-linux-x64",
    executable: "cognia-agent",
    claude: "claude",
  },
  "win32-x64": {
    packageDir: "agent-host-win32-x64",
    executable: "cognia-agent.exe",
    claude: "claude.exe",
  },
}

const REQUIRED_RESOURCES = [
  "sidecar/pi-extension/cognia-pi-extension.ts",
  "sidecar/pi-extension/integrity.json",
  "tree-sitter.wasm",
  "grammars/tree-sitter-python.wasm",
  "grammars/tree-sitter-rust.wasm",
  "grammars/tree-sitter-tsx.wasm",
  "grammars/tree-sitter-typescript.wasm",
]

/**
 * Name of the per-package closure manifest, written next to `package.json` by
 * `package-agent-host.mjs` and enforced here. It lives OUTSIDE `bin/` so it
 * never has to describe itself, and it is listed in each package's `files`
 * array so a consumer of the published tarball can re-verify the payload.
 *
 * Not to be confused with `bin/sidecar/pi-extension/integrity.json`, which
 * pins one source file for Pi (ADR-0119) and is itself covered by this
 * manifest like any other packaged byte.
 */
export const INTEGRITY_MANIFEST = "integrity.json"

/** Bumped when the manifest shape changes; a mismatch is a hard failure. */
export const INTEGRITY_SCHEMA_VERSION = 1

const INTEGRITY_NOTE =
  "SHA-256 of every file under bin/. Regenerate with `pnpm agent:host:package`. " +
  "Verification fails on a changed digest AND on any packaged file this manifest " +
  "does not declare, so a stray artifact cannot ride along unnoticed."

/**
 * Every file under `binRoot`, as sorted POSIX-relative paths.
 *
 * Sorted so the manifest is byte-stable across machines — an unsorted walk
 * would make every rebuild look like a change. Directories are not recorded:
 * an empty directory carries no bytes and npm does not pack one.
 *
 * @param {string} binRoot
 * @returns {string[]}
 */
export function listPackagedFiles(binRoot) {
  /** @type {string[]} */
  const out = []
  /** @param {string} dir @param {string} prefix */
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(path.join(dir, entry.name), relative)
      else out.push(relative)
    }
  }
  if (fs.statSync(binRoot, { throwIfNoEntry: false })?.isDirectory()) walk(binRoot, "")
  return out.sort()
}

/** @param {string} file @returns {{ sha256: string, bytes: number }} */
export function hashFile(file) {
  const contents = fs.readFileSync(file)
  return { sha256: createHash("sha256").update(contents).digest("hex"), bytes: contents.length }
}

/**
 * Build the closure manifest for an already-populated package directory.
 *
 * @param {string} packageRoot
 * @param {string} targetName
 * @returns {{ "//": string, schemaVersion: number, target: string, files: Record<string, { sha256: string, bytes: number }> }}
 */
export function buildIntegrityManifest(packageRoot, targetName) {
  const binRoot = path.join(packageRoot, "bin")
  /** @type {Record<string, { sha256: string, bytes: number }>} */
  const files = {}
  for (const relative of listPackagedFiles(binRoot)) {
    files[relative] = hashFile(path.join(binRoot, relative))
  }
  return {
    "//": INTEGRITY_NOTE,
    schemaVersion: INTEGRITY_SCHEMA_VERSION,
    target: targetName,
    files,
  }
}

/** @param {string} packageRoot @param {object} manifest */
export function writeIntegrityManifest(packageRoot, manifest) {
  const file = path.join(packageRoot, INTEGRITY_MANIFEST)
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)
  return file
}

/**
 * Enforce the manifest against what is actually on disk, in both directions.
 *
 * Three failures, and the third is the one that only a closure check catches:
 *   1. a declared file is missing;
 *   2. a declared file's bytes changed;
 *   3. a packaged file is NOT declared — a stray artifact riding along.
 *
 * @param {string} root repo root, for readable error paths
 * @param {string} packageRoot
 * @param {string} targetName
 */
export function verifyIntegrityManifest(root, packageRoot, targetName) {
  const manifestFile = path.join(packageRoot, INTEGRITY_MANIFEST)
  if (!fs.statSync(manifestFile, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(
      `missing ${path.relative(root, manifestFile)}; run pnpm agent:host:package -- ${targetName}`
    )
  }
  /** @type {{ schemaVersion?: number, target?: string, files?: Record<string, { sha256?: string, bytes?: number }> }} */
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"))
  } catch (cause) {
    throw new Error(`${path.relative(root, manifestFile)} is not valid JSON`, { cause })
  }
  if (manifest.schemaVersion !== INTEGRITY_SCHEMA_VERSION) {
    throw new Error(
      `${path.relative(root, manifestFile)} has schemaVersion ${manifest.schemaVersion ?? "<none>"}, expected ${INTEGRITY_SCHEMA_VERSION}; run pnpm agent:host:package -- ${targetName}`
    )
  }
  if (manifest.target !== targetName) {
    throw new Error(
      `${path.relative(root, manifestFile)} was built for ${manifest.target ?? "<none>"}, not ${targetName}`
    )
  }
  const declared = manifest.files ?? {}
  const declaredPaths = Object.keys(declared)
  if (declaredPaths.length === 0) {
    throw new Error(
      `${path.relative(root, manifestFile)} declares no files; run pnpm agent:host:package -- ${targetName}`
    )
  }

  const binRoot = path.join(packageRoot, "bin")
  const packaged = new Set(listPackagedFiles(binRoot))

  for (const relative of declaredPaths) {
    if (!packaged.has(relative)) {
      throw new Error(`declared file missing from the package: bin/${relative}`)
    }
    const expected = declared[relative]
    const actual = hashFile(path.join(binRoot, relative))
    if (actual.sha256 !== expected.sha256) {
      throw new Error(
        `bin/${relative} does not match the integrity manifest\n` +
          `  expected ${expected.sha256} (${expected.bytes} bytes)\n` +
          `  found    ${actual.sha256} (${actual.bytes} bytes)`
      )
    }
  }

  const undeclared = [...packaged].filter((relative) => !(relative in declared))
  if (undeclared.length > 0) {
    throw new Error(
      `the package contains ${undeclared.length} file(s) the integrity manifest does not declare:\n` +
        undeclared.map((relative) => `  bin/${relative}`).join("\n") +
        `\nrun pnpm agent:host:package -- ${targetName} to re-record, or delete the stray files`
    )
  }
  return declaredPaths.length
}

/** @param {string} root @param {string} file @param {string} purpose */
function requireFile(root, file, purpose) {
  if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`missing ${path.relative(root, file)}; ${purpose}`)
  }
}

/** @param {string} root @param {string} file @param {string} targetName */
function requireExecutable(root, file, targetName) {
  if (targetName !== "win32-x64" && (fs.statSync(file).mode & 0o111) === 0) {
    throw new Error(`${path.relative(root, file)} is not executable`)
  }
}

export function verifyAgentHostPackage(root, targetName) {
  const target = TARGETS[targetName]
  if (!target) throw new Error(`unknown agent host target: ${targetName}`)
  const packageRoot = path.join(root, "packages", target.packageDir)
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"))
  const relativeExecutable = `bin/${target.executable}`
  if (manifest.bin?.["cognia-agent"] !== relativeExecutable) {
    throw new Error(`${target.packageDir} must expose ${relativeExecutable}`)
  }
  if (!manifest.files?.includes(INTEGRITY_MANIFEST)) {
    throw new Error(
      `${target.packageDir} must publish ${INTEGRITY_MANIFEST} — add it to the "files" array, ` +
        `otherwise the tarball ships payload nobody downstream can verify`
    )
  }
  const executable = path.join(packageRoot, relativeExecutable)
  requireFile(
    root,
    executable,
    `run pnpm cli:build:binary and pnpm agent:host:package -- ${targetName}`
  )
  requireExecutable(root, executable, targetName)

  const claude = path.join(packageRoot, "bin", target.claude)
  requireFile(root, claude, "the full agent host requires its adjacent Claude runtime")
  requireExecutable(root, claude, targetName)

  for (const [helperBaseName, purpose] of [
    ["cognia-external-agent-launcher", "external agent dispatch requires its native launcher"],
    [
      "cognia-sandbox-exec",
      "the OS sandbox tier has no implementation on this host without it, and a sandboxed tool call is refused rather than run unconfined",
    ],
    ["cognia-task-workspace-worker", "worker dispatch requires Task Workspace"],
  ]) {
    const helperName = `${helperBaseName}${targetName === "win32-x64" ? ".exe" : ""}`
    const helper = path.join(packageRoot, "bin", helperName)
    requireFile(root, helper, purpose)
    requireExecutable(root, helper, targetName)
  }

  for (const relativeResource of REQUIRED_RESOURCES) {
    requireFile(
      root,
      path.join(packageRoot, "bin", relativeResource),
      "the Bun standalone host requires its adjacent runtime resources"
    )
  }

  // Last, because it is the widest check: the named files above prove the
  // package has what it NEEDS, this proves it has nothing else and that every
  // byte is the byte that was packaged.
  verifyIntegrityManifest(root, packageRoot, targetName)
  return executable
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ""
if (invokedPath === fileURLToPath(import.meta.url)) {
  const root = path.resolve(import.meta.dirname, "../..")
  const targetName = process.argv[2]
  verifyAgentHostPackage(root, targetName)
  process.stdout.write(`verified ${targetName} agent host package\n`)
}
