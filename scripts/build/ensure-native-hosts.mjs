// Build the native host binaries the CLI bundle copies (the external-agent
// launcher, the one-shot sandbox executor, and the task-workspace worker) only
// when their Rust sources are newer than the last release build.
//
// `precli:dev` used to run `cargo build --release` for both crates on EVERY
// `pnpm cli:dev`, which made a one-line TypeScript iteration pay a Rust
// release link. `precli:build` and `precli:build:binary` stay unconditional:
// a release must never trust mtimes.
//
// `COGNIA_SKIP_NATIVE_HOSTS=1` skips the check entirely (CI images that ship
// the binaries, or a machine with no Rust toolchain that only needs the JS).

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

export const NATIVE_HOSTS = [
  {
    crate: "cognia-automation",
    bin: "cognia-external-agent-launcher",
    dir: "crates/cognia-automation",
  },
  {
    crate: "cognia-automation",
    bin: "cognia-sandbox-exec",
    dir: "crates/cognia-automation",
  },
  {
    crate: "cognia-task-workspace",
    bin: "cognia-task-workspace-worker",
    dir: "crates/cognia-task-workspace",
  },
]

/**
 * Pure: whether an output built at `outputMtimeMs` (undefined when it does
 * not exist) is older than any of its sources. `stampMtimeMs` is the time of
 * the last build this driver ran, when known. Cargo does not touch an
 * up-to-date binary, so after a no-op build the binary stays older than
 * sources whose mtime moved without their content (a checkout, a touch).
 * The stamp is what proves those sources were already considered.
 */
export function isStale(outputMtimeMs, sourceMtimesMs, stampMtimeMs) {
  if (outputMtimeMs === undefined || outputMtimeMs === null) return true
  const reference = Math.max(outputMtimeMs, stampMtimeMs ?? 0)
  for (const mtime of sourceMtimesMs) {
    if (mtime > reference) return true
  }
  return false
}

function walkMtimes(dir, out) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name === "target" || entry.name === "node_modules" || entry.name.startsWith(".")) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkMtimes(full, out)
    else if (entry.name.endsWith(".rs") || entry.name === "Cargo.toml") out.push(fs.statSync(full).mtimeMs)
  }
}

export function sourceMtimes(host, repoRoot = root) {
  const out = []
  walkMtimes(path.join(repoRoot, host.dir), out)
  const lock = path.join(repoRoot, "Cargo.lock")
  if (fs.existsSync(lock)) out.push(fs.statSync(lock).mtimeMs)
  return out
}

export function outputPath(host, repoRoot = root) {
  const name = process.platform === "win32" ? `${host.bin}.exe` : host.bin
  return path.join(repoRoot, "target", "release", name)
}

export function stampPath(host, repoRoot = root) {
  return path.join(repoRoot, "target", "release", `.${host.bin}.cognia-stamp`)
}

export function plan(repoRoot = root, env = process.env) {
  if (env.COGNIA_SKIP_NATIVE_HOSTS === "1") return { skipped: true, stale: [] }
  const stale = NATIVE_HOSTS.filter((host) => {
    const output = outputPath(host, repoRoot)
    const outputMtime = fs.existsSync(output) ? fs.statSync(output).mtimeMs : undefined
    const stamp = stampPath(host, repoRoot)
    const stampMtime = fs.existsSync(stamp) ? fs.statSync(stamp).mtimeMs : undefined
    return isStale(outputMtime, sourceMtimes(host, repoRoot), stampMtime)
  })
  return { skipped: false, stale }
}

/** Record that every source seen now has been built. */
export function writeStamp(host, repoRoot = root) {
  const stamp = stampPath(host, repoRoot)
  fs.mkdirSync(path.dirname(stamp), { recursive: true })
  fs.writeFileSync(stamp, `${new Date().toISOString()}\n`)
}

function main() {
  const { skipped, stale } = plan()
  if (skipped) {
    console.log("ensure-native-hosts: skipped (COGNIA_SKIP_NATIVE_HOSTS=1)")
    return 0
  }
  if (stale.length === 0) {
    console.log("ensure-native-hosts: release binaries are newer than their sources, nothing to build")
    return 0
  }
  for (const host of stale) {
    console.log(`ensure-native-hosts: building ${host.bin} (${host.crate})`)
    const result = spawnSync("cargo", ["build", "-p", host.crate, "--bin", host.bin, "--release"], {
      cwd: root,
      stdio: "inherit",
    })
    if (result.status !== 0) return result.status ?? 1
    writeStamp(host)
  }
  return 0
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirectRun) process.exit(main())
