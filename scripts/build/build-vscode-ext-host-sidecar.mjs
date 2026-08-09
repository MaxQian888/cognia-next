#!/usr/bin/env node

// Build the `sidecar/vscode-ext-host` Node sidecar that hosts VS Code
// extensions inside Tauri. This script is idempotent and ran in three
// situations:
//   1. `prebuild` (root) — before `next build` / `tauri build`.
//   2. `sidecar:vscode:install` — install dependencies only (--install-only flag).
//   3. Manual invocation when the sidecar source changes.
//
// The sidecar lives outside the pnpm workspace (per CLAUDE.md) and has
// its own lockfile. We:
//   1. `npm install` (only if node_modules is missing or stale).
//   2. `npm run build` (tsc) to produce `dist/host.js`.

import { existsSync, statSync } from "node:fs"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Command, CommanderError } from "commander"
import { execaSync } from "execa"
import { z } from "zod"

import { newestMtimeMs } from "./lib/newest-mtime.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const sidecarRoot = join(__dirname, "..", "..", "sidecar", "vscode-ext-host")

function run(cmd, args, opts = {}) {
  const result = execaSync(cmd, args, {
    cwd: sidecarRoot,
    stdio: "inherit",
    reject: false,
    ...opts,
  })
  if (result.exitCode !== 0 || result.signal) {
    process.stderr.write(
      `[build-vscode-ext-host-sidecar] '${cmd} ${args.join(" ")}' exited with ${result.exitCode ?? result.signal}\n`
    )
    process.exit(result.exitCode ?? 1)
  }
}

function shouldInstall() {
  const nm = join(sidecarRoot, "node_modules")
  if (!existsSync(nm)) return true
  const pkgLock = join(sidecarRoot, "package-lock.json")
  const pkgJson = join(sidecarRoot, "package.json")
  if (!existsSync(pkgLock)) return true
  try {
    return statSync(pkgJson).mtimeMs > statSync(pkgLock).mtimeMs
  } catch {
    return true
  }
}

function main({ installOnly = false } = {}) {
  if (!existsSync(sidecarRoot)) {
    process.stderr.write(`[build-vscode-ext-host-sidecar] not found at ${sidecarRoot}; skipping\n`)
    return
  }

  if (shouldInstall()) {
    process.stdout.write("[build-vscode-ext-host-sidecar] installing dependencies\n")
    run("npm", ["install", "--no-audit", "--no-fund"])
  }

  if (installOnly) {
    process.stdout.write("[build-vscode-ext-host-sidecar] install-only mode; skipping tsc\n")
    return
  }

  // ADR-0068 C4 — skip the (previously unconditional) tsc when dist is
  // already newer than every source input, mirroring copy-monaco-assets.mjs's
  // freshness skip. Sources = src/**/* plus the root-level build inputs
  // (package.json / tsconfig.json) that change the output.
  const distMain = join(sidecarRoot, "dist", "host.js")
  const newestSrc = Math.max(
    newestMtimeMs(join(sidecarRoot, "src")),
    newestMtimeMs(sidecarRoot, { exts: [".json"] }),
  )
  if (existsSync(distMain) && newestSrc > 0 && statSync(distMain).mtimeMs > newestSrc) {
    process.stdout.write("[build-vscode-ext-host-sidecar] dist up to date; skipping tsc\n")
    return
  }

  process.stdout.write("[build-vscode-ext-host-sidecar] building (tsc)\n")
  run("npm", ["run", "build"])

  const dist = join(sidecarRoot, "dist", "host.js")
  if (!existsSync(dist)) {
    process.stderr.write(
      "[build-vscode-ext-host-sidecar] expected dist/host.js (sidecar/vscode-ext-host) but it was not produced\n"
    )
    process.exit(1)
  }
  process.stdout.write(`[build-vscode-ext-host-sidecar] ok -> ${dist}\n`)
}

const cliSchema = z.object({ installOnly: z.boolean().default(false) })

function createProgram() {
  return new Command()
    .name("pnpm sidecar:vscode:build")
    .description("Install and build the VS Code extension-host sidecar.")
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
