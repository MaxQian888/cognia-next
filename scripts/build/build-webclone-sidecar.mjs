#!/usr/bin/env node

// Build the `sidecar/webclone` engine — the vendored web-clone snapshot library
// (HTML + asset mirroring → self-contained file/bundle, component extraction,
// framework codegen). This script is idempotent and runs in three situations:
//   1. `prebuild` (root) — before `next build` / `tauri build`.
//   2. `sidecar:webclone:install` — install dependencies only (--install-only).
//   3. Manual invocation when the vendored source changes.
//
// The engine lives outside the pnpm workspace (per CLAUDE.md), has its own
// lockfile and heavy Node-only deps (linkedom / @babel / proxy-agents) that must
// never reach the static-export renderer bundle. We:
//   1. `pnpm --filter @cognia/network-guard build` — the engine's SSRF guard is
//      a thin adapter over that package, and npm packs a `file:` dependency
//      from its `files` list, so `dist/` must exist BEFORE the install below.
//   2. `npm install --install-links` (only if node_modules is missing or stale).
//   3. `npm run build` (tsc) to produce `dist/runner.js` + `dist/index.js`.
//
// `--install-links` is load-bearing, for two independent reasons:
//   - Tauri bundles `../sidecar/webclone/node_modules/**/*` as resources
//     (tauri.conf.json). A symlink out to `packages/network-guard` does not
//     survive that copy, so the shipped app would have a dangling dependency.
//   - Node refuses to strip types from any file under `node_modules`
//     (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so the physically
//     installed copy must be the package's COMPILED `dist/`, never its source.

import { existsSync, lstatSync, rmSync, statSync } from "node:fs"
import { join, dirname, resolve, basename } from "node:path"
import { fileURLToPath } from "node:url"
import { Command, CommanderError } from "commander"
import { execaSync } from "execa"
import { z } from "zod"

import { newestMtimeMs } from "./lib/newest-mtime.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, "..", "..")
const sidecarRoot = join(repoRoot, "sidecar", "webclone")
// Workspace packages the engine depends on via `file:` — built here and
// installed physically, so their freshness gates the install below.
export const linkedPackages = [join(repoRoot, "packages", "network-guard")]

function run(cmd, args, opts = {}) {
  const result = execaSync(cmd, args, {
    cwd: sidecarRoot,
    stdio: "inherit",
    reject: false,
    ...opts,
  })
  if (result.exitCode !== 0 || result.signal) {
    process.stderr.write(
      `[build-webclone-sidecar] '${cmd} ${args.join(" ")}' exited with ${result.exitCode ?? result.signal}\n`
    )
    process.exit(result.exitCode ?? 1)
  }
}

/**
 * Rebuild a `file:` workspace package only when its own sources moved.
 *
 * The freshness check has to happen BEFORE tsup runs: tsup is configured with
 * `clean: true`, so an unconditional build rewrites every file in `dist/` with
 * a new mtime, which then reads as "the linked package changed" and cascades
 * into a reinstall and a full `tsc` on every single prebuild — defeating the
 * ADR-0068 C4 cache skip this script exists to honour.
 */
function buildLinkedPackages() {
  for (const pkg of linkedPackages) {
    const name = basename(pkg)
    const dist = join(pkg, "dist")
    // Sources = src/**/* plus the root build inputs (package.json, tsconfig,
    // tsup.config) that change the output.
    const newestSrc = Math.max(
      newestMtimeMs(join(pkg, "src")),
      newestMtimeMs(pkg, { exts: [".json", ".ts"] })
    )
    const builtAt = existsSync(dist) ? newestMtimeMs(dist) : 0
    if (builtAt > 0 && newestSrc > 0 && builtAt > newestSrc) {
      process.stdout.write(`[build-webclone-sidecar] @cognia/${name} up to date; skipping build\n`)
      continue
    }
    process.stdout.write(`[build-webclone-sidecar] building @cognia/${name}\n`)
    run("pnpm", ["--filter", `@cognia/${name}`, "run", "build"], { cwd: repoRoot })
  }
}

/** Path of a linked package as installed into the engine's node_modules. */
function installedPathOf(pkg) {
  return join(sidecarRoot, "node_modules", "@cognia", basename(pkg))
}

/**
 * Oldest mtime across the installed copies, or 0 when one is missing. The
 * OLDEST is the right reading: one stale copy has to force the reinstall even
 * when a sibling is current.
 */
function installedLinkedPackageMs() {
  let oldest = Infinity
  for (const pkg of linkedPackages) {
    const dist = join(installedPathOf(pkg), "dist")
    if (!existsSync(dist)) return 0
    const newest = newestMtimeMs(dist)
    if (newest === 0) return 0
    oldest = Math.min(oldest, newest)
  }
  return Number.isFinite(oldest) ? oldest : 0
}

/**
 * Fail loudly when npm resolved a `file:` dependency to a symlink anyway.
 *
 * This is the check that keeps the failure at build time. A symlink here
 * produces a Tauri bundle whose webclone resources reference a path that does
 * not exist on the user's machine, and the engine dies on its first snapshot
 * with a bare module-not-found — a long way from the cause.
 */
function assertLinkedPackagesArePhysical() {
  for (const pkg of linkedPackages) {
    const installed = installedPathOf(pkg)
    let stats
    try {
      stats = lstatSync(installed)
    } catch {
      process.stderr.write(
        `[build-webclone-sidecar] @cognia/${basename(pkg)} was not installed at ${installed}\n`
      )
      process.exit(1)
    }
    if (stats.isSymbolicLink()) {
      process.stderr.write(
        `[build-webclone-sidecar] @cognia/${basename(pkg)} installed as a SYMLINK at ${installed}; ` +
          "Tauri cannot bundle it. Re-run with --install-links.\n"
      )
      process.exit(1)
    }
    if (!existsSync(join(installed, "dist", "index.js"))) {
      process.stderr.write(
        `[build-webclone-sidecar] @cognia/${basename(pkg)} is installed but has no dist/index.js; ` +
          "the package was packed before it was built.\n"
      )
      process.exit(1)
    }
  }
}

