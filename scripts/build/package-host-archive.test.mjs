import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import {
  assembleHostArchive,
  hostArchiveLayout,
  isMachO,
  machOFilesUnder,
  hostArchiveName,
  hostArchiveTarget,
  installInstructions,
  notarizeHostArchive,
  parseArgs,
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

test("only the two macOS targets are packaged; Linux uses Compose", () => {
  assert.equal(hostArchiveTarget("darwin-arm64").rust, "aarch64-apple-darwin")
  assert.equal(hostArchiveTarget("darwin-x64").arch, "x64")
  assert.throws(() => hostArchiveTarget("linux-x64"), /Compose server profile/)
  assert.equal(hostArchiveName({ version: "1.2.3", target: "darwin-arm64" }), "cognia-host-1.2.3-darwin-arm64")
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
})

test("install instructions name the relay pairing and the master key backup", () => {
  const text = installInstructions({ version: "1", target: "darwin-arm64" })
  assert.match(text, /cognia-server pair/)
  assert.match(text, /master\.key/)
  assert.match(text, /--scope user/)
})
