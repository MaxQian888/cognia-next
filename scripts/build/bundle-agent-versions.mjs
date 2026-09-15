#!/usr/bin/env node

/**
 * The agent bundle's pins (ADR-0183).
 *
 * `deploy/bundle/agent-versions.json` says what the `cognia-agent-bundle` image
 * contains; `deploy/bundle/npm/package{,-lock}.json` pins the npm half with an
 * integrity hash per package. This script is the only reader:
 *
 *   check       the pins, the npm lock, the runtime catalog, the Dockerfile
 *               ARGs and the supervisor's injection root agree
 *   fill-integrity
 *               adds registry integrity to lock entries a shrinkwrap left
 *               without one (run after regenerating the lock)
 *   commands    lists the commands a tree must answer --version for
 *   manifest    writes bundle-manifest.json for one architecture
 *   fetch-tool  downloads git or ripgrep and verifies the vendor sha256
 *   stage       builds one libc tree inside a Dockerfile stage: the Node
 *               runtime, allowlisted install scripts, command shims, verified
 *               vendor binaries, and a smoke run of every command
 *
 * The pins are a bundle lock, not a certification. They never touch
 * `certifiedVersions` in protocol/external-agent-runtimes.json: on a desktop a
 * certified version runs without consent, and bundling a version is not a
 * claim that it was certified.
 */

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  chmodSync,
  closeSync,
  copyFileSync,
  createWriteStream,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { fileURLToPath } from "node:url"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..")

/** `crates/cognia-sandboxd/src/layout.rs` `INJECTION_ROOT`; `check` holds them together. */
export const INJECTION_ROOT = "/cognia"
export const ARCHES = ["amd64", "arm64"]
export const LIBCS = ["glibc", "musl"]
export const SMOKE_KINDS = ["version", "syntax"]

export const PATHS = {
  pins: "deploy/bundle/agent-versions.json",
  packageJson: "deploy/bundle/npm/package.json",
  lock: "deploy/bundle/npm/package-lock.json",
  dockerfile: "deploy/bundle/Dockerfile",
  catalog: "protocol/external-agent-runtimes.json",
  layout: "crates/cognia-sandboxd/src/layout.rs",
}

const SHA256 = /^[0-9a-f]{64}$/
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const GLIBC_VERSION = /^2\.\d{1,3}$/
const RUNTIME_ID = /^[a-z0-9][a-z0-9-]*$/
const COMMAND_NAME = /^[a-z0-9][a-z0-9._-]*$/
/** The machine name each architecture has in a musl loader's file name. */
const MUSL_MACHINE = { amd64: "x86_64", arm64: "aarch64" }

// ─────────────────────────────────────────────────────────────────────────────
// check
// ─────────────────────────────────────────────────────────────────────────────

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function checkAsset(asset, where, problems) {
  if (!isRecord(asset)) {
    problems.push(`${where} must be an object with url and sha256`)
    return
  }
  if (typeof asset.url !== "string" || !asset.url.startsWith("https://")) {
    problems.push(`${where}.url must be an https URL`)
  }
  if (typeof asset.sha256 !== "string" || !SHA256.test(asset.sha256)) {
    problems.push(`${where}.sha256 must be 64 lowercase hex digits`)
  }
}

/**
 * Every disagreement between the pins and the files that must match them.
 * Pure: the caller reads the files.
 */
