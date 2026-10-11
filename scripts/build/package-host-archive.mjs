#!/usr/bin/env node
// ADR-0224 A1: the standalone always-on host archive for macOS.
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
// Linux hosts run the Compose `server` profile instead (ADR-0224), so only the
// two macOS targets are packaged here.

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

/** Packaged targets: archive target → Rust triple + Node archive platform/arch. */
export const HOST_ARCHIVE_TARGETS = Object.freeze({
  "darwin-arm64": { rust: "aarch64-apple-darwin", platform: "darwin", arch: "arm64" },
  "darwin-x64": { rust: "x86_64-apple-darwin", platform: "darwin", arch: "x64" },
})

export function hostArchiveTarget(name) {
  const target = HOST_ARCHIVE_TARGETS[name]
  if (!target) {
    throw new Error(
      `Unsupported host archive target ${name}; expected one of ${Object.keys(HOST_ARCHIVE_TARGETS).join(", ")}. Linux hosts use the Compose server profile.`
    )
  }
  return target
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
  return `Cognia always-on host ${version} (${target})

Install as a LaunchDaemon that starts at boot, running as your account:

  sudo ./bin/cognia-server service install

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
  hostArchiveTarget(options.target)
  if (options.target !== host) {
    throw new Error(
      `cannot package ${options.target} on ${host}: the brain's native addons (better-sqlite3, node-pty) and platform runtimes come from this machine's install. Build on a ${options.target} Mac.`
    )
  }
  if (options.notarize && !options.sign) {
    throw new Error("--notarize needs --sign with a Developer ID identity")
  }
  return options
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const { rust } = hostArchiveTarget(options.target)
  const version = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")).version
  if (!options.skipBuild) {
    run("cargo", [
      "build",
      "--manifest-path",
      join(projectRoot, "src-tauri", "Cargo.toml"),
      "--release",
      "--bin",
      "cognia-server",
      "--target",
      rust,
    ])
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
    const mode = signHostArchive({
      root,
      identity: options.sign,
      entitlements: join(scriptDir, "bun-entitlements.plist"),
    })
    if (options.notarize) {
      notarizeHostArchive({ root, identity: options.sign, profile: options.notarize })
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
