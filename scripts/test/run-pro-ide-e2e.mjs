#!/usr/bin/env node
/**
 * Build everything the real-binary Pro IDE E2E needs, then run it.
 *
 * `lib/plugin/ide/real-code-server.e2e.test.ts` drives a real code-server
 * through the production pieces; this assembles them:
 *
 *   1. the pinned code-server: `COGNIA_CODE_SERVER_BIN` if set, otherwise the
 *      release tarball for this platform, downloaded once into
 *      `target/code-server/` and checked against the digest the app itself
 *      pins (`crates/cognia-codeserver/src/download.rs`);
 *   2. the broker VSIX (`pnpm sidecar:codeserver-agent:build`);
 *   3. the vscode-ext-host sidecar (`pnpm sidecar:vscode:build`), which
 *      supervises the protocol servers;
 *   4. the `codeserver-e2e-host` binary (feature `e2e-host`).
 *
 * Then Jest runs the suite, which writes `target/pro-ide-perf.json`; with
 * `--perf` the performance gate checks it (`pnpm audit:pro-ide-perf`).
 *
 * Usage:
 *   pnpm test:pro-ide:e2e [--perf] [--skip-build] [-- <extra perf-gate args>]
 */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const DOWNLOAD_RS = join(REPO_ROOT, "crates", "cognia-codeserver", "src", "download.rs")

/** code-server's names for this machine, as `download.rs` spells them. */
export function codeServerPlatform(platform = process.platform, arch = process.arch) {
  const os = { linux: "linux", darwin: "macos" }[platform]
  const cpu = { x64: "amd64", arm64: "arm64" }[arch]
  if (!os || !cpu) throw new Error(`code-server has no release for ${platform}-${arch}`)
  return { os, arch: cpu }
}

/** The pinned version and this platform's digest, read from the app's own pin. */
export function pinnedRelease(source, { os, arch }) {
  const version = /pub const CODE_SERVER_VERSION: &str = "([^"]+)"/.exec(source)?.[1]
  if (!version) throw new Error("download.rs: CODE_SERVER_VERSION not found")
  const digest = new RegExp(`\\("${os}", "${arch}"\\) => \\{\\s*Some\\("([0-9a-f]{64})"\\)`).exec(
    source
  )?.[1]
  if (!digest) throw new Error(`download.rs: no pinned digest for ${os}-${arch}`)
  const asset = `code-server-${version}-${os}-${arch}.tar.gz`
  return {
    version,
    digest,
    asset,
    url: `https://github.com/coder/code-server/releases/download/v${version}/${asset}`,
    directory: asset.replace(/\.tar\.gz$/, ""),
  }
}

async function sha256(file) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest("hex")
}

function run(command, args, options = {}) {
  console.log(`$ ${command} ${args.join(" ")}`)
  const result = spawnSync(command, args, { cwd: REPO_ROOT, stdio: "inherit", ...options })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${result.status ?? result.signal}`)
  }
}

/** A verified code-server binary for this machine, downloading it once if needed. */
export async function ensureCodeServer(env = process.env) {
  if (env.COGNIA_CODE_SERVER_BIN) return env.COGNIA_CODE_SERVER_BIN
  const release = pinnedRelease(readFileSync(DOWNLOAD_RS, "utf8"), codeServerPlatform())
  const root = join(REPO_ROOT, "target", "code-server")
  const binary = join(root, release.directory, "bin", "code-server")
  if (existsSync(binary)) return binary
  mkdirSync(root, { recursive: true })
  const tarball = join(root, release.asset)
  if (!existsSync(tarball)) {
    console.log(`downloading ${release.url}`)
    const response = await fetch(release.url)
    if (!response.ok) throw new Error(`${release.url}: HTTP ${response.status}`)
    await writeFile(tarball, Buffer.from(await response.arrayBuffer()))
  }
  const actual = await sha256(tarball)
  if (actual !== release.digest) {
    rmSync(tarball, { force: true })
    throw new Error(`${release.asset}: sha256 ${actual}, pinned ${release.digest}`)
  }
  run("tar", ["-xzf", tarball, "-C", root])
  if (!existsSync(binary)) throw new Error(`${binary} missing after extracting ${release.asset}`)
  return binary
}

export async function main(args = process.argv.slice(2)) {
  const separator = args.indexOf("--")
  const own = separator === -1 ? args : args.slice(0, separator)
  const gateArgs = separator === -1 ? [] : args.slice(separator + 1)
  const codeServer = await ensureCodeServer()
  if (!own.includes("--skip-build")) {
    run("pnpm", ["-s", "sidecar:codeserver-agent:build"])
    run("pnpm", ["-s", "sidecar:vscode:build"])
    run("cargo", [
      "build",
      "-p",
      "cognia-codeserver",
      "--features",
      "e2e-host",
      "--bin",
      "codeserver-e2e-host",
    ])
  }
  run(
    "pnpm",
    ["-s", "exec", "jest", "lib/plugin/ide/real-code-server.e2e.test.ts", "--runInBand"],
    {
      env: { ...process.env, COGNIA_CODE_SERVER_BIN: codeServer },
    }
  )
  if (own.includes("--perf")) {
    run("node", ["scripts/gates/check-pro-ide-perf.mjs", ...gateArgs])
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