export function validatePins({ pins, packageJson, lock, catalog, dockerfile, layoutRs }) {
  const problems = []
  if (!isRecord(pins) || pins.version !== 1) {
    return ["agent-versions.json: version must be 1"]
  }

  // Node, and the Dockerfile ARGs its FROM lines read.
  if (!EXACT_VERSION.test(String(pins.node?.version))) {
    problems.push("node.version must be an exact version")
  }
  if (!/^\d+\.\d+$/.test(String(pins.node?.alpine))) {
    problems.push("node.alpine must be an Alpine release such as 3.24")
  }
  if (!GLIBC_VERSION.test(String(pins.node?.minGlibc))) {
    problems.push("node.minGlibc must be a glibc release such as 2.28")
  }
  for (const [arg, expected] of [
    ["NODE_VERSION", pins.node?.version],
    ["ALPINE_VERSION", pins.node?.alpine],
  ]) {
    const match = String(dockerfile ?? "").match(new RegExp(`^ARG ${arg}=(\\S+)\\s*$`, "m"))
    if (!match) {
      problems.push(`${PATHS.dockerfile} must declare ARG ${arg}=${expected}`)
    } else if (match[1] !== expected) {
      problems.push(`${PATHS.dockerfile} ARG ${arg}=${match[1]} disagrees with the pin ${expected}`)
    }
  }
  if (!String(layoutRs ?? "").includes(`pub const INJECTION_ROOT: &str = "${INJECTION_ROOT}";`)) {
    problems.push(`${PATHS.layout} INJECTION_ROOT is no longer "${INJECTION_ROOT}"`)
  }

  // Tools.
  const git = pins.tools?.git
  if (!EXACT_VERSION.test(String(git?.version))) problems.push("tools.git.version must be exact")
  checkAsset(git, "tools.git", problems)
  const curl = pins.tools?.curl
  if (!EXACT_VERSION.test(String(curl?.version))) problems.push("tools.curl.version must be exact")
  for (const key of ["url", "signatureUrl", "keyUrl"]) {
    if (typeof curl?.[key] !== "string" || !curl[key].startsWith("https://")) {
      problems.push(`tools.curl.${key} must be an https URL`)
    }
  }
  if (!/^[0-9A-F]{40}$/.test(String(curl?.signingKey))) {
    problems.push("tools.curl.signingKey must be a 40-digit uppercase key fingerprint")
  }
  const ripgrep = pins.tools?.ripgrep
  if (!EXACT_VERSION.test(String(ripgrep?.version))) {
    problems.push("tools.ripgrep.version must be exact")
  }
  for (const arch of ARCHES) checkAsset(ripgrep?.assets?.[arch], `tools.ripgrep.assets.${arch}`, problems)

  // The npm lock.
  const dependencies = packageJson?.dependencies ?? {}
  for (const [name, version] of Object.entries(dependencies)) {
    if (!EXACT_VERSION.test(version)) {
      problems.push(`${PATHS.packageJson}: ${name} is ${version}, not an exact version`)
    }
  }
  if (lock?.lockfileVersion !== 3) {
    problems.push(`${PATHS.lock}: lockfileVersion must be 3 (regenerate with npm 10+)`)
  }
  const lockPackages = lock?.packages ?? {}
  const lockRoot = lockPackages[""]?.dependencies ?? {}
  if (JSON.stringify(sortKeys(lockRoot)) !== JSON.stringify(sortKeys(dependencies))) {
    problems.push(`${PATHS.lock} was not generated from ${PATHS.packageJson}; regenerate it`)
  }
  for (const [name, version] of Object.entries(dependencies)) {
    const entry = lockPackages[`node_modules/${name}`]
    if (!entry) {
      problems.push(`${PATHS.lock} has no node_modules/${name}`)
    } else if (entry.version !== version) {
      problems.push(`${PATHS.lock} resolves ${name} to ${entry.version}, not ${version}`)
    }
  }
  for (const [path, entry] of Object.entries(lockPackages)) {
    if (path === "" || entry.link || entry.inBundle) continue
    if (typeof entry.resolved !== "string" || !entry.resolved.startsWith("https://registry.npmjs.org/")) {
      problems.push(`${PATHS.lock}: ${path} does not resolve from registry.npmjs.org over https`)
    }
    if (typeof entry.integrity !== "string" || !entry.integrity.startsWith("sha512-")) {
      problems.push(`${PATHS.lock}: ${path} has no sha512 integrity`)
    }
  }

  // Install scripts run only for an explicit allowlist.
  for (const [name, reason] of Object.entries(pins.installScripts ?? {})) {
    if (!(name in dependencies)) {
      problems.push(`installScripts.${name} is not a pinned npm dependency`)
    } else if (!lockPackages[`node_modules/${name}`]?.hasInstallScript) {
      problems.push(`installScripts.${name} has no install script to allow`)
    }
    if (typeof reason !== "string" || !reason.trim()) {
      problems.push(`installScripts.${name} must say why its script is allowed`)
    }
  }

  // Runtimes: every catalog runtime is accounted for, one way or the other.
  const catalogIds = new Set((catalog?.runtimes ?? []).map((runtime) => runtime.runtimeId))
  const seen = new Set()
  const commandDefinitions = new Map()
  for (const [index, runtime] of (pins.runtimes ?? []).entries()) {
    const where = `runtimes[${index}]`
    if (!isRecord(runtime) || typeof runtime.id !== "string" || !RUNTIME_ID.test(runtime.id)) {
      problems.push(`${where}.id must be a runtime id`)
      continue
    }
    if (seen.has(runtime.id)) problems.push(`${where}: ${runtime.id} is listed twice`)
    seen.add(runtime.id)

    if ("unavailable" in runtime) {
      if (typeof runtime.unavailable !== "string" || !runtime.unavailable.trim()) {
        problems.push(`${runtime.id}: unavailable must state the reason`)
      }
      const extra = Object.keys(runtime).filter((key) => key !== "id" && key !== "unavailable")
      if (extra.length > 0) {
        problems.push(`${runtime.id}: an unavailable runtime carries no ${extra.join(", ")}`)
      }
      continue
    }

    if (!catalogIds.has(runtime.id)) {
      problems.push(`${runtime.id} is not in ${PATHS.catalog}; only an unavailable entry may name it`)
    }
    if (!EXACT_VERSION.test(String(runtime.version))) {
      problems.push(`${runtime.id}: version must be exact`)
    }
    const libc = runtime.libc
    if (
      !Array.isArray(libc) ||
      libc.length === 0 ||
      new Set(libc).size !== libc.length ||
      libc.some((value) => !LIBCS.includes(value))
    ) {
      problems.push(`${runtime.id}: libc must list glibc and/or musl once each`)
    }
    if (runtime.minGlibc !== undefined) {
      if (!Array.isArray(libc) || !libc.includes("glibc")) {
        problems.push(`${runtime.id}: minGlibc needs a glibc build`)
      }
      for (const [arch, floor] of Object.entries(runtime.minGlibc)) {
        if (!ARCHES.includes(arch) || !GLIBC_VERSION.test(String(floor))) {
          problems.push(`${runtime.id}: minGlibc.${arch} must be a glibc release per architecture`)
        } else if (compareGlibc(floor, pins.node?.minGlibc) <= 0) {
          problems.push(`${runtime.id}: minGlibc.${arch} ${floor} is not above node.minGlibc`)
        }
      }
    }

    const sources = ["commands", "archive", "binary"].filter((key) => key in runtime)
    if (sources.length !== 1) {
      problems.push(`${runtime.id}: exactly one of commands, archive or binary`)
      continue
    }

    if (runtime.commands) {
      if (!Array.isArray(runtime.commands) || runtime.commands.length === 0) {
        problems.push(`${runtime.id}: commands must not be empty`)
        continue
      }
      const primary = runtime.commands[0]?.package
      if (dependencies[primary] !== runtime.version) {
        problems.push(
          `${runtime.id}: version ${runtime.version} is not ${primary}@${dependencies[primary]} from ${PATHS.packageJson}`
        )
      }
      for (const command of runtime.commands) {
        if (!COMMAND_NAME.test(String(command?.name))) {
          problems.push(`${runtime.id}: command name ${command?.name} is invalid`)
          continue
        }
        if (!(command.package in dependencies)) {
          problems.push(`${runtime.id}: ${command.name} comes from ${command.package}, which is not pinned`)
        }
        if (typeof command.bin !== "string" || !command.bin) {
          problems.push(`${runtime.id}: ${command.name} names no bin`)
        }
        if (!SMOKE_KINDS.includes(command.smoke)) {
          problems.push(`${runtime.id}: ${command.name} smoke must be one of ${SMOKE_KINDS.join(", ")}`)
        }
        const definition = JSON.stringify([command.package, command.bin, command.smoke])
        const previous = commandDefinitions.get(command.name)
        if (previous && previous !== definition) {
          problems.push(`${runtime.id}: command ${command.name} is defined two different ways`)
        }
        commandDefinitions.set(command.name, definition)
      }
      continue
    }

    const download = runtime.archive ?? runtime.binary
    if (!COMMAND_NAME.test(String(download?.command))) {
      problems.push(`${runtime.id}: command name ${download?.command} is invalid`)
    } else if (commandDefinitions.has(download.command)) {
      problems.push(`${runtime.id}: command ${download.command} is already an npm command`)
    }
    if (!SMOKE_KINDS.includes(download?.smoke)) {
      problems.push(`${runtime.id}: smoke must be one of ${SMOKE_KINDS.join(", ")}`)
    }
    const expected = (Array.isArray(libc) ? libc : []).flatMap((value) =>
      ARCHES.map((arch) => `${value}-${arch}`)
    )
    const actual = Object.keys(download?.assets ?? {})
    if (JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort())) {
      problems.push(`${runtime.id}: assets must be exactly ${expected.join(", ")}`)
    }
    for (const key of actual) checkAsset(download.assets[key], `${runtime.id}.assets.${key}`, problems)
  }
  for (const id of catalogIds) {
    if (!seen.has(id)) {
      problems.push(`${id} from ${PATHS.catalog} is neither bundled nor marked unavailable`)
    }
  }
  return problems
}

