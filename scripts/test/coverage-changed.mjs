#!/usr/bin/env node
/**
 * Fast, scoped coverage for the files you actually changed.
 *
 * `pnpm test:coverage` pays a fixed multi-GB / ~35s tax before running a
 * single test: `collectCoverageFrom` makes the Jest parent build an "empty
 * coverage" map for every one of the ~3k collected source files. When you
 * only want to know "are MY changed files covered", that tax is pure waste.
 *
 * This script:
 *   1. Diffs the working tree + branch against the merge-base with a base ref
 *      (default: origin/dev) and keeps only coverage-collected source files.
 *   2. Runs Jest with `--findRelatedTests` (only suites that import those
 *      files) and `--collectCoverageFrom` narrowed to exactly those files.
 *   3. Disables the config's layered `coverageThreshold` by default — those
 *      globs error when a group has no collected data, which is guaranteed
 *      here. Pass `--strict` to gate the changed files at the CLAUDE.md 90%
 *      bar instead.
 *
 * The default base is `origin/dev`, NOT `master`. `dev` is this repo's real
 * trunk; `master` sits ~1500 commits behind it. Diffing against master made
 * "changed files" mean "most of the repo", which turned every incremental
 * check into a full run and made a 90% gate unshippable. CI always passes
 * `--base` explicitly from the event context; this default only serves local
 * invocations.
 *
 * Usage:
 *   pnpm test:coverage:changed                        # report-only, vs origin/dev
 *   pnpm test:coverage:changed -- --base origin/main  # different base ref
 *   pnpm test:coverage:changed -- --strict            # enforce 90% on changed files
 */

import { execFileSync, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

/** Directories whose files are coverage-collected (mirrors jest.config.ts). */
const COLLECTED_ROOTS = [
  /^app\//,
  /^components\//,
  /^hooks\//,
  /^lib\//,
  /^stores\//,
  /^cli\/src\//,
  /^packages\/[^/]+\/src\//,
  // The marketing workspace (ADR-0092), matching `collectCoverageFrom`.
  /^web\/(components|hooks|lib)\//,
]

/**
 * Paths excluded from coverage (mirrors coveragePathIgnorePatterns + globs).
 *
 * `web/components/ui/` needs its own anchored entry: Jest's
 * `coveragePathIgnorePatterns` uses the unanchored `/components/ui/`, which
 * happens to catch the web copy too, but these patterns are anchored at the
 * repo root and would not.
 */
const EXCLUDED = [/^components\/ui\//, /^components\/ai-elements\//, /^web\/components\/ui\//]

const SOURCE_EXT = /\.(ts|tsx|js|jsx)$/
const NON_SOURCE = /\.(test|spec|stories)\.[^/]+$/

export function parseArgs(argv) {
  const args = { base: "origin/dev", strict: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === "--base") {
      const value = argv[++i]
      if (!value) throw new Error("--base requires a ref")
      args.base = String(value)
    } else if (arg === "--strict") args.strict = true
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return args
}

/** Keep only files Jest would collect coverage for. */
export function filterCoverageTargets(files) {
  return files.filter(
    (file) =>
      SOURCE_EXT.test(file) &&
      !NON_SOURCE.test(file) &&
      COLLECTED_ROOTS.some((re) => re.test(file)) &&
      !EXCLUDED.some((re) => re.test(file))
  )
}

/**
 * Build the Jest CLI arguments for a scoped coverage run. `collectCoverageFrom`
 * accepts one glob string, so multiple files become a `{a,b}` brace group
 * (a single file is passed verbatim — a one-entry brace group is not expanded
 * by micromatch).
 */
export function buildJestArgs(files, { strict = false } = {}) {
  const coverageFrom = files.length === 1 ? files[0] : `{${files.join(",")}}`
  const threshold = strict
    ? { global: { branches: 90, functions: 90, lines: 90, statements: 90 } }
    : {}
  return [
    "--coverage",
    `--collectCoverageFrom=${coverageFrom}`,
    `--coverageThreshold=${JSON.stringify(threshold)}`,
    "--findRelatedTests",
    ...files,
  ]
}

/** Changed files vs the merge-base with `base`, plus untracked files. */
export function listChangedFiles(base, exec = execFileSync) {
  const run = (cmd, args) => exec(cmd, args, { encoding: "utf8" }).trim()
  const mergeBase = run("git", ["merge-base", "HEAD", base])
  const changed = run("git", ["diff", "--name-only", "--diff-filter=d", mergeBase])
  const untracked = run("git", ["ls-files", "--others", "--exclude-standard"])
  return [...new Set([...changed.split("\n"), ...untracked.split("\n")])].filter(Boolean)
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const targets = filterCoverageTargets(listChangedFiles(args.base))
  if (targets.length === 0) {
    console.log(
      `[coverage-changed] no coverage-collected files changed vs ${args.base} — nothing to do`
    )
    return 0
  }
  console.log(
    `[coverage-changed] ${targets.length} changed file(s) vs ${args.base}:\n` +
      targets.map((f) => `  - ${f}`).join("\n")
  )
  const result = spawnSync("pnpm", ["exec", "jest", ...buildJestArgs(targets, args)], {
    stdio: "inherit",
    env: { ...process.env, JEST_COVERAGE: "1" },
  })
  return result.status ?? 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main())
  } catch (err) {
    console.error(`[coverage-changed] ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}
