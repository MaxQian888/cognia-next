#!/usr/bin/env node
/**
 * prestorybook guard against unbounded Storybook build-cache growth.
 *
 * `.storybook/main.ts` enables the persistent webpack filesystem cache
 * (`fsCache: true`), which writes pack files to `node_modules/.cache/webpack/`
 * (one dir per build: `preview-development`, `preview-production`). Storybook
 * itself keeps its own cache under `node_modules/.cache/storybook/`. Neither
 * is size-capped: config changes strand whole cache generations, and the
 * directories were observed at 12 GB + 2.3 GB. main.ts now sets
 * `cache.maxAge`/`compression` to slow the growth, but maxAge only prunes on
 * *successful* cache reuse — stranded generations still accumulate, so we
 * mirror the `predev` turbopack guard: purge each cache dir when it exceeds
 * the threshold (default 5 GB per dir, override with WEBPACK_CACHE_MAX_GB),
 * trading one slower cold compile for bounded disk usage.
 *
 * Like the predev guard, this must NEVER abort `pnpm storybook`, so every
 * failure is swallowed and the process always exits 0.
 *
 * Usage:
 *   node scripts/build/clean-stale-webpack-cache.mjs
 *   WEBPACK_CACHE_MAX_GB=2 node scripts/build/clean-stale-webpack-cache.mjs
 */

import { resolve, join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { cleanStaleTurbopackCache } from "./clean-stale-turbopack-cache.mjs"

const BYTES_PER_GB = 1024 ** 3

/** Cache dirs the Storybook toolchain writes, relative to the repo root. */
export const STORYBOOK_CACHE_DIRS = [
  join("node_modules", ".cache", "webpack"),
  join("node_modules", ".cache", "storybook"),
]

/**
 * Purge every Storybook-toolchain cache dir that exceeds `thresholdBytes`.
 * Returns one `{ cleaned, sizeBytes, label }` entry per dir; never throws on
 * missing directories.
 */
export function cleanStaleStorybookCaches({ repoRoot, thresholdBytes, log = console.log }) {
  return STORYBOOK_CACHE_DIRS.map((rel) => {
    const result = cleanStaleTurbopackCache({
      cacheDir: join(repoRoot, rel),
      thresholdBytes,
      log,
      label: rel,
    })
    return { ...result, label: rel }
  })
}

const __filename = fileURLToPath(import.meta.url)
const isDirectRun = process.argv[1] && resolve(process.argv[1]) === __filename

if (isDirectRun) {
  try {
    const repoRoot = resolve(dirname(__filename), "..", "..")
    const thresholdGb = Number(process.env.WEBPACK_CACHE_MAX_GB ?? 5)
    cleanStaleStorybookCaches({
      repoRoot,
      thresholdBytes: thresholdGb * BYTES_PER_GB,
    })
  } catch (error) {
    // A maintenance helper must never block `pnpm storybook`; degrade to a warning.
    console.warn(`[clean-cache] skipped (${error instanceof Error ? error.message : error})`)
  }
}