function sortKeys(object) {
  return Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b)))
}

function compareGlibc(a, b) {
  const [, aMinor] = String(a).split(".").map(Number)
  const [, bMinor] = String(b).split(".").map(Number)
  return aMinor - bMinor
}

/**
 * Adds the registry's integrity to lock entries that have none. A dependency
 * that ships its own npm-shrinkwrap (pi-coding-agent does) contributes entries
 * without `integrity`, and `npm ci` installs those unverified. The value comes
 * from the version's registry metadata and is only taken when the metadata's
 * tarball is the entry's `resolved` URL. Returns the names it filled.
 */
export async function fillLockIntegrity(lock, { fetchImpl = fetch } = {}) {
  const filled = []
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (path === "" || entry.link || entry.integrity) continue
    const name = entry.name ?? path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length)
    const response = await fetchImpl(
      `https://registry.npmjs.org/${name.replace("/", "%2f")}/${entry.version}`
    )
    if (!response.ok) throw new Error(`registry metadata for ${name}@${entry.version}: HTTP ${response.status}`)
    const metadata = await response.json()
    const dist = metadata.dist ?? {}
    if (dist.tarball !== entry.resolved) {
      throw new Error(`${path}: the registry tarball ${dist.tarball} is not the locked ${entry.resolved}`)
    }
    if (typeof dist.integrity !== "string" || !dist.integrity.startsWith("sha512-")) {
      throw new Error(`${name}@${entry.version} has no sha512 integrity in the registry`)
    }
    entry.integrity = dist.integrity
    filled.push(`${name}@${entry.version}`)
  }
  return filled
}

