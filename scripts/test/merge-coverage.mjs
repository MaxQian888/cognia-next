#!/usr/bin/env node
/**
 * Merge per-shard Jest coverage maps and enforce the repo coverage gates.
 *
 * CI runs `jest --coverage --shard=i/N` in a matrix; each shard only sees
 * partial coverage for any source file whose tests landed on another shard,
 * so shards run with `--coverageThreshold={}` (checks disabled) and emit a
 * raw `coverage-final.json` (istanbul format — the v8 provider converts).
 * This script merges those maps, regenerates the lcov + HTML report the CI
 * summary consumes, and re-applies `scripts/test/coverage-thresholds.json`
 * (the same file jest.config.ts feeds to single-process runs) using Jest's
 * exact semantics, mirrored from @jest/reporters CoverageReporter:
 *   - glob groups   → each matched covered file is checked individually
 *   - path groups   → aggregate over files under the path prefix
 *   - global        → aggregate over covered files matched by NO other group
 *   - a non-global group matching zero covered files is an error
 *   - negative thresholds bound the count of uncovered entities
 *
 * Usage:
 *   node scripts/test/merge-coverage.mjs --check --out coverage \
 *     shard-1/coverage-final.json shard-2/ ...
 * (directory inputs resolve to <dir>/coverage-final.json)
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { Command, CommanderError } from "commander"
import { globSync } from "glob"
import libCoverage from "istanbul-lib-coverage"
import libReport from "istanbul-lib-report"
import reports from "istanbul-reports"
import { z } from "zod"

const THRESHOLDS_URL = new URL("./coverage-thresholds.json", import.meta.url)
const COVERAGE_SOURCES_URL = new URL("./coverage-sources.json", import.meta.url)
const METRICS = ["statements", "branches", "lines", "functions"]
const COVERAGE_SOURCES = JSON.parse(readFileSync(COVERAGE_SOURCES_URL, "utf8"))

/** Merge istanbul coverage-final.json files into one CoverageMap. */
export function mergeCoverageFiles(files) {
  const map = libCoverage.createCoverageMap({})
  for (const file of files) {
    map.merge(JSON.parse(readFileSync(file, "utf8")))
  }
  return map
}

/**
 * Raw V8 shard maps also contain executed test/config modules. Filter against
 * the exact Jest source globs and ignore patterns so the standalone merger
 * neither invents coverage obligations nor drops a production source.
 */
export function filterCollectedSources(map, { cwd = process.cwd() } = {}) {
  const positives = COVERAGE_SOURCES.collectCoverageFrom.filter(
    (pattern) => !pattern.startsWith("!")
  )
  const configuredNegatives = COVERAGE_SOURCES.collectCoverageFrom
    .filter((pattern) => pattern.startsWith("!"))
    .map((pattern) => pattern.slice(1))
  // Jest also excludes matched test files independently of collectCoverageFrom.
  const negatives = [...configuredNegatives, "**/__tests__/**", "**/*.{test,spec}.{js,jsx,ts,tsx}"]
  const globOptions = { cwd, absolute: true, nodir: true, windowsPathsNoEscape: true }
  const allowed = new Set(globSync(positives, globOptions).map((file) => path.resolve(file)))
  for (const file of globSync(negatives, globOptions)) allowed.delete(path.resolve(file))

  const ignored = COVERAGE_SOURCES.coveragePathIgnorePatterns.map((pattern) => new RegExp(pattern))
  map.filter(
    (file) => allowed.has(path.resolve(file)) && !ignored.some((pattern) => pattern.test(file))
  )
  return map
}

/** Jest's per-group metric check (incl. negative "max uncovered" thresholds). */
export function checkGroup(name, thresholds, summary) {
  const errors = []
  for (const key of METRICS) {
    const threshold = thresholds[key]
    if (threshold === undefined) continue
    const actual = summary[key].pct
    const actualUncovered = summary[key].total - summary[key].covered
    if (threshold < 0) {
      if (threshold * -1 < actualUncovered) {
        errors.push(
          `Coverage: uncovered count for ${key} (${actualUncovered}) exceeds "${name}" threshold (${-1 * threshold})`
        )
      }
    } else if (actual < threshold) {
      errors.push(`Coverage: ${key} (${actual}%) does not meet "${name}" threshold (${threshold}%)`)
    }
  }
  return errors
}

/**
 * Sort covered files into threshold groups, mirroring Jest's classification:
 * prefix match → PATH group; glob match (expanded against the filesystem)
 * → GLOB group; unmatched files fall into `global`. A file can belong to
 * several groups (each group checks it independently).
 */
