#!/usr/bin/env node
/**
 * predev guard for the selected Turbopack FileSystem cache mode.
 *
 * Next.js 16.1+ enables `experimental.turbopackFileSystemCacheForDev` by
 * default, persisting compiled modules to `.next/dev/cache/turbopack/` as
 * LSM `.sst` files. The cache restores across dev sessions (fast cold start)
 * but is never size-capped: old generations accumulate — on Windows stale
 * `.sst` files routinely fail to compact away — and the directory can balloon
 * to tens of GB. Next exposes only an on/off flag, no max-size knob, so the
 * only mitigation is to purge periodically.
 *
 * This runs from the `predev` hook. A legacy `.next/dev/cache/webpack`
 * directory proves the dev output was produced by the retired Webpack mode;
 * mixing it with current Turbopack output retained several GB of unreachable
 * chunks, so that one condition rebuilds `.next/dev` from scratch. Otherwise
 * the default cache-off mode removes only `.next/dev/cache/turbopack/`.
 * Cached mode keeps that directory until it exceeds the threshold (default
 * 10 GB, override with TURBOPACK_CACHE_MAX_GB).
 * It must NEVER abort dev startup, so every failure is swallowed and the
 * process always exits 0.
 *
 * Usage:
 *   node scripts/clean-stale-turbopack-cache.mjs
 *   TURBOPACK_CACHE_MAX_GB=5 node scripts/build/clean-stale-turbopack-cache.mjs
 *   node scripts/build/clean-stale-turbopack-cache.mjs --all
 */

import { readdirSync, statSync, rmSync, existsSync } from "node:fs"
import { resolve, join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const BYTES_PER_GB = 1024 ** 3

/** Recursively sum the byte size of every file under `dir`. Missing dir → 0. */
export function dirSizeBytes(dir) {
  if (!existsSync(dir)) return 0
  let total = 0
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
      } else if (entry.isFile()) {
        total += statSync(full).size
      }
    }
  }
  return total
}

/**
 * Purge `cacheDir` when its on-disk size exceeds `thresholdBytes`.
 * Returns `{ cleaned, sizeBytes }`; never throws on a missing directory.
 */
export function cleanStaleTurbopackCache({
  cacheDir,
  thresholdBytes,
  log = console.log,
  label = ".next/dev",
}) {
  const sizeBytes = dirSizeBytes(cacheDir)
  const gb = (sizeBytes / BYTES_PER_GB).toFixed(1)
  const thresholdGb = (thresholdBytes / BYTES_PER_GB).toFixed(1)
  if (sizeBytes > thresholdBytes) {
    rmSync(cacheDir, { recursive: true, force: true })
    log(`[clean-cache] ${label} was ${gb} GB (> ${thresholdGb} GB threshold) — purged.`)
    return { cleaned: true, sizeBytes }
  }
  if (sizeBytes > 0) {
    log(`[clean-cache] ${label} is ${gb} GB (under ${thresholdGb} GB threshold) — kept.`)
  }
  return { cleaned: false, sizeBytes }
}

/** Apply the cache cleanup policy for either default cache-off or opt-in cached mode. */
export function cleanTurbopackCacheForMode({
  cacheDir,
  persistentCacheEnabled,
  thresholdBytes,
  log = console.log,
}) {
  if (persistentCacheEnabled) {
    return cleanStaleTurbopackCache({
      cacheDir,
      thresholdBytes,
      log,
      label: ".next/dev/cache/turbopack",
    })
  }

  const sizeBytes = dirSizeBytes(cacheDir)
  if (existsSync(cacheDir)) {
    rmSync(cacheDir, { recursive: true, force: true })
    log("[clean-cache] persistent Turbopack cache is disabled — purged .next/dev/cache/turbopack.")
    return { cleaned: true, sizeBytes }
  }
  return { cleaned: false, sizeBytes }
}

/** Remove mixed legacy Webpack dev output before the Turbopack server starts. */
export function cleanLegacyWebpackDevArtifacts({ devDir, log = console.log }) {
  const legacyWebpackCache = join(devDir, "cache", "webpack")
  if (!existsSync(legacyWebpackCache)) return { cleaned: false, sizeBytes: 0 }
  const sizeBytes = dirSizeBytes(devDir)
  rmSync(devDir, { recursive: true, force: true })
  log("[clean-cache] legacy Webpack dev artifacts detected — rebuilt .next/dev for Turbopack.")
  return { cleaned: true, sizeBytes }
}

/** Explicit user command: remove both dev output and the production Webpack cache. */
export function cleanAllNextCaches({ nextDir, log = console.log }) {
  const targets = [join(nextDir, "dev"), join(nextDir, "cache", "webpack")]
  let sizeBytes = 0
  let cleaned = false
  for (const target of targets) {
    sizeBytes += dirSizeBytes(target)
    if (!existsSync(target)) continue
    rmSync(target, { recursive: true, force: true })
    cleaned = true
  }
  if (cleaned) log("[clean-cache] removed .next/dev and .next/cache/webpack.")
  return { cleaned, sizeBytes }
}

const __filename = fileURLToPath(import.meta.url)
const isDirectRun = process.argv[1] && resolve(process.argv[1]) === __filename

if (isDirectRun) {
  try {
    const repoRoot = resolve(dirname(__filename), "..", "..")
    const nextDir = join(repoRoot, ".next")
    if (process.argv.includes("--all")) {
      cleanAllNextCaches({ nextDir })
    } else {
      const devDir = join(nextDir, "dev")
      cleanLegacyWebpackDevArtifacts({ devDir })
      const thresholdGb = Number(process.env.TURBOPACK_CACHE_MAX_GB ?? 10)
      cleanTurbopackCacheForMode({
        cacheDir: join(devDir, "cache", "turbopack"),
        persistentCacheEnabled: process.env.COGNIA_TURBOPACK_CACHE === "1",
        thresholdBytes: thresholdGb * BYTES_PER_GB,
      })
    }
  } catch (error) {
    // A maintenance helper must never block `pnpm dev`; degrade to a warning.
    console.warn(`[clean-cache] skipped (${error instanceof Error ? error.message : error})`)
  }
}
