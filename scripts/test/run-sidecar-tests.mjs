#!/usr/bin/env node

// The one entry point for the Claude sidecar's `node --test` suites.
//
// Before this runner, the root `sidecar:test:*` scripts and sidecar/package.json
// each spelled out folder-by-folder globs, and the two lists drifted: suites
// that no glob named (builtin-tools/run-code) ran nowhere, and live suites that
// spawn the real host ran inside the unit sweep. This walks the tree instead,
// so a new suite is picked up by being named `*.test.mjs` / `*.test.ts`.
//
//   node scripts/test/run-sidecar-tests.mjs            every unit suite
//   node scripts/test/run-sidecar-tests.mjs --live     every *.live.test.* suite
//   node scripts/test/run-sidecar-tests.mjs <paths…>   just these files
//
// Concurrency comes from SIDECAR_TEST_CONCURRENCY (default: half the cores,
// at most 4) so a laptop shared with other work is not saturated.

import { spawnSync } from "node:child_process"
import { globSync } from "node:fs"
import { availableParallelism } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

/**
 * Top-level packages nested in sidecar/ that own their test runners (npm/tsc
 * projects run by `sidecars:test`). `builtin-tools/webclone` is the sidecar's
 * own tool category and stays in.
 */
export const NESTED_PACKAGES = ["vscode-ext-host", "webclone", "codeserver-agent-ext"]

/** Is this repo-relative sidecar path outside the Claude sidecar's own suites? */
export function isExcludedPath(path) {
  const segments = path.split(/[\\/]/)
  return (
    segments.includes("node_modules") ||
    (segments[0] === "sidecar" && NESTED_PACKAGES.includes(segments[1]))
  )
}

const LIVE_SUITE = /\.live\.test\.(mjs|ts)$/

/** Is this a suite that drives the real host / SDK subprocess? */
export function isLiveSuite(file) {
  return LIVE_SUITE.test(file)
}

/** Repo-relative, sorted sidecar suites; `live` picks the live ones instead of the unit ones. */
export function discoverSidecarSuites({ root = repoRoot, live = false } = {}) {
  const files = globSync("sidecar/**/*.test.{mjs,ts}", {
    cwd: root,
    exclude: isExcludedPath,
  })
  return files
    .map((file) => file.split("\\").join("/"))
    .filter((file) => isLiveSuite(file) === live)
    .sort()
}

export function defaultConcurrency(env = process.env, cores = availableParallelism()) {
  const requested = Number.parseInt(env.SIDECAR_TEST_CONCURRENCY ?? "", 10)
  if (Number.isInteger(requested) && requested > 0) return requested
  return Math.max(1, Math.min(4, Math.floor(cores / 2)))
}

/** @returns {{ live: boolean, files: string[] }} */
export function parseArgs(argv, root = repoRoot, cwd = process.cwd()) {
  let live = false
  const files = []
  for (const arg of argv) {
    if (arg === "--live") live = true
    else if (arg.startsWith("-")) throw new Error(`unknown option ${arg}`)
    else files.push(relative(root, resolve(cwd, arg)).split("\\").join("/"))
  }
  return { live, files }
}

function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`[run-sidecar-tests] ${error.message}\n`)
    process.exit(2)
  }
  const files =
    options.files.length > 0 ? options.files : discoverSidecarSuites({ live: options.live })
  if (files.length === 0) {
    process.stderr.write(`[run-sidecar-tests] no ${options.live ? "live " : ""}suites matched\n`)
    process.exit(1)
  }
  const concurrency = defaultConcurrency()
  process.stdout.write(
    `[run-sidecar-tests] ${files.length} ${options.live ? "live " : ""}suite(s), concurrency ${concurrency}\n`
  )
  const result = spawnSync(
    process.execPath,
    ["--test", `--test-concurrency=${concurrency}`, ...files],
    {
      cwd: repoRoot,
      stdio: "inherit",
    }
  )
  if (result.error) throw result.error
  process.exit(result.status ?? 1)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main()
}
