import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import {
  binTarget,
  buildManifest,
  commandsFor,
  download,
  downloadVerified,
  downloadsFor,
  fillLockIntegrity,
  findExecutable,
  isElf,
  parseArgs,
  readRepoInputs,
  shimFor,
  signatureVerdict,
  stage,
  validatePins,
  versionCommandsFor,
} from "./bundle-agent-versions.mjs"

const clone = (value) => structuredClone(value)
const tempDir = () => mkdtempSync(join(tmpdir(), "bundle-pins-"))
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex")

function fakeFetch(files) {
  return async (url) => {
    if (!(url in files)) return new Response("missing", { status: 404 })
    const body = files[url]
    return new Response(typeof body === "string" ? body : new Uint8Array(body))
  }
}

describe("check against the repository", () => {
  it("passes on the committed pins, lock, catalog and Dockerfile", () => {
    assert.deepEqual(validatePins(readRepoInputs()), [])
  })

  it("accounts for every catalog runtime and bundles only catalog runtimes", () => {
    const inputs = readRepoInputs()
    const missing = clone(inputs)
    missing.pins.runtimes = missing.pins.runtimes.filter((runtime) => runtime.id !== "devin")
    assert.match(validatePins(missing).join("\n"), /devin .* neither bundled nor marked unavailable/)

    const stray = clone(inputs)
    stray.pins.runtimes.push({ ...clone(inputs.pins.runtimes[0]), id: "not-a-runtime" })
    assert.match(validatePins(stray).join("\n"), /not-a-runtime is not in protocol/)

    const noReason = clone(inputs)
    noReason.pins.runtimes.find((runtime) => runtime.id === "cursor-agent").unavailable = " "
    assert.match(validatePins(noReason).join("\n"), /cursor-agent: unavailable must state the reason/)
  })

  it("refuses ranges, a stale lock, missing integrity and unexplained install scripts", () => {
    const inputs = readRepoInputs()

    const range = clone(inputs)
    range.packageJson.dependencies["pi-acp"] = "^0.0.33"
    const rangeProblems = validatePins(range).join("\n")
    assert.match(rangeProblems, /pi-acp is \^0\.0\.33, not an exact version/)
    assert.match(rangeProblems, /was not generated from/)

    const drift = clone(inputs)
    drift.lock.packages["node_modules/pi-acp"].version = "0.0.32"
    assert.match(validatePins(drift).join("\n"), /resolves pi-acp to 0\.0\.32/)

    const unverified = clone(inputs)
    delete unverified.lock.packages["node_modules/pi-acp"].integrity
    assert.match(validatePins(unverified).join("\n"), /node_modules\/pi-acp has no sha512 integrity/)

    const foreign = clone(inputs)
    foreign.lock.packages["node_modules/pi-acp"].resolved = "http://mirror.example/pi-acp.tgz"
    assert.match(validatePins(foreign).join("\n"), /does not resolve from registry\.npmjs\.org/)

    const script = clone(inputs)
    script.pins.installScripts["pi-acp"] = "because"
    assert.match(validatePins(script).join("\n"), /installScripts\.pi-acp has no install script/)
  })

  it("keeps the runtime versions, commands and assets consistent", () => {
    const inputs = readRepoInputs()
    const byId = (pins, id) => pins.runtimes.find((runtime) => runtime.id === id)

    const version = clone(inputs)
    byId(version.pins, "gemini-cli").version = "0.58.0"
    assert.match(validatePins(version).join("\n"), /gemini-cli: version 0\.58\.0 is not @google\/gemini-cli@0\.59\.0/)

    const conflict = clone(inputs)
    byId(conflict.pins, "opencode-acp").commands[0].smoke = "syntax"
    assert.match(validatePins(conflict).join("\n"), /command opencode is defined two different ways/)

    const assets = clone(inputs)
    delete byId(assets.pins, "droid").binary.assets["glibc-arm64"]
    assert.match(validatePins(assets).join("\n"), /droid: assets must be exactly glibc-amd64, glibc-arm64/)

    const checksum = clone(inputs)
    byId(checksum.pins, "kiro-cli").archive.assets["musl-amd64"].sha256 = "ABC"
    assert.match(validatePins(checksum).join("\n"), /kiro-cli\.assets\.musl-amd64\.sha256/)

    const floor = clone(inputs)
    byId(floor.pins, "droid").minGlibc = { amd64: "2.17" }
    assert.match(validatePins(floor).join("\n"), /minGlibc\.amd64 2\.17 is not above node\.minGlibc/)
  })

  it("holds the Dockerfile ARGs, tools and injection root to the pins", () => {
    const inputs = readRepoInputs()

    const node = clone(inputs)
    node.dockerfile = node.dockerfile.replace("ARG NODE_VERSION=26.8.2", "ARG NODE_VERSION=26.8.1")
    assert.match(validatePins(node).join("\n"), /ARG NODE_VERSION=26\.8\.1 disagrees with the pin 26\.8\.2/)

    const root = clone(inputs)
    root.layoutRs = root.layoutRs.replace('"/cognia"', '"/opt/cognia"')
    assert.match(validatePins(root).join("\n"), /INJECTION_ROOT is no longer "\/cognia"/)

    const curl = clone(inputs)
    curl.pins.tools.curl.signingKey = "27edeaf22f3abceb50db9a125cc908fdb71e12c2"
    assert.match(validatePins(curl).join("\n"), /tools\.curl\.signingKey/)

    const ripgrep = clone(inputs)
    ripgrep.pins.tools.ripgrep.assets.arm64.url = "http://github.com/rg.tar.gz"
    assert.match(validatePins(ripgrep).join("\n"), /tools\.ripgrep\.assets\.arm64\.url must be an https URL/)
  })
})