export function readRepoInputs(root = REPO_ROOT) {
  const json = (path) => JSON.parse(readFileSync(join(root, path), "utf8"))
  return {
    pins: json(PATHS.pins),
    packageJson: json(PATHS.packageJson),
    lock: json(PATHS.lock),
    catalog: json(PATHS.catalog),
    dockerfile: readFileSync(join(root, PATHS.dockerfile), "utf8"),
    layoutRs: readFileSync(join(root, PATHS.layout), "utf8"),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// manifest
// ─────────────────────────────────────────────────────────────────────────────

/** `bundle-manifest.json` for one architecture, in `cognia-sandboxd`'s `BundleManifest` shape. */
export function buildManifest(pins, { arch, releaseTag }) {
  if (!ARCHES.includes(arch)) throw new Error(`unknown architecture ${arch}`)
  if (!releaseTag || releaseTag.length > 128) throw new Error("release tag must be 1-128 characters")
  return {
    version: 1,
    releaseTag,
    minGlibc: pins.node.minGlibc,
    runtimes: pins.runtimes
      .filter((runtime) => !("unavailable" in runtime))
      .map((runtime) => ({
        id: runtime.id,
        version: runtime.version,
        libc: [...runtime.libc],
        ...(runtime.minGlibc?.[arch] ? { minGlibc: runtime.minGlibc[arch] } : {}),
      })),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// stage
// ─────────────────────────────────────────────────────────────────────────────

/** npm commands for one libc tree, deduplicated by name. */
export function commandsFor(pins, libc) {
  const byName = new Map()
  for (const runtime of pins.runtimes) {
    if ("unavailable" in runtime || !runtime.libc.includes(libc) || !runtime.commands) continue
    for (const command of runtime.commands) byName.set(command.name, command)
  }
  return [...byName.values()]
}

/** Vendor downloads for one libc tree on one architecture. */
export function downloadsFor(pins, libc, arch) {
  return pins.runtimes
    .filter((runtime) => !("unavailable" in runtime) && runtime.libc.includes(libc))
    .filter((runtime) => runtime.archive || runtime.binary)
    .map((runtime) => {
      const source = runtime.archive ?? runtime.binary
      const asset = source.assets[`${libc}-${arch}`]
      return {
        runtimeId: runtime.id,
        kind: runtime.archive ? "archive" : "binary",
        command: source.command,
        smoke: source.smoke,
        url: asset.url,
        sha256: asset.sha256,
      }
    })
}

/** Command names in a libc tree whose smoke is `--version`, sorted. */
export function versionCommandsFor(pins, libc) {
  const names = new Set()
  for (const command of commandsFor(pins, libc)) {
    if (command.smoke === "version") names.add(command.name)
  }
  for (const runtime of pins.runtimes) {
    if ("unavailable" in runtime || !runtime.libc.includes(libc)) continue
    const source = runtime.archive ?? runtime.binary
    if (source?.smoke === "version") names.add(source.command)
  }
  return [...names].sort()
}

/** The file a package's `bin` entry points at, relative to the package directory. */
export function binTarget(packageManifest, binName) {
  const bin = packageManifest.bin
  if (typeof bin === "string") return bin
  if (isRecord(bin) && typeof bin[binName] === "string") return bin[binName]
  throw new Error(`${packageManifest.name} has no bin named ${binName}`)
}

export function isElf(path) {
  const fd = openSync(path, "r")
  try {
    const head = Buffer.alloc(4)
    return readSync(fd, head, 0, 4, 0) === 4 && head.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
  } finally {
    closeSync(fd)
  }
}

/**
 * How `bin/<name>` reaches a command. A native binary is linked; a JavaScript
 * entry gets a shell shim naming the bundled Node by absolute path, so a
 * `#!/usr/bin/env node` never resolves to the project's own Node.
 */
export function shimFor({ libc, pkg, target, elf, injectionRoot = INJECTION_ROOT }) {
  const relativeTarget = `node_modules/${pkg}/${target}`.replace(/\/\.\//g, "/")
  if (elf) return { type: "symlink", target: `../lib/agents/${relativeTarget}` }
  const node = `${injectionRoot}/${libc}/node/bin/node`
  const entry = `${injectionRoot}/${libc}/lib/agents/${relativeTarget}`
  return { type: "script", content: `#!/bin/sh\nexec ${node} ${entry} "$@"\n` }
}

/** Streams `url` to `dest` and returns the file's SHA-256. */
export async function download(url, dest, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, { redirect: "follow" })
  if (!response.ok || !response.body) {
    throw new Error(`downloading ${url} failed: HTTP ${response.status}`)
  }
  mkdirSync(dirname(dest), { recursive: true })
  const hash = createHash("sha256")
  const tap = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk)
      callback(null, chunk)
    },
  })
  await pipeline(Readable.fromWeb(response.body), tap, createWriteStream(dest))
  return hash.digest("hex")
}

