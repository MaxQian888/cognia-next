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
//   1. `npm install` (only if node_modules is missing or stale).
//   2. `npm run build` (tsc) to produce `dist/runner.js` + `dist/index.js`.

import { spawnSync } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const sidecarRoot = join(__dirname, "..", "..", "sidecar", "webclone")
const installOnly = process.argv.includes("--install-only")

function run(cmd, args, opts = {}) {
  // On Windows invoke via the shell so .cmd shims (npm) resolve through PATHEXT.
  const isWin = process.platform === "win32"
  const result = spawnSync(cmd, args, {
    cwd: sidecarRoot,
    stdio: "inherit",
    shell: isWin,
    ...opts,
  })
  if (result.status !== 0) {
    process.stderr.write(
      `[build-webclone-sidecar] '${cmd} ${args.join(" ")}' exited with ${result.status}\n`,
    )
    process.exit(result.status ?? 1)
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

function main() {
  if (!existsSync(sidecarRoot)) {
    process.stderr.write(`[build-webclone-sidecar] not found at ${sidecarRoot}; skipping\n`)
    return
  }

  if (shouldInstall()) {
    process.stdout.write("[build-webclone-sidecar] installing dependencies\n")
    run("npm", ["install", "--no-audit", "--no-fund"])
  }

  if (installOnly) {
    process.stdout.write("[build-webclone-sidecar] install-only mode; skipping tsc\n")
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

main()
