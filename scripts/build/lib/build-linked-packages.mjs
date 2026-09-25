// Shared by the sidecar build scripts: rebuild a workspace package's compiled
// `dist/` only when its own sources moved (ADR-0068 C4).
//
// A sidecar that ships its `node_modules` inside the Tauri bundle cannot load a
// linked workspace package's TypeScript source: the bundle copy lands under
// `node_modules`, where Node refuses to strip types
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING). Those packages route Node to
// `dist/`, and these helpers keep that output current without paying for a
// rebuild on every prebuild.

import { existsSync } from "node:fs"
import { basename, join } from "node:path"

import { newestMtimeMs } from "./newest-mtime.mjs"

/**
 * Is the package's `dist/` newer than every build input?
 *
 * Inputs are `src/**` plus the package-root `.json`/`.ts` files (package.json,
 * tsconfig, tsup.config) that change the output. The check has to run BEFORE
 * tsup: tsup's `clean: true` rewrites every file in `dist/`, so an
 * unconditional build would always read as "just changed" downstream.
 */
export function isPackageBuildFresh(pkgDir) {
  const newestSrc = Math.max(
    newestMtimeMs(join(pkgDir, "src")),
    newestMtimeMs(pkgDir, { exts: [".json", ".ts"] })
  )
  const dist = join(pkgDir, "dist")
  const builtAt = existsSync(dist) ? newestMtimeMs(dist) : 0
  return builtAt > 0 && newestSrc > 0 && builtAt > newestSrc
}

/**
 * Build each stale package with `pnpm --filter @cognia/<dir> run build`.
 *
 * `run(cmd, args, opts)` is the caller's process runner, so each script keeps
 * its own failure reporting and exit policy.
 */
export function buildLinkedPackages(pkgDirs, { label, repoRoot, run, write = (s) => process.stdout.write(s) }) {
  for (const pkgDir of pkgDirs) {
    const name = basename(pkgDir)
    if (isPackageBuildFresh(pkgDir)) {
      write(`[${label}] @cognia/${name} up to date; skipping build\n`)
      continue
    }
    write(`[${label}] building @cognia/${name}\n`)
    run("pnpm", ["--filter", `@cognia/${name}`, "run", "build"], { cwd: repoRoot })
  }
}
