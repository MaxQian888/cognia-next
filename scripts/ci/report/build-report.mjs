#!/usr/bin/env node
/**
 * CLI glue: turn the artifacts a CI run produced into one markdown report.
 *
 * Every input is optional. A run where the e2e job was skipped, or where the
 * trunk branch has no successful run to compare against, still produces a
 * report — the affected sections say why they are empty. Failing to render
 * because an input is missing would make the report useless exactly when a
 * run went wrong, which is when it matters.
 *
 * Usage:
 *   node scripts/ci/report/build-report.mjs \
 *     --jest-dir artifacts/junit --playwright-json artifacts/pw.json \
 *     --coverage artifacts/coverage-final.json \
 *     --base-coverage base/coverage-final.json \
 *     --bundle artifacts/bundle-size.json --base-bundle base/bundle-size.json \
 *     --sha "$SHA" --run-url "$URL" --conclusion success \
 *     --out report.md
 */

import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { diffBundle } from "./bundle.mjs"
import { diffCoverage, summarizeCoverage } from "./coverage.mjs"
import { summarizeJUnit } from "./junit.mjs"
import { diffPlaywright, summarizePlaywright } from "./playwright.mjs"
import { renderReport } from "./render.mjs"

export const FLAGS = [
  "jest-dir",
  "playwright-json",
  "base-playwright-json",
  "coverage",
  "base-coverage",
  "bundle",
  "base-bundle",
  "sha",
  "run-url",
  "conclusion",
  "out",
]

/** Pure. @param {string[]} argv */
export function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`)
    const key = arg.slice(2)
    if (!FLAGS.includes(key)) throw new Error(`Unknown flag: ${arg}`)
    const value = argv[++i]
    if (value === undefined) throw new Error(`${arg} requires a value`)
    args[key] = value
  }
  return args
}

/** Read + parse JSON, returning null for anything unusable. Pure-ish. */
export function readJsonOrNull(path, read = readFileSync) {
  if (!path) return null
  try {
    return JSON.parse(read(path, "utf8"))
  } catch {
    return null
  }
}

/**
 * Gather every JUnit document under a directory (shard artifacts land in
 * per-shard subdirectories). Returns [] when the directory is absent.
 */
export function readJUnitDocuments(dir, io = {}) {
  const exists = io.exists ?? existsSync
  const readdir = io.readdir ?? ((p) => readdirSync(p, { withFileTypes: true }))
  const read = io.read ?? readFileSync
  if (!dir || !exists(dir)) return []

  const docs = []
  const stack = [dir]
  while (stack.length) {
    const current = stack.pop()
    for (const entry of readdir(current)) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.name.endsWith(".xml")) docs.push(read(full, "utf8"))
    }
  }
  return docs
}

/**
 * Build the report data object from already-loaded inputs. Pure, so the
 * assembly logic is testable without any filesystem.
 */
export function assemble({
  junitDocs,
  playwrightJson,
  basePlaywrightJson,
  coverage,
  baseCoverage,
  bundle,
  baseBundle,
  meta,
}) {
  const jest = junitDocs?.length ? summarizeJUnit(junitDocs) : undefined
  const playwright = playwrightJson
    ? (() => {
        const current = summarizePlaywright(playwrightJson)
        const base = basePlaywrightJson ? summarizePlaywright(basePlaywrightJson) : null
        return { ...current, trend: diffPlaywright(current, base) }
      })()
    : undefined

  const coverageDiff = coverage
    ? diffCoverage(
        summarizeCoverage(coverage),
        baseCoverage ? summarizeCoverage(baseCoverage) : null
      )
    : undefined

  const bundleDiff = bundle ? diffBundle(bundle, baseBundle ?? null) : undefined

  return { jest, playwright, coverage: coverageDiff, bundle: bundleDiff, meta }
}

export function main(argv = []) {
  const args = parseArgs(argv)

  const data = assemble({
    junitDocs: readJUnitDocuments(args["jest-dir"]),
    playwrightJson: readJsonOrNull(args["playwright-json"]),
    basePlaywrightJson: readJsonOrNull(args["base-playwright-json"]),
    coverage: readJsonOrNull(args.coverage),
    baseCoverage: readJsonOrNull(args["base-coverage"]),
    bundle: readJsonOrNull(args.bundle),
    baseBundle: readJsonOrNull(args["base-bundle"]),
    meta: { sha: args.sha, runUrl: args["run-url"], conclusion: args.conclusion },
  })

  const markdown = renderReport(data)

  if (args.out) writeFileSync(args.out, markdown)
  else process.stdout.write(markdown)

  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown)
    } catch (err) {
      process.stderr.write(`[report] could not write the job summary: ${err.message}\n`)
    }
  }
  return 0
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("build-report.mjs")
) {
  process.exit(main(process.argv.slice(2)))
}