describe("manifest and plans", () => {
  const { pins } = readRepoInputs()

  it("writes the sandboxd manifest for one architecture", () => {
    const manifest = buildManifest(pins, { arch: "amd64", releaseTag: "v1.2.0" })
    assert.equal(manifest.version, 1)
    assert.equal(manifest.minGlibc, "2.28")
    assert.equal(manifest.releaseTag, "v1.2.0")
    const ids = manifest.runtimes.map((runtime) => runtime.id)
    assert.ok(ids.includes("claude-agent-acp"))
    assert.ok(!ids.includes("cursor-agent"), "unavailable runtimes are not in the manifest")
    assert.deepEqual(manifest.runtimes.find((runtime) => runtime.id === "droid").libc, ["glibc"])

    const withFloor = clone(pins)
    withFloor.runtimes.find((runtime) => runtime.id === "droid").minGlibc = { arm64: "2.39" }
    const arm = buildManifest(withFloor, { arch: "arm64", releaseTag: "v1" })
    const amd = buildManifest(withFloor, { arch: "amd64", releaseTag: "v1" })
    assert.equal(arm.runtimes.find((runtime) => runtime.id === "droid").minGlibc, "2.39")
    assert.equal(amd.runtimes.find((runtime) => runtime.id === "droid").minGlibc, undefined)

    assert.throws(() => buildManifest(pins, { arch: "riscv64", releaseTag: "v1" }), /unknown architecture/)
    assert.throws(() => buildManifest(pins, { arch: "amd64", releaseTag: "" }), /release tag/)
  })

  it("plans commands and downloads per libc", () => {
    const musl = commandsFor(pins, "musl").map((command) => command.name)
    assert.equal(new Set(musl).size, musl.length, "opencode appears once")
    assert.ok(musl.includes("claude-agent-acp"))

    assert.deepEqual(
      downloadsFor(pins, "musl", "arm64").map((download) => download.runtimeId),
      ["kiro-cli"]
    )
    const glibc = downloadsFor(pins, "glibc", "amd64")
    assert.deepEqual(
      glibc.map((download) => [download.runtimeId, download.kind]),
      [
        ["kiro-cli", "archive"],
        ["droid", "binary"],
      ]
    )
    assert.match(glibc[1].url, /x64-baseline\/droid$/)

    assert.ok(versionCommandsFor(pins, "glibc").includes("droid"))
    assert.ok(!versionCommandsFor(pins, "musl").includes("droid"))
    assert.ok(!versionCommandsFor(pins, "glibc").includes("claude-agent-acp"))
  })
})

