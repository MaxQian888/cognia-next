#!/usr/bin/env node
/**
 * Structured bundle-size measurement for the static export.
 *
 * Replaces `du -sh out/`, which produced a human-readable string that nothing
 * could compare. There was a `.github/size-snapshot/build-size.txt` step meant
 * to hold a baseline, but it wrote into a directory that does not exist and
 * was marked `continue-on-error`, so no baseline was ever produced and the
 * size "analysis" could never diff anything.
 *
 * Emitting JSON is what makes the trend possible: `report.yml` downloads the
 * same artifact from the last successful run on the trunk branch and diffs.
 *
 * Usage:
 *   node scripts/ci/report/bundle.mjs out bundle-size.json
 */

import { readdirSync, statSync, writeFileSync } from "node:fs"
import { join, relative, sep } from "node:path"

/** Chunk-level detail is only interesting for the biggest few. */
export const TOP_CHUNKS = 10

/**
 * Walk a directory tree, yielding `{ path, bytes }` for every file.
 * Injectable I/O so the walk itself is testable without a real export.
 *
 * @param {string} root
 * @param {{ readdir?: Function, stat?: Function }} [io]
 * @returns {Array<{ path: string, bytes: number }>}
 */
export function walk(root, io = {}) {
  const readdir = io.readdir ?? ((p) => readdirSync(p, { withFileTypes: true }))
  const stat = io.stat ?? ((p) => statSync(p))
  const files = []
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    for (const entry of readdir(dir)) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else files.push({ path: relative(root, full).split(sep).join("/"), bytes: stat(full).size })
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * Reduce a file list into the metrics worth tracking over time. Pure.
 *
 * @param {Array<{ path: string, bytes: number }>} files
 * @returns {{ totalBytes: number, fileCount: number, jsBytes: number, cssBytes: number, htmlBytes: number, largestChunks: Array<{ path: string, bytes: number }> }}
 */
export function summarizeFiles(files) {
  const sum = (pred) => files.filter(pred).reduce((n, f) => n + f.bytes, 0)
  const isJs = (f) => f.path.endsWith(".js") || f.path.endsWith(".mjs")

  return {
    totalBytes: files.reduce((n, f) => n + f.bytes, 0),
    fileCount: files.length,
    jsBytes: sum(isJs),
    cssBytes: sum((f) => f.path.endsWith(".css")),
    htmlBytes: sum((f) => f.path.endsWith(".html")),
    largestChunks: files
      .filter(isJs)
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, TOP_CHUNKS),
  }
}

/** @param {string} root @param {object} [io] */
export function measureBundle(root, io) {
  return summarizeFiles(walk(root, io))
}

/**
 * Compare two measurements. Pure.
 *
 * `base` may be null — the first run on a branch has nothing to compare to,
 * and reporting "no baseline" is more honest than reporting a 100% increase.
 *
 * @param {ReturnType<typeof summarizeFiles>} current
 * @param {ReturnType<typeof summarizeFiles> | null} base
 */
export function diffBundle(current, base) {
  if (!base) return { hasBase: false, current, metrics: [] }
  const metrics = ["totalBytes", "jsBytes", "cssBytes", "htmlBytes", "fileCount"].map((key) => {
    const from = base[key] ?? 0
    const to = current[key] ?? 0
    return {
      key,
      from,
      to,
      delta: to - from,
      // Guard the zero-baseline case rather than emitting Infinity.
      percent: from === 0 ? null : ((to - from) / from) * 100,
    }
  })
  return { hasBase: true, current, base, metrics }
}

/** Human-readable bytes. Pure. */
export function formatBytes(bytes) {
  const sign = bytes < 0 ? "-" : ""
  let n = Math.abs(bytes)
  const units = ["B", "KB", "MB", "GB"]
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i += 1
  }
  return `${sign}${i === 0 ? n : n.toFixed(1)} ${units[i]}`
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("bundle.mjs")) {
  const [root = "out", outFile = "bundle-size.json"] = process.argv.slice(2)
  const measurement = measureBundle(root)
  writeFileSync(outFile, `${JSON.stringify(measurement, null, 2)}\n`)
  console.log(
    `[bundle] ${root}: ${formatBytes(measurement.totalBytes)} across ` +
      `${measurement.fileCount} file(s) — JS ${formatBytes(measurement.jsBytes)} → ${outFile}`
  )
}