/** Streams `url` to `dest`, refusing it unless its SHA-256 is `sha256`. */
export async function downloadVerified(url, sha256, dest, options = {}) {
  const actual = await download(url, dest, options)
  if (actual !== sha256) {
    rmSync(dest, { force: true })
    throw new Error(`${url} has sha256 ${actual}, expected ${sha256}`)
  }
  return dest
}

/**
 * Whether gpg's `--status-fd` output proves a good signature by `fingerprint`.
 * `VALIDSIG` ends with the primary key's fingerprint, so a signing subkey of
 * the pinned key passes and any other key — even one imported alongside it
 * from the same key file — does not.
 */
export function signatureVerdict(statusOutput, fingerprint) {
  const lines = String(statusOutput).split("\n")
  if (lines.some((line) => /^\[GNUPG:\] (BADSIG|ERRSIG|EXPKEYSIG|REVKEYSIG)\b/.test(line))) {
    return false
  }
  return lines.some((line) => {
    const fields = line.trim().split(/\s+/)
    return fields[0] === "[GNUPG:]" && fields[1] === "VALIDSIG" && fields.at(-1) === fingerprint
  })
}

/** Downloads a PGP-signed artifact and refuses it unless `signingKey` signed it. */
export async function downloadSigned(spec, dest, { fetchImpl = fetch, run = spawnSync } = {}) {
  const work = join(tmpdir(), `cognia-signed-${process.pid}-${Date.now()}`)
  const gnupgHome = join(work, "gnupg")
  mkdirSync(gnupgHome, { recursive: true, mode: 0o700 })
  try {
    await download(spec.url, dest, { fetchImpl })
    await download(spec.signatureUrl, join(work, "artifact.asc"), { fetchImpl })
    await download(spec.keyUrl, join(work, "key.asc"), { fetchImpl })
    const env = { ...process.env, GNUPGHOME: gnupgHome }
    runChecked(run, "gpg", ["--batch", "--quiet", "--import", join(work, "key.asc")], { env })
    const verify = run(
      "gpg",
      ["--batch", "--status-fd", "1", "--verify", join(work, "artifact.asc"), dest],
      { encoding: "utf8", env }
    )
    if (verify.error || !signatureVerdict(verify.stdout, spec.signingKey)) {
      rmSync(dest, { force: true })
      throw new Error(`${spec.url} is not signed by ${spec.signingKey}`)
    }
    return dest
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/** The one executable file named `name` under `dir`; anything else is a build error. */
export function findExecutable(dir, name) {
  const found = []
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && entry.name === name && (lstatSync(path).mode & 0o111) !== 0) {
        found.push(path)
      }
    }
  }
  walk(dir)
  if (found.length !== 1) {
    throw new Error(
      `expected exactly one executable named ${name} under ${dir}, found ${found.length}${
        found.length ? `: ${found.join(", ")}` : ""
      }`
    )
  }
  return found[0]
}

