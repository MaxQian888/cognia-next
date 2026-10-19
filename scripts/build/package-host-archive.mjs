#!/usr/bin/env node
// ADR-0224 A1 / ADR-0235 P3: the standalone always-on host archive, for macOS
// and Linux.
//
// One directory, laid out the way `cognia-host-service`'s `HostLayout` expects,
// so `bin/cognia-server service install` can find everything relative to itself:
//
//   cognia-host-<version>-<target>/
//     bin/cognia-server         release front door
//     node/bin/node             pinned Node (same build and checksum as the plugin runtime)
//     node/LICENSE
//     brain/cli.mjs             the headless brain layout (`build-cli-binary --layout-only`)
//     brain/node_modules/ …
//     brain/sidecar/ …
//     host-manifest.json        version, target, Node version, command contract, sha256 of every file
//     INSTALL.txt
//
// Linux archives run on glibc 2.35 and newer (Ubuntu 22.04, Debian 12): they
// are built on a glibc 2.35 machine, and every ELF file is checked against that
// baseline before packaging. They carry the pure-Rust `ocrs` OCR engine instead
// of the desktop's PaddleOCR, whose prebuilt ONNX Runtime needs glibc 2.38. The
// Compose `server` profile remains the containerized Linux install.

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  chmodSync,
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { repoContractIdentity, sha256File as sha256OfFile } from "../release/update-catalog.mjs"
import { PLUGIN_NODE_VERSION, archiveFor, verifyArchive } from "./prepare-plugin-node.mjs"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(scriptDir, "../..")

/**
 * The oldest glibc a Linux host archive runs on. Mirrors `GLIBC_BASELINE` in
 * `crates/cognia-host-installer/src/probe.rs`, which refuses an older machine
 * before uploading anything.
 */
export const LINUX_GLIBC_BASELINE = "2.35"

/** The Linux OCR engine: pure Rust, no ONNX Runtime and so no glibc 2.38 floor. */
const LINUX_SERVER_FEATURES = ["--no-default-features", "--features", "ocr-ocrs"]

/**
 * Packaged targets: archive target → Rust triple, Node archive platform/arch,
 * the server's cargo feature flags and, on Linux, the glibc baseline.
 */
export const HOST_ARCHIVE_TARGETS = Object.freeze({
  "darwin-arm64": { rust: "aarch64-apple-darwin", platform: "darwin", arch: "arm64", features: [] },
  "darwin-x64": { rust: "x86_64-apple-darwin", platform: "darwin", arch: "x64", features: [] },
  "linux-x64": {
    rust: "x86_64-unknown-linux-gnu",
    platform: "linux",
    arch: "x64",
    features: LINUX_SERVER_FEATURES,
    glibc: LINUX_GLIBC_BASELINE,
  },
  "linux-arm64": {
    rust: "aarch64-unknown-linux-gnu",
    platform: "linux",
    arch: "arm64",
    features: LINUX_SERVER_FEATURES,
    glibc: LINUX_GLIBC_BASELINE,
  },
})

export function hostArchiveTarget(name) {
  const target = HOST_ARCHIVE_TARGETS[name]
  if (!target) {
    throw new Error(
      `Unsupported host archive target ${name}; expected one of ${Object.keys(HOST_ARCHIVE_TARGETS).join(", ")}.`
    )
  }
  return target
}

/** The `cargo` argv that builds a target's server binary. */
export function serverBuildArgs(name) {
  const { rust, features } = hostArchiveTarget(name)
  return ["build", "-p", "cognia-server", "--release", "--bin", "cognia-server", ...features, "--target", rust]
}

export function hostArchiveName({ version, target }) {
  return `cognia-host-${version}-${target}`
}

/** Paths inside an assembled archive; mirrors `cognia_host_service::server::HostLayout`. */
export function hostArchiveLayout(root) {
  return {
    server: join(root, "bin", "cognia-server"),
    node: join(root, "node", "bin", "node"),
    nodeLicense: join(root, "node", "LICENSE"),
    brain: join(root, "brain"),
    brainEntry: join(root, "brain", "cli.mjs"),
    sidecarScript: join(root, "brain", "sidecar", "claude-host.mjs"),
    manifest: join(root, "host-manifest.json"),
    install: join(root, "INSTALL.txt"),
  }
}

export function installInstructions({ version, target }) {
  return hostArchiveTarget(target).platform === "linux"
    ? linuxInstallInstructions({ version, target })
    : macInstallInstructions({ version, target })
}

