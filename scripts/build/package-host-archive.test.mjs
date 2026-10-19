import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import {
  LINUX_GLIBC_BASELINE,
  assembleHostArchive,
  assertGlibcBaseline,
  hostArchiveLayout,
  isElf,
  isMachO,
  machOFilesUnder,
  hostArchiveName,
  hostArchiveTarget,
  installInstructions,
  newestGlibcRequirement,
  notarizeHostArchive,
  parseArgs,
  serverBuildArgs,
  signHostArchive,
} from "./package-host-archive.mjs"

function parts(dir) {
  const server = join(dir, "cognia-server")
  writeFileSync(server, "server")
  const node = join(dir, "node")
  writeFileSync(node, "node")
  const license = join(dir, "LICENSE")
  writeFileSync(license, "license")
  const brain = join(dir, "layout")
  mkdirSync(join(brain, "sidecar"), { recursive: true })
  writeFileSync(join(brain, "cli.mjs"), "brain")
  writeFileSync(join(brain, "sidecar", "claude-host.mjs"), "sidecar")
  return { serverBinary: server, nodeBinary: node, nodeLicense: license, brainLayoutDir: brain }
}

test("packages macOS and glibc Linux targets and nothing else", () => {
  assert.equal(hostArchiveTarget("darwin-arm64").rust, "aarch64-apple-darwin")
  assert.equal(hostArchiveTarget("darwin-x64").arch, "x64")
  assert.equal(hostArchiveTarget("linux-x64").rust, "x86_64-unknown-linux-gnu")
  assert.equal(hostArchiveTarget("linux-arm64").platform, "linux")
  assert.throws(() => hostArchiveTarget("linux-x64-musl"), /Unsupported host archive target/)
  assert.equal(hostArchiveName({ version: "1.2.3", target: "darwin-arm64" }), "cognia-host-1.2.3-darwin-arm64")
  assert.equal(hostArchiveName({ version: "1.2.3", target: "linux-arm64" }), "cognia-host-1.2.3-linux-arm64")
})

test("Linux archives carry the ocrs engine and the installer's glibc baseline", () => {
  assert.deepEqual(serverBuildArgs("darwin-arm64"), [
    "build", "-p", "cognia-server", "--release", "--bin", "cognia-server", "--target", "aarch64-apple-darwin",
  ])
  assert.deepEqual(serverBuildArgs("linux-x64"), [
    "build", "-p", "cognia-server", "--release", "--bin", "cognia-server",
    "--no-default-features", "--features", "ocr-ocrs", "--target", "x86_64-unknown-linux-gnu",
  ])
  assert.equal(hostArchiveTarget("linux-arm64").glibc, LINUX_GLIBC_BASELINE)
  // The installer refuses machines below the same floor (cognia-host-installer probe.rs).
  const probe = readFileSync(new URL("../../crates/cognia-host-installer/src/probe.rs", import.meta.url), "utf8")
  const [, major, minor] = probe.match(/GLIBC_BASELINE: \(u32, u32\) = \((\d+), (\d+)\)/)
  assert.equal(`${major}.${minor}`, LINUX_GLIBC_BASELINE)
})

const VERSION_INFO = `
Version symbols section '.gnu.version' contains 4 entries:
 Addr: 0x0000000000000a18  Offset: 0x000a18  Link: 6 (.dynsym)
  000:   0 (*local*)       2 (GLIBC_2.2.5)   3 (GLIBC_2.34)

Version definition section '.gnu.version_d' contains 2 entries:
  000000: Rev: 1  Flags: BASE  Index: 1  Cnt: 1  Name: libfoo.so
  0x001c: Rev: 1  Flags: none  Index: 2  Cnt: 1  Name: GLIBC_2.99

Version needs section '.gnu.version_r' contains 1 entry:
 Addr: 0x0000000000000a28  Offset: 0x000a28  Link: 7 (.dynstr)
  000000: Version: 1  File: libc.so.6  Cnt: 3
  0x0010:   Name: GLIBC_2.2.5  Flags: none  Version: 2
  0x0020:   Name: GLIBC_2.34  Flags: none  Version: 3
  0x0030:   Name: GLIBC_2.17  Flags: none  Version: 4
`

test("reads the newest glibc a binary needs, ignoring the versions it defines", () => {
  assert.equal(newestGlibcRequirement(VERSION_INFO), "2.34")
  assert.equal(newestGlibcRequirement("There are no version information sections."), null)
})