function runChecked(run, command, args, options) {
  const result = run(command, args, { encoding: "utf8", ...options })
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? `${result.stderr ?? ""}${result.stdout ?? ""}`.trim()
    throw new Error(`${command} ${args.join(" ")} failed (status ${result.status}): ${detail}`)
  }
  return result
}

function link(target, path) {
  rmSync(path, { force: true })
  symlinkSync(target, path)
}

/**
 * Builds `<tree>` = `/opt/cognia/<libc>` inside a Dockerfile stage whose npm
 * tree is already at `<tree>/lib/agents` (`npm ci --ignore-scripts`).
 */
export async function stage({
  pins,
  libc,
  arch,
  tree,
  run = spawnSync,
  fetchImpl = fetch,
  execPath = process.execPath,
  systemLib = { loaderDir: "/lib", cxxDir: "/usr/lib" },
  injectionRoot = INJECTION_ROOT,
  log = (line) => console.log(line),
}) {
  if (!LIBCS.includes(libc)) throw new Error(`unknown libc ${libc}`)
  if (!ARCHES.includes(arch)) throw new Error(`unknown architecture ${arch}`)
  // Shims and the musl loader path name the injection root; the smoke runs
  // must see the tree there, as a sandbox will.
  const reached = (() => {
    try {
      return realpathSync(join(injectionRoot, libc)) === realpathSync(tree)
    } catch {
      return false
    }
  })()
  if (!reached) {
    throw new Error(`${join(injectionRoot, libc)} must resolve to ${tree} (link ${injectionRoot} first)`)
  }

  const nodeDir = join(tree, "node")
  const nodeBin = join(nodeDir, "bin", "node")
  mkdirSync(join(nodeDir, "bin"), { recursive: true })
  copyFileSync(execPath, nodeBin)
  chmodSync(nodeBin, 0o755)

  if (libc === "musl") {
    // Node on musl links libstdc++ and libgcc_s, which Alpine base images do
    // not ship, and the image's musl may be older than the one Node was built
    // against. Bring the loader and both libraries, and point Node at them.
    const lib = join(nodeDir, "lib")
    mkdirSync(lib, { recursive: true })
    const loader = `ld-musl-${MUSL_MACHINE[arch]}.so.1`
    copyFileSync(realpathSync(join(systemLib.loaderDir, loader)), join(lib, loader))
    for (const name of ["libstdc++.so.6", "libgcc_s.so.1"]) {
      copyFileSync(realpathSync(join(systemLib.cxxDir, name)), join(lib, name))
    }
    runChecked(run, "patchelf", [
      "--set-interpreter",
      `${injectionRoot}/musl/node/lib/${loader}`,
      "--set-rpath",
      "$ORIGIN/../lib",
      nodeBin,
    ])
    log(`musl: node runs on the bundled ${loader}`)
  }
  runChecked(run, nodeBin, ["--version"], { env: { PATH: "/usr/bin:/bin" } })

  const agents = join(tree, "lib", "agents")
  const allowed = Object.keys(pins.installScripts ?? {})
  if (allowed.length > 0) {
    runChecked(run, "npm", ["rebuild", "--foreground-scripts", ...allowed], {
      cwd: agents,
      env: { ...process.env, npm_config_ignore_scripts: "false" },
    })
  }

  const bin = join(tree, "bin")
  mkdirSync(bin, { recursive: true })
  const smokes = []
  for (const command of commandsFor(pins, libc)) {
    const packageDir = join(agents, "node_modules", command.package)
    const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"))
    const target = binTarget(manifest, command.bin)
    const targetPath = join(packageDir, target)
    const shim = shimFor({
      libc,
      pkg: command.package,
      target,
      elf: isElf(targetPath),
      injectionRoot,
    })
    const path = join(bin, command.name)
    if (shim.type === "symlink") {
      link(shim.target, path)
    } else {
      rmSync(path, { force: true })
      writeFileSync(path, shim.content, { mode: 0o755 })
    }
    smokes.push({ name: command.name, smoke: command.smoke, entry: targetPath, elf: shim.type === "symlink" })
  }

  for (const download of downloadsFor(pins, libc, arch)) {
    const runtimeDir = join(tree, "runtimes", download.runtimeId)
    rmSync(runtimeDir, { recursive: true, force: true })
    mkdirSync(runtimeDir, { recursive: true })
    let executable
    if (download.kind === "archive") {
      const archive = join(tmpdir(), `${download.runtimeId}-${libc}-${arch}.tar.gz`)
      await downloadVerified(download.url, download.sha256, archive, { fetchImpl })
      runChecked(run, "tar", ["-xzf", archive, "-C", runtimeDir])
      rmSync(archive, { force: true })
      executable = findExecutable(runtimeDir, download.command)
    } else {
      executable = join(runtimeDir, download.command)
      await downloadVerified(download.url, download.sha256, executable, { fetchImpl })
      chmodSync(executable, 0o755)
    }
    link(relative(bin, executable), join(bin, download.command))
    smokes.push({ name: download.command, smoke: download.smoke, entry: executable, elf: true })
    log(`${download.runtimeId}: ${relative(tree, executable)}`)
  }

  const home = join(tmpdir(), `cognia-bundle-smoke-${libc}`)
  mkdirSync(home, { recursive: true })
  const env = {
    PATH: `${join(injectionRoot, libc, "bin")}:/usr/local/bin:/usr/bin:/bin`,
    HOME: home,
    CI: "1",
    DISABLE_AUTOUPDATER: "1",
    NO_UPDATE_NOTIFIER: "1",
  }
  for (const smoke of smokes) {
    if (smoke.smoke === "syntax" && !smoke.elf) {
      runChecked(run, nodeBin, ["--check", smoke.entry], { env, timeout: 120_000 })
    } else {
      runChecked(run, join(injectionRoot, libc, "bin", smoke.name), ["--version"], {
        env,
        timeout: 120_000,
      })
    }
    log(`smoke ok: ${libc}/${smoke.name}`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const [mode, ...rest] = argv
  const options = {}
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index]
    if (!key.startsWith("--")) throw new Error(`unexpected argument ${key}`)
    const value = rest[index + 1]
    if (value === undefined || value.startsWith("--")) throw new Error(`${key} needs a value`)
    options[key.slice(2)] = value
    index += 1
  }
  return { mode, options }
}