function macInstallInstructions({ version, target }) {
  return `Cognia always-on host ${version} (${target})

Install as a LaunchDaemon that starts at boot, running as your account:

  sudo ./bin/cognia-server service install

This copies the host into its data dir's install home, where it updates itself
later; this unpacked directory is not needed afterwards.

Then pair your phone or desktop over the relay (no public domain needed):

  COGNIA_DATA_DIR="$HOME/Library/Application Support/cognia-server" ./bin/cognia-server pair

Check or remove the service:

  sudo ./bin/cognia-server service status
  sudo ./bin/cognia-server service uninstall

The master key is written to <data dir>/master.key on first install. Back it up:
without it the secrets this host stores cannot be read.

Prefer a per-user agent that starts at login? Use --scope user (no sudo).
`
}

function linuxInstallInstructions({ version, target }) {
  return `Cognia always-on host ${version} (${target})

Needs glibc ${LINUX_GLIBC_BASELINE} or newer (Ubuntu 22.04, Debian 12 and later) and
systemd. Check with: getconf GNU_LIBC_VERSION

Install as a systemd user service, running as your account (no sudo):

  ./bin/cognia-server service install --scope user

A user service starts at login. To start it at boot without one, enable
lingering once:

  loginctl enable-linger "$USER"

Or install a system service that starts at boot, running as the account that
ran sudo (pick another with --run-as):

  sudo ./bin/cognia-server service install

Either way this copies the host into its data dir's install home, where it
updates itself later; this unpacked directory is not needed afterwards.

Then pair your phone or desktop over the relay (no public domain needed) with
the pair command the install prints; for the user service it is:

  COGNIA_DATA_DIR="$HOME/.local/share/cognia-server" ./bin/cognia-server pair

Check or remove the service:

  ./bin/cognia-server service status --scope user
  ./bin/cognia-server service uninstall --scope user

The master key is written to <data dir>/master.key on first install. Back it up:
without it the secrets this host stores cannot be read.

OCR on this host uses the ocrs engine rather than the desktop's PaddleOCR.
Prefer containers? The Compose server profile runs the same host in Docker.
`
}

function walkFiles(root) {
  const files = []
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile()) files.push(path)
    }
  }
  visit(root)
  return files.sort()
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

/** Assemble the archive directory from built parts; refuses a missing part. */
export function assembleHostArchive({
  outDir,
  version,
  target,
  serverBinary,
  brainLayoutDir,
  nodeBinary,
  nodeLicense,
}) {
  hostArchiveTarget(target)
  for (const [label, path] of Object.entries({
    serverBinary,
    brainLayoutDir,
    nodeBinary,
    nodeLicense,
  })) {
    if (!path || !existsSync(path)) throw new Error(`host archive part ${label} is missing: ${path}`)
  }
  for (const required of ["cli.mjs", join("sidecar", "claude-host.mjs")]) {
    if (!existsSync(join(brainLayoutDir, required))) {
      throw new Error(`brain layout ${brainLayoutDir} has no ${required}`)
    }
  }

  const root = join(outDir, hostArchiveName({ version, target }))
  rmSync(root, { recursive: true, force: true })
  const layout = hostArchiveLayout(root)
  mkdirSync(dirname(layout.server), { recursive: true })
  mkdirSync(dirname(layout.node), { recursive: true })
  copyFileSync(serverBinary, layout.server)
  chmodSync(layout.server, 0o755)
  copyFileSync(nodeBinary, layout.node)
  chmodSync(layout.node, 0o755)
  copyFileSync(nodeLicense, layout.nodeLicense)
  cpSync(brainLayoutDir, layout.brain, { recursive: true, dereference: true })
  writeFileSync(layout.install, installInstructions({ version, target }))
  writeHostManifest(root, { version, target })
  return root
}

/**
 * Record what the archive holds; written last and rewritten after signing.
 * The command contract its server and brain serve is what the host updater
 * checks a new release against before swapping (ADR-0224 A10).
 */
export function writeHostManifest(root, { version, target, contract = repoContractIdentity() }) {
  const layout = hostArchiveLayout(root)
  const files = Object.fromEntries(
    walkFiles(root)
      .filter((path) => path !== layout.manifest)
      .map((path) => [relative(root, path).split("\\").join("/"), sha256File(path)])
  )
  writeFileSync(
    layout.manifest,
    `${JSON.stringify(
      {
        format: 1,
        version,
        target,
        nodeVersion: PLUGIN_NODE_VERSION,
        contractVersion: contract.contractVersion,
        catalogHash: contract.catalogHash,
        files,
      },
      null,
      2
    )}\n`
  )
}

const MACH_O_MAGICS = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe])

/** Whether `path` is a Mach-O file (thin or universal). */
export function isMachO(path) {
  const header = Buffer.alloc(8)
  const fd = openSync(path, "r")
  try {
    if (readSync(fd, header, 0, 8, 0) < 8) return false
  } finally {
    closeSync(fd)
  }
  const magic = header.readUInt32BE(0)
  if (MACH_O_MAGICS.has(magic)) return true
  // A universal binary; Java class files share the magic but carry a version
  // (>= 45) where a fat header carries a small architecture count.
  return magic === 0xcafebabe && header.readUInt32BE(4) < 45
}