test("refuses an archive whose ELF files need a glibc above the baseline", () => {
  const dir = mkdtempSync(join(tmpdir(), "cognia-host-archive-"))
  try {
    const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(12)])
    mkdirSync(join(dir, "bin"))
    writeFileSync(join(dir, "bin", "cognia-server"), elf)
    writeFileSync(join(dir, "bin", "node"), elf)
    writeFileSync(join(dir, "cli.mjs"), "brain")
    assert.equal(isElf(join(dir, "bin", "node")), true)
    assert.equal(isElf(join(dir, "cli.mjs")), false)

    const needs = (versions) => (command, args) => {
      assert.equal(command, "readelf")
      const file = args.at(-1)
      const version = file.endsWith("node") ? versions.node : versions.server
      return { status: 0, stdout: `Version needs section '.gnu.version_r'\n  Name: GLIBC_${version}  Flags: none\n` }
    }
    assert.equal(assertGlibcBaseline({ root: dir, baseline: "2.35", run: needs({ server: "2.35", node: "2.28" }) }), 2)
    assert.throws(
      () => assertGlibcBaseline({ root: dir, baseline: "2.35", run: needs({ server: "2.39", node: "2.28" }) }),
      /bin\/cognia-server needs GLIBC_2\.39/
    )
    assert.throws(
      () => assertGlibcBaseline({ root: dir, baseline: "2.35", run: () => ({ status: 1, stderr: "boom" }) }),
      /readelf failed/
    )
    rmSync(join(dir, "bin"), { recursive: true })
    assert.throws(() => assertGlibcBaseline({ root: dir, baseline: "2.35" }), /no ELF files/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("assembles the layout cognia-host-service expects, with a manifest of every file", () => {
  const dir = mkdtempSync(join(tmpdir(), "cognia-host-archive-"))
  try {
    const root = assembleHostArchive({ outDir: join(dir, "out"), version: "1.2.3", target: "darwin-arm64", ...parts(dir) })
    const layout = hostArchiveLayout(root)
    assert.equal(readFileSync(layout.server, "utf8"), "server")
    assert.equal(readFileSync(layout.node, "utf8"), "node")
    assert.equal(readFileSync(layout.brainEntry, "utf8"), "brain")
    assert.equal(readFileSync(layout.sidecarScript, "utf8"), "sidecar")
    assert.equal(statSync(layout.server).mode & 0o777, 0o755)
    assert.match(readFileSync(layout.install, "utf8"), /sudo \.\/bin\/cognia-server service install/)
    const manifest = JSON.parse(readFileSync(layout.manifest, "utf8"))
    assert.equal(manifest.version, "1.2.3")
    assert.equal(manifest.target, "darwin-arm64")
    // The contract its server and brain serve, from this tree.
    assert.ok(Number.isInteger(manifest.contractVersion))
    assert.match(manifest.catalogHash, /^[0-9a-f]{64}$/)
    assert.ok(manifest.files["bin/cognia-server"])
    assert.ok(manifest.files["brain/sidecar/claude-host.mjs"])
    assert.ok(!("host-manifest.json" in manifest.files))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("refuses a brain layout without its entry or sidecar", () => {
  const dir = mkdtempSync(join(tmpdir(), "cognia-host-archive-"))
  try {
    const built = parts(dir)
    rmSync(join(built.brainLayoutDir, "sidecar"), { recursive: true })
    assert.throws(
      () => assembleHostArchive({ outDir: join(dir, "out"), version: "1", target: "darwin-arm64", ...built }),
      /has no sidecar/
    )
    assert.throws(
      () =>
        assembleHostArchive({
          outDir: join(dir, "out"),
          version: "1",
          target: "darwin-arm64",
          ...built,
          nodeBinary: join(dir, "absent"),
        }),
      /nodeBinary is missing/
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("signs node and the server with the hardened runtime, ad-hoc without an identity", () => {
  const calls = []
  const run = (command, args) => {
    calls.push([command, ...args])
    return { status: 0 }
  }
  const mode = signHostArchive({ root: "/r", identity: null, entitlements: "/e.plist", run, nested: [] })
  assert.equal(mode, "ad-hoc")
  const signs = calls.filter((call) => call.includes("--sign"))
  assert.deepEqual(
    signs.map((call) => call.at(-1)),
    ["/r/node/bin/node", "/r/bin/cognia-server"]
  )
  assert.ok(signs.every((call) => call.includes("runtime") && call.includes("/e.plist") && call.includes("-")))

  // Nested Mach-O files are signed first, without the executables' entitlements.
  calls.length = 0
  signHostArchive({ root: "/r", identity: null, entitlements: "/e.plist", run, nested: ["/r/brain/addon.node"] })
  const nestedSigns = calls.filter((call) => call.includes("--sign"))
  assert.deepEqual(
    nestedSigns.map((call) => call.at(-1)),
    ["/r/brain/addon.node", "/r/node/bin/node", "/r/bin/cognia-server"]
  )
  assert.ok(nestedSigns[0].includes("runtime") && !nestedSigns[0].includes("/e.plist"))

  calls.length = 0
  assert.equal(
    signHostArchive({ root: "/r", identity: "Developer ID", entitlements: "/e.plist", run, nested: [] }),
    "developer-id"
  )
  assert.ok(calls.some((call) => call.includes("--timestamp")))
  assert.throws(
    () =>
      signHostArchive({ root: "/r", identity: null, entitlements: "/e", run: () => ({ status: 1, stderr: "nope" }), nested: [] }),
    /codesign failed: nope/
  )
})

test("finds the Mach-O files under the brain and nothing else", () => {
  const dir = mkdtempSync(join(tmpdir(), "cognia-host-archive-"))
  try {
    const header = (words) => Buffer.concat([Buffer.from(words.flatMap((w) => [w >>> 24, (w >>> 16) & 255, (w >>> 8) & 255, w & 255])), Buffer.alloc(8)])
    mkdirSync(join(dir, "node_modules", "addon", "build"), { recursive: true })
    writeFileSync(join(dir, "node_modules", "addon", "build", "addon.node"), header([0xcffaedfe, 7]))
    writeFileSync(join(dir, "spawn-helper"), header([0xcafebabe, 2]))
    writeFileSync(join(dir, "Main.class"), header([0xcafebabe, 0x34]))
    writeFileSync(join(dir, "index.js"), "module.exports = 1")
    writeFileSync(join(dir, "tiny"), "x")
    assert.equal(isMachO(join(dir, "spawn-helper")), true)
    assert.equal(isMachO(join(dir, "Main.class")), false)
    assert.deepEqual(machOFilesUnder(dir), [
      join(dir, "node_modules", "addon", "build", "addon.node"),
      join(dir, "spawn-helper"),
    ])
    assert.deepEqual(machOFilesUnder(join(dir, "absent")), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("notarizes a zip of the signed root and fails unless Apple accepts it", () => {
  const calls = []
  const accepted = (command, args) => {
    calls.push([command, ...args])
    return { status: 0, stdout: command === "xcrun" ? "  status: Accepted\n" : "" }
  }
  notarizeHostArchive({ root: "/r/host", identity: "Developer ID", profile: "cognia", run: accepted })
  assert.deepEqual(calls[0], ["ditto", "-c", "-k", "--keepParent", "/r/host", "/r/host.notarize.zip"])
  assert.deepEqual(calls[1], [
    "xcrun",
    "notarytool",
    "submit",
    "/r/host.notarize.zip",
    "--keychain-profile",
    "cognia",
    "--wait",
  ])

  const invalid = (command) => ({ status: 0, stdout: command === "xcrun" ? "  status: Invalid\n" : "" })
  assert.throws(
    () => notarizeHostArchive({ root: "/r/host", identity: "Developer ID", profile: "cognia", run: invalid }),
    /not accepted/
  )
  assert.throws(
    () => notarizeHostArchive({ root: "/r/host", identity: null, profile: "cognia", run: accepted }),
    /needs --sign/
  )
})

test("parses its flags and rejects unknown ones", () => {
  const options = parseArgs(["--target", "darwin-x64", "--sign", "ID", "--skip-build", "--out", "/tmp/x"], "darwin-x64")
  assert.equal(options.target, "darwin-x64")
  assert.equal(options.sign, "ID")
  assert.equal(options.skipBuild, true)
  assert.equal(options.out, "/tmp/x")
  assert.equal(parseArgs(["--target", "darwin-x64", "--sign", "ID", "--notarize", "p"], "darwin-x64").notarize, "p")
  assert.throws(() => parseArgs(["--target", "darwin-x64", "--notarize", "p"], "darwin-x64"), /needs --sign/)
  assert.equal(parseArgs([], "darwin-arm64").target, "darwin-arm64")
  // The brain carries the build machine's native addons, so no cross-arch archive.
  assert.throws(() => parseArgs(["--target", "darwin-x64"], "darwin-arm64"), /cannot package darwin-x64 on darwin-arm64/)
  assert.throws(() => parseArgs(["--bogus"]), /unknown argument/)
  assert.throws(() => parseArgs(["--target", "win32-x64"]), /Unsupported host archive target/)
  assert.equal(parseArgs([], "linux-arm64").target, "linux-arm64")
  assert.throws(() => parseArgs(["--target", "linux-x64"], "darwin-arm64"), /Build on a linux-x64 machine/)
  // Code signing and notarization are Apple's; a Linux archive has neither.
  assert.throws(() => parseArgs(["--sign", "ID"], "linux-x64"), /macOS code signing/)
})

test("install instructions name the relay pairing and the master key backup", () => {
  const text = installInstructions({ version: "1", target: "darwin-arm64" })
  assert.match(text, /cognia-server pair/)
  assert.match(text, /master\.key/)
  assert.match(text, /--scope user/)
  assert.match(text, /updates itself/)
})

test("Linux install instructions use systemd, lingering and the glibc floor", () => {
  const text = installInstructions({ version: "1", target: "linux-x64" })
  assert.match(text, /service install --scope user/)
  assert.match(text, /loginctl enable-linger/)
  assert.match(text, /glibc 2\.35/)
  assert.match(text, /\.local\/share\/cognia-server/)
  assert.match(text, /master\.key/)
  assert.match(text, /updates itself/)
  assert.doesNotMatch(text, /LaunchDaemon|Library\/Application Support/)
})