function required(options, key) {
  if (!options[key]) throw new Error(`--${key} is required`)
  return options[key]
}

async function main(argv) {
  const { mode, options } = parseArgs(argv)
  const pinsPath = options.pins ?? join(REPO_ROOT, PATHS.pins)
  switch (mode) {
    case "check": {
      const problems = validatePins(readRepoInputs(options.root ?? REPO_ROOT))
      for (const problem of problems) console.error(`bundle pins: ${problem}`)
      if (problems.length > 0) process.exitCode = 1
      else console.log("bundle pins: ok")
      return
    }
    case "manifest": {
      const pins = JSON.parse(readFileSync(pinsPath, "utf8"))
      const manifest = buildManifest(pins, {
        arch: required(options, "arch"),
        releaseTag: required(options, "release-tag"),
      })
      writeFileSync(required(options, "out"), `${JSON.stringify(manifest, null, 2)}\n`)
      return
    }
    case "fetch-tool": {
      const pins = JSON.parse(readFileSync(pinsPath, "utf8"))
      const tool = required(options, "tool")
      const spec = pins.tools?.[tool]
      if (!spec) throw new Error(`unknown tool ${tool}`)
      const out = required(options, "out")
      if (spec.signingKey) {
        await downloadSigned(spec, out)
      } else {
        const asset = spec.assets ? spec.assets[required(options, "arch")] : spec
        await downloadVerified(asset.url, asset.sha256, out)
      }
      console.log(spec.version)
      return
    }
    case "fill-integrity": {
      const lockPath = options.lock ?? join(REPO_ROOT, PATHS.lock)
      const lock = JSON.parse(readFileSync(lockPath, "utf8"))
      const filled = await fillLockIntegrity(lock)
      writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`)
      for (const name of filled) console.log(`integrity added: ${name}`)
      return
    }
    case "commands": {
      // For deploy/bundle/smoke.sh: the commands a tree must answer `--version` for.
      const pins = JSON.parse(readFileSync(pinsPath, "utf8"))
      for (const name of versionCommandsFor(pins, required(options, "libc"))) console.log(name)
      return
    }
    case "stage": {
      const pins = JSON.parse(readFileSync(pinsPath, "utf8"))
      await stage({
        pins,
        libc: required(options, "libc"),
        arch: required(options, "arch"),
        tree: required(options, "tree"),
      })
      return
    }
    default:
      throw new Error("usage: bundle-agent-versions.mjs check|manifest|fetch-tool|stage [--options]")
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`bundle-agent-versions: ${error.message}`)
    process.exit(1)
  })
}