/** Every Mach-O file under `dir` (native addons, helpers, vendored binaries). */
export function machOFilesUnder(dir) {
  return existsSync(dir) ? walkFiles(dir).filter(isMachO) : []
}

/** Whether `path` is an ELF file. */
export function isElf(path) {
  const header = Buffer.alloc(4)
  const fd = openSync(path, "r")
  try {
    if (readSync(fd, header, 0, 4, 0) < 4) return false
  } finally {
    closeSync(fd)
  }
  return header.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
}

function compareVersions(left, right) {
  const a = left.split(".").map(Number)
  const b = right.split(".").map(Number)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return Math.sign(difference)
  }
  return 0
}

/**
 * The newest `GLIBC_x.y` symbol version a `readelf --version-info` dump
 * requires, or `null` when it requires none (a static or non-glibc binary).
 * Only the version-needs section names requirements; the definitions a
 * library exports would read as requirements of the library itself.
 */
export function newestGlibcRequirement(versionInfo) {
  const needs = versionInfo.split(/\n(?=Version (?:needs|definition) section)/)
  let newest = null
  for (const section of needs) {
    if (!section.startsWith("Version needs section")) continue
    for (const [, version] of section.matchAll(/Name: GLIBC_(\d+(?:\.\d+)+)\b/g)) {
      if (newest === null || compareVersions(version, newest) > 0) newest = version
    }
  }
  return newest
}

/**
 * Refuse an archive whose ELF files need a glibc newer than `baseline`: the
 * server, Node and every native addon in the brain. A build on a newer
 * machine links newer symbol versions silently, and the installer only
 * checks the baseline, so the binary would then fail to load on a machine
 * the installer accepted.
 */
export function assertGlibcBaseline({ root, baseline, run = spawnSync }) {
  const elves = walkFiles(root).filter(isElf)
  if (elves.length === 0) throw new Error(`no ELF files under ${root}; is this a Linux archive?`)
  const offenders = []
  for (const file of elves) {
    const result = run("readelf", ["--version-info", "--wide", file], { encoding: "utf8" })
    if (result.status !== 0) {
      throw new Error(`readelf failed on ${file}: ${result.stderr || result.error}`)
    }
    const newest = newestGlibcRequirement(result.stdout ?? "")
    if (newest !== null && compareVersions(newest, baseline) > 0) {
      offenders.push(`${relative(root, file)} needs GLIBC_${newest}`)
    }
  }
  if (offenders.length > 0) {
    throw new Error(
      `the archive needs a glibc newer than its ${baseline} baseline; build it on a glibc ${baseline} machine:\n  ${offenders.join("\n  ")}`
    )
  }
  return elves.length
}

/**
 * Sign every Mach-O file with the hardened runtime: the native addons and
 * helpers under brain/ first, then the two executables. Node needs the JIT
 * entitlements the CLI's runtime already ships with. Without an identity the
 * signature is ad-hoc, which is enough to run locally but not to notarize,
 * which rejects an archive holding any unsigned Mach-O.
 */
export function signHostArchive({
  root,
  identity,
  entitlements,
  run = spawnSync,
  nested = machOFilesUnder(hostArchiveLayout(root).brain),
}) {
  const layout = hostArchiveLayout(root)
  const signer = identity || "-"
  const timestamp = identity ? ["--timestamp"] : []
  const codesign = (args) => {
    const result = run("codesign", args, { encoding: "utf8" })
    if (result.status !== 0) {
      throw new Error(`codesign failed: ${result.stderr || result.stdout || result.error}`)
    }
  }
  for (const file of nested) {
    codesign(["--force", "--options", "runtime", ...timestamp, "--sign", signer, file])
    codesign(["--verify", "--verbose=2", file])
  }
  for (const executable of [layout.node, layout.server]) {
    codesign([
      "--force",
      "--options",
      "runtime",
      ...timestamp,
      "--entitlements",
      entitlements,
      "--sign",
      signer,
      executable,
    ])
    codesign(["--verify", "--verbose=2", executable])
  }
  return identity ? "developer-id" : "ad-hoc"
}

/**
 * Submit the signed executables to Apple's notary service and wait for the
 * verdict. Bare Mach-O files cannot be stapled, so Gatekeeper checks the
 * ticket online on first launch; the submission is a zip of the archive root.
 */