describe("shims", () => {
  it("links native binaries and wraps JavaScript with the bundled node", () => {
    assert.deepEqual(
      shimFor({ libc: "musl", pkg: "@anthropic-ai/claude-code", target: "bin/claude.exe", elf: true }),
      { type: "symlink", target: "../lib/agents/node_modules/@anthropic-ai/claude-code/bin/claude.exe" }
    )
    assert.deepEqual(
      shimFor({ libc: "glibc", pkg: "@google/gemini-cli", target: "./bundle/gemini.js", elf: false }),
      {
        type: "script",
        content:
          '#!/bin/sh\nexec /cognia/glibc/node/bin/node /cognia/glibc/lib/agents/node_modules/@google/gemini-cli/bundle/gemini.js "$@"\n',
      }
    )
  })

  it("reads bin entries in both package.json forms and detects ELF files", () => {
    assert.equal(binTarget({ name: "a", bin: "cli.js" }, "a"), "cli.js")
    assert.equal(binTarget({ name: "b", bin: { b: "dist/b.js", c: "c.js" } }, "b"), "dist/b.js")
    assert.throws(() => binTarget({ name: "b", bin: { c: "c.js" } }, "b"), /has no bin named b/)

    const dir = tempDir()
    writeFileSync(join(dir, "native"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]))
    writeFileSync(join(dir, "script.js"), "#!/usr/bin/env node\n")
    writeFileSync(join(dir, "tiny"), "x")
    assert.equal(isElf(join(dir, "native")), true)
    assert.equal(isElf(join(dir, "script.js")), false)
    assert.equal(isElf(join(dir, "tiny")), false)
  })
})

describe("verified downloads", () => {
  it("keeps a file whose sha256 matches and deletes one that does not", async () => {
    const dir = tempDir()
    const body = Buffer.from("tarball bytes")
    const fetchImpl = fakeFetch({ "https://example.test/a": body })

    assert.equal(await download("https://example.test/a", join(dir, "raw"), { fetchImpl }), sha256(body))
    await downloadVerified("https://example.test/a", sha256(body), join(dir, "ok"), { fetchImpl })
    assert.deepEqual(readFileSync(join(dir, "ok")), body)

    await assert.rejects(
      downloadVerified("https://example.test/a", "0".repeat(64), join(dir, "bad"), { fetchImpl }),
      /has sha256 .* expected 0000/
    )
    assert.equal(existsSync(join(dir, "bad")), false)
    await assert.rejects(
      download("https://example.test/gone", join(dir, "gone"), { fetchImpl }),
      /HTTP 404/
    )
  })

  it("accepts only a valid signature by the pinned primary key", () => {
    const key = "27EDEAF22F3ABCEB50DB9A125CC908FDB71E12C2"
    const good = [
      "[GNUPG:] NEWSIG",
      "[GNUPG:] GOODSIG 5CC908FDB71E12C2 Daniel Stenberg <daniel@haxx.se>",
      `[GNUPG:] VALIDSIG AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA 2026-09-01 1756684800 0 4 0 1 10 00 ${key}`,
    ].join("\n")
    assert.equal(signatureVerdict(good, key), true)
    assert.equal(signatureVerdict(good.replace(key, "914C533DF9B2ADA2204F586D78E11C6B279D5C91"), key), false)
    assert.equal(signatureVerdict(`${good}\n[GNUPG:] BADSIG 5CC908FDB71E12C2 x`, key), false)
    assert.equal(signatureVerdict("[GNUPG:] ERRSIG 5CC908FDB71E12C2 1 10 00 0 9", key), false)
    assert.equal(signatureVerdict("", key), false)
  })

  it("fills lock integrity only from metadata whose tarball matches", async () => {
    const lock = {
      packages: {
        "": {},
        "node_modules/a": { version: "1.0.0", resolved: "https://registry.npmjs.org/a/-/a-1.0.0.tgz", integrity: "sha512-kept" },
        "node_modules/x/node_modules/@s/b": {
          version: "2.0.0",
          resolved: "https://registry.npmjs.org/@s/b/-/b-2.0.0.tgz",
        },
      },
    }
    const metadata = (tarball) =>
      JSON.stringify({ dist: { tarball, integrity: "sha512-filled" } })
    const filled = await fillLockIntegrity(lock, {
      fetchImpl: fakeFetch({
        "https://registry.npmjs.org/@s%2fb/2.0.0": metadata("https://registry.npmjs.org/@s/b/-/b-2.0.0.tgz"),
      }),
    })
    assert.deepEqual(filled, ["@s/b@2.0.0"])
    assert.equal(lock.packages["node_modules/x/node_modules/@s/b"].integrity, "sha512-filled")
    assert.equal(lock.packages["node_modules/a"].integrity, "sha512-kept")

    delete lock.packages["node_modules/x/node_modules/@s/b"].integrity
    await assert.rejects(
      fillLockIntegrity(lock, {
        fetchImpl: fakeFetch({
          "https://registry.npmjs.org/@s%2fb/2.0.0": metadata("https://evil.test/b.tgz"),
        }),
      }),
      /is not the locked/
    )
  })

  it("finds exactly one executable by name", () => {
    const dir = tempDir()
    mkdirSync(join(dir, "kirocli/bin"), { recursive: true })
    writeFileSync(join(dir, "kirocli/bin/kiro-cli"), "bin")
    chmodSync(join(dir, "kirocli/bin/kiro-cli"), 0o755)
    writeFileSync(join(dir, "kirocli/kiro-cli"), "not executable")
    assert.equal(findExecutable(dir, "kiro-cli"), join(dir, "kirocli/bin/kiro-cli"))

    writeFileSync(join(dir, "kiro-cli"), "second")
    chmodSync(join(dir, "kiro-cli"), 0o755)
    assert.throws(() => findExecutable(dir, "kiro-cli"), /found 2/)
    assert.throws(() => findExecutable(dir, "droid"), /found 0/)
  })
})