export function classifyFiles(coveredFiles, thresholdGroups, { cwd = process.cwd() } = {}) {
  const byGroup = new Map(thresholdGroups.map((g) => [g, []]))
  const groupType = new Map()
  const globCache = new Map()
  const hasGlobal = thresholdGroups.includes("global")
  for (const file of coveredFiles) {
    let matched = false
    for (const group of thresholdGroups) {
      if (group === "global") continue
      const resolved = path.resolve(cwd, group)
      const suffix = group.endsWith(path.sep) && !resolved.endsWith(path.sep) ? path.sep : ""
      const absoluteGroup = `${resolved}${suffix}`
      if (file.startsWith(absoluteGroup)) {
        groupType.set(group, "path")
        byGroup.get(group).push(file)
        matched = true
        continue
      }
      if (!globCache.has(absoluteGroup)) {
        globCache.set(
          absoluteGroup,
          new Set(
            globSync(absoluteGroup, { windowsPathsNoEscape: true }).map((p) => path.resolve(p))
          )
        )
      }
      if (globCache.get(absoluteGroup).has(file)) {
        groupType.set(group, "glob")
        byGroup.get(group).push(file)
        matched = true
      }
    }
    if (!matched && hasGlobal) byGroup.get("global").push(file)
  }
  if (hasGlobal) groupType.set("global", "global")
  return { byGroup, groupType }
}

function combineSummaries(map, files) {
  let combined
  for (const file of files) {
    const summary = map.fileCoverageFor(file).toSummary()
    combined = combined === undefined ? summary : combined.merge(summary)
  }
  return combined
}

/** Apply the threshold config to a merged map. Returns the error list. */
export function checkThresholds(map, thresholds, { cwd = process.cwd() } = {}) {
  const thresholdGroups = Object.keys(thresholds)
  const coveredFiles = map.files()
  const { byGroup, groupType } = classifyFiles(coveredFiles, thresholdGroups, { cwd })
  const errors = []
  for (const group of thresholdGroups) {
    const files = byGroup.get(group)
    switch (groupType.get(group)) {
      case "global": {
        const summary = combineSummaries(map, files.length > 0 ? files : coveredFiles)
        if (summary) errors.push(...checkGroup(group, thresholds[group], summary))
        break
      }
      case "path": {
        const summary = combineSummaries(map, files)
        if (summary) errors.push(...checkGroup(group, thresholds[group], summary))
        break
      }
      case "glob":
        for (const file of files) {
          errors.push(...checkGroup(file, thresholds[group], map.fileCoverageFor(file).toSummary()))
        }
        break
      default:
        // Same behavior as Jest: a configured non-global group with zero
        // covered files means the merge is missing data — hard error.
        errors.push(`Coverage data for ${group} was not found.`)
    }
  }
  return errors
}

/** Write coverage-final.json + lcov (info + HTML report) + console summary. */
export function writeReports(map, outDir) {
  mkdirSync(outDir, { recursive: true })
  writeFileSync(path.join(outDir, "coverage-final.json"), JSON.stringify(map.toJSON()))
  const context = libReport.createContext({ dir: outDir, coverageMap: map })
  reports.create("lcov").execute(context)
  reports.create("text-summary").execute(context)
}

const cliSchema = z.object({
  check: z.boolean().default(false),
  inputs: z.array(z.string().trim().min(1)).min(1, "No coverage inputs given"),
  out: z.string().trim().min(1, "--out requires a directory").default("coverage"),
})

function createProgram() {
  return new Command()
    .name("pnpm test:coverage:merge")
    .description("Merge Jest coverage maps and optionally enforce repository thresholds.")
    .configureOutput({ writeErr: () => {} })
    .showHelpAfterError()
    .exitOverride()
    .argument("[inputs...]", "Coverage JSON files or directories.")
    .option("--check", "Enforce configured coverage thresholds.")
    .option("--out <directory>", "Merged coverage output directory.", "coverage")
}

export function parseArgs(argv) {
  const program = createProgram()
  try {
    program.parse(argv, { from: "user" })
  } catch (error) {
    if (error instanceof CommanderError && error.code === "commander.helpDisplayed") return null
    throw error
  }
  return cliSchema.parse({ ...program.opts(), inputs: program.args })
}

/** Resolve an input path (file, or directory containing coverage-final.json). */
export function resolveInput(input) {
  if (existsSync(input) && statSync(input).isDirectory()) {
    return path.join(input, "coverage-final.json")
  }
  return input
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args) return 0
  const files = args.inputs.map(resolveInput)
  const missing = files.filter((f) => !existsSync(f))
  if (missing.length > 0) {
    throw new Error(`Coverage input(s) not found: ${missing.join(", ")}`)
  }
  const map = mergeCoverageFiles(files)
  const rawFileCount = map.files().length
  filterCollectedSources(map)
  console.log(
    `[merge-coverage] merged ${files.length} shard map(s), ${map.files().length} collected source files (${rawFileCount - map.files().length} test/config files removed)`
  )
  writeReports(map, args.out)
  if (args.check) {
    const thresholds = JSON.parse(readFileSync(THRESHOLDS_URL, "utf8"))
    const errors = checkThresholds(map, thresholds)
    if (errors.length > 0) {
      console.error(errors.join("\n"))
      return 1
    }
    console.log(`[merge-coverage] all ${Object.keys(thresholds).length} threshold groups pass`)
  }
  return 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main())
  } catch (err) {
    console.error(`[merge-coverage] ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}