export function notarizeHostArchive({ root, identity, profile, run = spawnSync }) {
  if (!identity) throw new Error("--notarize needs --sign with a Developer ID identity")
  const zip = `${root}.notarize.zip`
  const step = (command, args) => {
    const result = run(command, args, { encoding: "utf8" })
    if (result.status !== 0) {
      throw new Error(`${command} ${args[0]} failed: ${result.stderr || result.stdout || result.error}`)
    }
    return result
  }
  try {
    step("ditto", ["-c", "-k", "--keepParent", root, zip])
    const result = step("xcrun", ["notarytool", "submit", zip, "--keychain-profile", profile, "--wait"])
    if (!/status:\s*Accepted/.test(result.stdout ?? "")) {
      throw new Error(`notarization was not accepted:\n${result.stdout}`)
    }
  } finally {
    rmSync(zip, { force: true })
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: projectRoot, stdio: "inherit", ...options })
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`)
}

async function fetchVerifiedNode(target, work) {
  const { platform, arch } = hostArchiveTarget(target)
  const archive = archiveFor(platform, arch)
  const response = await fetch(`https://nodejs.org/dist/v${PLUGIN_NODE_VERSION}/${archive.file}`)
  if (!response.ok) throw new Error(`Node download failed: HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  verifyArchive(bytes, archive.sha256)
  const archivePath = join(work, archive.file)
  writeFileSync(archivePath, bytes)
  run("tar", ["-xf", archivePath, "-C", work])
  const sourceRoot = join(work, basename(archive.file).replace(/\.tar\.xz$/, ""))
  return { nodeBinary: join(sourceRoot, "bin", "node"), nodeLicense: join(sourceRoot, "LICENSE") }
}

/**
 * `host` is the build machine: the brain layout copies its installed native
 * addons and platform runtimes, so an archive can only be built for it.
 */
export function parseArgs(argv, host = `${process.platform}-${process.arch}`) {
  const options = {
    target: null,
    out: join(projectRoot, "dist", "host"),
    sign: null,
    notarize: null,
    skipBuild: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--target") options.target = argv[++index]
    else if (arg === "--out") options.out = resolve(argv[++index])
    else if (arg === "--sign") options.sign = argv[++index]
    else if (arg === "--notarize") options.notarize = argv[++index]
    else if (arg === "--skip-build") options.skipBuild = true
    else throw new Error(`unknown argument ${arg}`)
  }
  if (!options.target) {
    options.target = host
  }
  const { platform } = hostArchiveTarget(options.target)
  if (options.target !== host) {
    throw new Error(
      `cannot package ${options.target} on ${host}: the brain's native addons (better-sqlite3, node-pty) and platform runtimes come from this machine's install. Build on a ${options.target} machine.`
    )
  }
  if (platform !== "darwin" && (options.sign || options.notarize)) {
    throw new Error("--sign and --notarize are macOS code signing; a Linux archive is verified by its catalog digest")
  }
  if (options.notarize && !options.sign) {
    throw new Error("--notarize needs --sign with a Developer ID identity")
  }
  return options
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const { rust, platform, glibc } = hostArchiveTarget(options.target)
  const version = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")).version
  if (!options.skipBuild) {
    run("cargo", serverBuildArgs(options.target))
    // The layout copies webclone's runtime closure into the sidecar tree.
    run(process.execPath, [join(scriptDir, "build-webclone-sidecar.mjs"), "--install-only"])
    run(process.execPath, [join(scriptDir, "build-cli-binary.mjs"), "--layout-only"])
  }
  const serverBinary = join(projectRoot, "target", rust, "release", "cognia-server")
  const brainLayoutDir = join(projectRoot, "cli", "dist", "bin", "cognia-agent-layout")
  const work = mkdtempSync(join(tmpdir(), "cognia-host-node-"))
  try {
    const node = await fetchVerifiedNode(options.target, work)
    mkdirSync(options.out, { recursive: true })
    const root = assembleHostArchive({
      outDir: options.out,
      version,
      target: options.target,
      serverBinary,
      brainLayoutDir,
      ...node,
    })
    let mode = "no"
    if (platform === "darwin") {
      mode = signHostArchive({
        root,
        identity: options.sign,
        entitlements: join(scriptDir, "bun-entitlements.plist"),
      })
      if (options.notarize) {
        notarizeHostArchive({ root, identity: options.sign, profile: options.notarize })
      }
    } else {
      const checked = assertGlibcBaseline({ root, baseline: glibc })
      console.log(`glibc ${glibc} baseline: ${checked} ELF files checked`)
    }
    writeHostManifest(root, { version, target: options.target })
    const tarball = `${root}.tar.gz`
    run("tar", ["-czf", tarball, "-C", dirname(root), basename(root)])
    // `shasum -a 256 -c` form, for the release page. The catalog pins the
    // same digest (`pnpm update:catalog host-entries --archive`).
    writeFileSync(`${tarball}.sha256`, `${sha256OfFile(tarball)}  ${basename(tarball)}\n`)
    console.log(
      `Host archive: ${tarball} (${(statSync(tarball).size / 1024 / 1024).toFixed(1)} MiB, ${mode} signature${options.notarize ? ", notarized" : ""})`
    )
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
