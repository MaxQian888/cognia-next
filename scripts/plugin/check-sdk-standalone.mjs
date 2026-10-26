#!/usr/bin/env node
// The plugin SDK and the plugin contract must build without host source.
//
// `@cognia/plugin-sdk` used to compile from host source through the `@/*`
// alias: its types were the host's, and its registries were the host's
// modules re-exported. That ties the SDK (and every plugin compiled against it)
// to this checkout. The rule is that the SDK owns no host code: contract types
// belong in `@cognia/plugin-contract`, and capabilities that need the running
// host are neutral facades the host binds at load
// (`lib/plugin/core/sdk-subpath-loaders.ts`).
//
// This gate holds that line for the two packages and for every `@cognia/*`
// package they reach. A file may not reference host source (`@/…`) or reach
// outside its own package with a relative path. Files that still do are listed
// in a baseline that may only shrink: a file over its count fails, and so does
// a file under it, so the record never overstates what is left.
//
//   node scripts/plugin/check-sdk-standalone.mjs                   # check
//   node scripts/plugin/check-sdk-standalone.mjs --write-baseline  # record current counts

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, extname, join, relative, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
import { moduleReferences } from "./check-author-imports.mjs"

/** The packages that must be standalone; their `@cognia/*` dependencies are followed. */
export const SDK_STANDALONE_ROOTS = ["packages/plugin-sdk", "packages/plugin-contract"]

export const SDK_STANDALONE_BASELINE = "scripts/plugin/sdk-standalone-baseline.json"

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"])

function sourceFiles(directory) {
  if (!existsSync(directory)) return []
  const files = []
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (SOURCE_EXTENSIONS.has(extname(entry.name))) files.push(path)
    }
  }
  walk(directory)
  return files.sort()
}

/** `@cognia/name/sub/path` → `name`, or `undefined` for anything else. */
function cogniaPackageName(specifier) {
  const match = /^@cognia\/([^/]+)/.exec(specifier)
  return match?.[1]
}

/**
 * The host references in one file: `@/…` specifiers, and relative specifiers
 * that resolve outside `packageRoot`.
 */
export function findHostReferences(source, file, packageRoot) {
  const found = []
  for (const specifier of moduleReferences(source)) {
    if (specifier.startsWith("@/")) found.push(specifier)
    else if (specifier.startsWith(".")) {
      const target = resolve(dirname(file), specifier)
      if (target !== packageRoot && !target.startsWith(packageRoot + sep)) found.push(specifier)
    }
  }
  return found
}

/**
 * Every package directory the roots reach through `@cognia/*` imports
 * (including the roots that exist), sorted.
 */
export function reachablePackages(repoRoot = process.cwd(), roots = SDK_STANDALONE_ROOTS) {
  const reached = new Set()
  const queue = roots.filter((root) => existsSync(resolve(repoRoot, root)))
  while (queue.length > 0) {
    const root = queue.shift()
    if (reached.has(root)) continue
    reached.add(root)
    for (const file of sourceFiles(resolve(repoRoot, root, "src"))) {
      for (const specifier of moduleReferences(readFileSync(file, "utf8"))) {
        const name = cogniaPackageName(specifier)
        if (!name) continue
        const dir = `packages/${name}`
        if (!reached.has(dir) && existsSync(resolve(repoRoot, dir, "package.json"))) queue.push(dir)
      }
    }
  }
  return [...reached].sort()
}

/** Per-file host-reference counts across every reachable package's `src/`. */
export function countHostReferences(repoRoot = process.cwd(), roots = SDK_STANDALONE_ROOTS) {
  const counts = {}
  for (const pkg of reachablePackages(repoRoot, roots)) {
    const packageRoot = resolve(repoRoot, pkg)
    for (const file of sourceFiles(join(packageRoot, "src"))) {
      const found = findHostReferences(readFileSync(file, "utf8"), file, packageRoot)
      if (found.length > 0) counts[relative(repoRoot, file).split(sep).join("/")] = found.length
    }
  }
  return counts
}

export function readSdkStandaloneBaseline(repoRoot = process.cwd()) {
  const path = resolve(repoRoot, SDK_STANDALONE_BASELINE)
  if (!existsSync(path)) return {}
  return JSON.parse(readFileSync(path, "utf8")).files ?? {}
}

/**
 * @returns {{ regressed: string[], stale: string[], total: number, files: number }}
 *   `regressed` — files with more host references than the baseline allows.
 *   `stale`     — baselined files now below their count (lower or delete the entry).
 */
export function checkSdkStandalone(repoRoot = process.cwd(), roots = SDK_STANDALONE_ROOTS) {
  const counts = countHostReferences(repoRoot, roots)
  const baseline = readSdkStandaloneBaseline(repoRoot)
  const regressed = []
  const stale = []
  for (const [file, count] of Object.entries(counts)) {
    const allowed = baseline[file] ?? 0
    if (count > allowed) regressed.push(`${file}: ${count} host reference(s), baseline ${allowed}`)
  }
  for (const [file, allowed] of Object.entries(baseline)) {
    const count = counts[file] ?? 0
    if (count < allowed) stale.push(`${file}: ${count} host reference(s), baseline ${allowed}`)
  }
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0)
  return { regressed, stale, total, files: Object.keys(counts).length }
}

export function writeSdkStandaloneBaseline(repoRoot = process.cwd(), roots = SDK_STANDALONE_ROOTS) {
  const counts = countHostReferences(repoRoot, roots)
  const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
  writeFileSync(
    resolve(repoRoot, SDK_STANDALONE_BASELINE),
    `${JSON.stringify(
      {
        $comment:
          "Files in the plugin SDK, the plugin contract, and the @cognia packages they reach that still reference host source. Counts may only shrink — see scripts/plugin/check-sdk-standalone.mjs.",
        files: sorted,
      },
      null,
      2
    )}\n`
  )
  return sorted
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.includes("--write-baseline")) {
    const files = writeSdkStandaloneBaseline()
    console.log(`[sdk-standalone] baseline: ${Object.keys(files).length} file(s)`)
  } else {
    const { regressed, stale, total, files } = checkSdkStandalone()
    for (const line of regressed) console.error(`[sdk-standalone] regressed  ${line}`)
    for (const line of stale) console.error(`[sdk-standalone] stale      ${line}`)
    if (regressed.length > 0 || stale.length > 0) {
      console.error(
        "[sdk-standalone] the plugin SDK must not grow host references; if a file shrank, run `pnpm plugin:sdk:standalone:baseline` to lock it in."
      )
      process.exitCode = 1
    } else {
      console.log(
        total === 0
          ? "[sdk-standalone] OK: the plugin SDK and the packages it reaches reference no host source."
          : `[sdk-standalone] OK: ${total} host reference(s) left in ${files} baselined file(s), none new.`
      )
    }
  }
}