describe("stage", () => {
  const PINS = {
    version: 1,
    node: { version: "26.8.2", alpine: "3.24", minGlibc: "2.28" },
    installScripts: { "native-cli": "links its binary" },
    runtimes: [
      {
        id: "js-runtime",
        version: "1.0.0",
        libc: ["glibc", "musl"],
        commands: [
          { name: "js", package: "@scope/js-cli", bin: "js", smoke: "version" },
          { name: "js-acp", package: "@scope/js-cli", bin: "js-acp", smoke: "syntax" },
        ],
      },
      {
        id: "native-runtime",
        version: "2.0.0",
        libc: ["musl"],
        commands: [{ name: "native", package: "native-cli", bin: "native", smoke: "version" }],
      },
      {
        id: "vendor",
        version: "3.0.0",
        libc: ["musl"],
        binary: {
          command: "vendor",
          smoke: "version",
          assets: { "musl-amd64": { url: "https://example.test/vendor", sha256: sha256("vendor-bin") } },
        },
      },
      { id: "gone", unavailable: "no checksum" },
    ],
  }

  function fixture() {
    const root = tempDir()
    const tree = join(root, "opt/cognia/musl")
    const agents = join(tree, "lib/agents/node_modules")
    mkdirSync(join(agents, "@scope/js-cli/dist"), { recursive: true })
    writeFileSync(
      join(agents, "@scope/js-cli/package.json"),
      JSON.stringify({ name: "@scope/js-cli", bin: { js: "dist/cli.js", "js-acp": "dist/acp.js" } })
    )
    writeFileSync(join(agents, "@scope/js-cli/dist/cli.js"), "#!/usr/bin/env node\n")
    writeFileSync(join(agents, "@scope/js-cli/dist/acp.js"), "export {}\n")
    mkdirSync(join(agents, "native-cli/bin"), { recursive: true })
    writeFileSync(join(agents, "native-cli/package.json"), JSON.stringify({ name: "native-cli", bin: "bin/native.exe" }))
    writeFileSync(join(agents, "native-cli/bin/native.exe"), Buffer.from([0x7f, 0x45, 0x4c, 0x46]))

    const system = join(root, "system")
    mkdirSync(join(system, "lib"), { recursive: true })
    mkdirSync(join(system, "usr/lib"), { recursive: true })
    writeFileSync(join(system, "lib/ld-musl-x86_64.so.1"), "loader")
    writeFileSync(join(system, "usr/lib/libstdc++.so.6.0.33"), "c++")
    symlinkSync("libstdc++.so.6.0.33", join(system, "usr/lib/libstdc++.so.6"))
    writeFileSync(join(system, "usr/lib/libgcc_s.so.1"), "gcc")
    writeFileSync(join(system, "node"), "node binary")

    const injection = join(root, "cognia")
    symlinkSync(join(root, "opt/cognia"), injection)
    return { root, tree, system, injection }
  }

  it("builds a musl tree: bundled loader, allowlisted scripts, shims, verified vendor binary, smoke runs", async () => {
    const { tree, system, injection } = fixture()
    const calls = []
    const run = (command, args, options) => {
      calls.push({ command, args, cwd: options?.cwd, env: options?.env })
      return { status: 0, stdout: "", stderr: "" }
    }

    await stage({
      pins: PINS,
      libc: "musl",
      arch: "amd64",
      tree,
      run,
      fetchImpl: fakeFetch({ "https://example.test/vendor": Buffer.from("vendor-bin") }),
      execPath: join(system, "node"),
      systemLib: { loaderDir: join(system, "lib"), cxxDir: join(system, "usr/lib") },
      injectionRoot: injection,
      log: () => {},
    })

    assert.equal(readFileSync(join(tree, "node/bin/node"), "utf8"), "node binary")
    assert.equal(readFileSync(join(tree, "node/lib/libstdc++.so.6"), "utf8"), "c++")
    assert.equal(readFileSync(join(tree, "node/lib/ld-musl-x86_64.so.1"), "utf8"), "loader")
    const patchelf = calls.find((call) => call.command === "patchelf")
    assert.deepEqual(patchelf.args, [
      "--set-interpreter",
      `${injection}/musl/node/lib/ld-musl-x86_64.so.1`,
      "--set-rpath",
      "$ORIGIN/../lib",
      join(tree, "node/bin/node"),
    ])

    const rebuild = calls.find((call) => call.command === "npm")
    assert.deepEqual(rebuild.args, ["rebuild", "--foreground-scripts", "native-cli"])
    assert.equal(rebuild.cwd, join(tree, "lib/agents"))

    assert.equal(
      readFileSync(join(tree, "bin/js"), "utf8"),
      `#!/bin/sh\nexec ${injection}/musl/node/bin/node ${injection}/musl/lib/agents/node_modules/@scope/js-cli/dist/cli.js "$@"\n`
    )
    assert.equal(readlinkSync(join(tree, "bin/native")), "../lib/agents/node_modules/native-cli/bin/native.exe")
    assert.equal(readlinkSync(join(tree, "bin/vendor")), "../runtimes/vendor/vendor")
    assert.equal(readFileSync(join(tree, "runtimes/vendor/vendor"), "utf8"), "vendor-bin")

    const smoked = calls
      .filter((call) => call.args.includes("--version") || call.args.includes("--check"))
      .map((call) => [call.command.replace(injection, "<root>"), ...call.args.map((arg) => arg.replace(tree, "<tree>"))])
    assert.deepEqual(smoked, [
      [join(tree, "node/bin/node"), "--version"],
      ["<root>/musl/bin/js", "--version"],
      [join(tree, "node/bin/node"), "--check", "<tree>/lib/agents/node_modules/@scope/js-cli/dist/acp.js"],
      ["<root>/musl/bin/native", "--version"],
      ["<root>/musl/bin/vendor", "--version"],
    ])
  })

  it("refuses a tree the injection root does not reach, a bad checksum and a failing smoke", async () => {
    const base = () => {
      const { tree, system, injection } = fixture()
      return {
        pins: PINS,
        libc: "musl",
        arch: "amd64",
        tree,
        execPath: join(system, "node"),
        systemLib: { loaderDir: join(system, "lib"), cxxDir: join(system, "usr/lib") },
        injectionRoot: injection,
        log: () => {},
      }
    }
    const ok = () => ({ status: 0, stdout: "", stderr: "" })

    const unlinked = base()
    await assert.rejects(
      stage({ ...unlinked, injectionRoot: tempDir(), run: ok }),
      /must resolve to/
    )

    const tampered = base()
    await assert.rejects(
      stage({ ...tampered, run: ok, fetchImpl: fakeFetch({ "https://example.test/vendor": "tampered" }) }),
      /has sha256/
    )

    const broken = base()
    await assert.rejects(
      stage({
        ...broken,
        fetchImpl: fakeFetch({ "https://example.test/vendor": Buffer.from("vendor-bin") }),
        run: (command) =>
          command.endsWith("/bin/native") ? { status: 127, stdout: "", stderr: "not found" } : ok(),
      }),
      /bin\/native --version failed \(status 127\): not found/
    )
  })
})

describe("parseArgs", () => {
  it("reads a mode and --key value pairs", () => {
    assert.deepEqual(parseArgs(["stage", "--libc", "musl", "--arch", "arm64"]), {
      mode: "stage",
      options: { libc: "musl", arch: "arm64" },
    })
    assert.throws(() => parseArgs(["stage", "--libc"]), /--libc needs a value/)
    assert.throws(() => parseArgs(["stage", "musl"]), /unexpected argument musl/)
  })
})
