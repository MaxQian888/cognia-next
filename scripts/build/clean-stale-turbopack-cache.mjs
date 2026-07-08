#!/usr/bin/env node
/**
 * predev guard against unbounded Turbopack FileSystem cache growth.
 *
 * Next.js 16.1+ enables `experimental.turbopackFileSystemCacheForDev` by
 * default, persisting compiled modules to `.next/dev/cache/turbopack/` as
 * LSM `.sst` files. The cache restores across dev sessions (fast cold start)
 * but is never size-capped: old generations accumulate — on Windows stale
 * `.sst` files routinely fail to compact away — and the directory can balloon
 * to tens of GB. Next exposes only an on/off flag, no max-size knob, so the
 * only mitigation is to purge periodically.
 *
 * This runs from the `predev` hook: if `.next/dev` exceeds the threshold
 * (default 10 GB, override with TURBOPACK_CACHE_MAX_GB) it is removed before
 * `next dev` starts, trading one slower cold start for bounded disk usage.
 * It must NEVER abort dev startup, so every failure is swallowed and the
 * process always exits 0.
 *
 * Usage:
 *   node scripts/clean-stale-turbopack-cache.mjs
 *   TURBOPACK_CACHE_MAX_GB=5 node scripts/clean-stale-turbopack-cache.mjs
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

const __filename = fileURLToPath(import.meta.url)
const isDirectRun = process.argv[1] && resolve(process.argv[1]) === __filename

if (isDirectRun) {
  try {
    const repoRoot = resolve(dirname(__filename), "..", "..")
    const thresholdGb = Number(process.env.TURBOPACK_CACHE_MAX_GB ?? 10)
    cleanStaleTurbopackCache({
      cacheDir: join(repoRoot, ".next", "dev"),
      thresholdBytes: thresholdGb * BYTES_PER_GB,
    })
  } catch (error) {
    // A maintenance helper must never block `pnpm dev`; degrade to a warning.
    console.warn(`[clean-cache] skipped (${error instanceof Error ? error.message : error})`)
  }
}