/**
 * Remove installed copies of `file:` packages whose source has moved on.
 *
 * This is the step that makes the staleness check mean anything. `npm install`
 * treats a `file:` dependency as satisfied when the installed version matches
 * the spec — the version here never changes (`0.0.0`, private), so npm reports
 * "up to date" and leaves the old COPY in place no matter how stale it is. The
 * only reliable way to make npm re-copy is to hand it a missing directory.
 *
 * Returns true when anything was evicted, i.e. an install is now required.
 */
/** Is an installed copy older than the build it was taken from? */
export function isLinkedCopyStale(builtAt, copiedAt) {
  // A copy that carries no mtime at all (missing or empty dist) is stale by
  // definition; so is one older than the build it came from. Equal counts as
  // current — npm stamps the copy at or after the moment it was packed.
  if (copiedAt <= 0 || builtAt <= 0) return true
  return copiedAt < builtAt
}

function evictStaleLinkedPackages() {
  let evicted = false
  for (const pkg of linkedPackages) {
    const installed = installedPathOf(pkg)
    if (!existsSync(installed)) continue
    const builtAt = newestMtimeMs(join(pkg, "dist"))
    const copiedAt = newestMtimeMs(join(installed, "dist"))
    if (!isLinkedCopyStale(builtAt, copiedAt)) continue
    process.stdout.write(
      `[build-webclone-sidecar] @cognia/${basename(pkg)} copy is stale; evicting for reinstall\n`
    )
    rmSync(installed, { recursive: true, force: true })
    evicted = true
  }
  return evicted
}

function shouldInstall() {
  const nm = join(sidecarRoot, "node_modules")
  if (!existsSync(nm)) return true
  const pkgLock = join(sidecarRoot, "package-lock.json")
  const pkgJson = join(sidecarRoot, "package.json")
  if (!existsSync(pkgLock)) return true
  // A rebuilt `file:` package leaves package.json and the lockfile untouched,
  // so a missing or evicted copy is the signal that an install is due.
  if (installedLinkedPackageMs() === 0) return true
  try {
    return statSync(pkgJson).mtimeMs > statSync(pkgLock).mtimeMs
  } catch {
    return true
  }
}

function main({ installOnly = false } = {}) {
  if (!existsSync(sidecarRoot)) {
    process.stderr.write(`[build-webclone-sidecar] not found at ${sidecarRoot}; skipping\n`)
    return
  }

  // The engine's SSRF guard is an adapter over @cognia/network-guard, and npm
  // packs a `file:` dependency from its `files` list — `dist/` has to be there
  // before the install, and current before the copy is trusted.
  buildLinkedPackages()
  const evicted = evictStaleLinkedPackages()

  if (evicted || shouldInstall()) {
    process.stdout.write("[build-webclone-sidecar] installing dependencies\n")
    // --install-links: copy `file:` deps instead of symlinking them. See the
    // header — Tauri resource bundling and Node's node_modules type-stripping
    // refusal both require a physical directory.
    run("npm", ["install", "--no-audit", "--no-fund", "--install-links"])
    assertLinkedPackagesArePhysical()
  }

  if (installOnly) {
    process.stdout.write("[build-webclone-sidecar] install-only mode; skipping tsc\n")
    return
  }

  // ADR-0068 C4 — skip the (previously unconditional) tsc when dist is
  // already newer than every source input, mirroring copy-monaco-assets.mjs's
  // freshness skip. Sources = src/**/* plus the root-level build inputs
  // (package.json / tsconfig.json) that change the output.
  const distMain = join(sidecarRoot, "dist", "runner.js")
  const newestSrc = Math.max(
    newestMtimeMs(join(sidecarRoot, "src")),
    newestMtimeMs(sidecarRoot, { exts: [".json"] }),
  )
  if (existsSync(distMain) && newestSrc > 0 && statSync(distMain).mtimeMs > newestSrc) {
    process.stdout.write("[build-webclone-sidecar] dist up to date; skipping tsc\n")
    return
  }

  process.stdout.write("[build-webclone-sidecar] building (tsc)\n")
  run("npm", ["run", "build"])

  const dist = join(sidecarRoot, "dist", "runner.js")
  if (!existsSync(dist)) {
    process.stderr.write(
      "[build-webclone-sidecar] expected dist/runner.js (sidecar/webclone) but it was not produced\n",
    )
    process.exit(1)
  }
  process.stdout.write(`[build-webclone-sidecar] ok -> ${dist}\n`)
}

const cliSchema = z.object({ installOnly: z.boolean().default(false) })

function createProgram() {
  return new Command()
    .name("pnpm sidecar:webclone:build")
    .description("Install and build the web-clone sidecar.")
    .configureOutput({ writeErr: () => {} })
    .showHelpAfterError()
    .exitOverride()
    .option("--install-only", "Install dependencies without building the sidecar.")
}

export function parseArgs(argv) {
  const program = createProgram()
  try {
    program.parse(argv, { from: "user" })
  } catch (error) {
    if (error instanceof CommanderError && error.code === "commander.helpDisplayed") return null
    throw error
  }
  return cliSchema.parse(program.opts())
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const options = parseArgs(process.argv.slice(2))
  if (options) main(options)
}
