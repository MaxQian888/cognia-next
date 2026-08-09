#!/usr/bin/env node
/**
 * Advisory ratchet for the layered coverage thresholds.
 *
 * CLAUDE.md says coverage must be ≥90% lines/branches/functions. The gate
 * actually enforces `scripts/test/coverage-thresholds.json`, whose `global`
 * group sits at lines 25 / functions 30 / branches 60. Only `stores/**` is
 * really at 90. The rule and the gate had drifted far enough apart that the
 * rule was fiction.
 *
 * Two things close that gap. The changed-files gate
 * (`coverage-changed.mjs --strict`) enforces the real 90% bar on what a
 * change touches. This script handles the other half: when a group's measured
 * coverage has risen comfortably above its floor, it says so and offers to
 * raise the floor, so gains are kept instead of quietly eroding.
 *
 * ## Why advisory, and why not automatic
 *
 * Raising a floor is a decision about what the project promises, not a
 * measurement. Auto-committing it from CI would also mean CI writing to the
 * repository, which this pipeline deliberately does not do — the reporting
 * stage reads the trunk branch's artifacts and persists nothing. So: CI
 * prints the recommendation, a human runs `--write`.
 *
 * Group classification is imported from merge-coverage.mjs rather than
 * reimplemented, so the numbers here are the same numbers the gate sees.
 *
 * Usage:
 *   node scripts/test/coverage-ratchet.mjs --coverage coverage/coverage-final.json
 *   node scripts/test/coverage-ratchet.mjs --coverage … --write
 */

import { readFileSync } from "node:fs"
import path from "node:path"

import { Command, CommanderError } from "commander"
import libCoverage from "istanbul-lib-coverage"
import writeFileAtomic from "write-file-atomic"
import { z } from "zod"

import { classifyFiles } from "./merge-coverage.mjs"

const THRESHOLDS_FILE = new URL("./coverage-thresholds.json", import.meta.url)

export const METRICS = ["statements", "branches", "lines", "functions"]

/**
 * Headroom, in percentage points, a group must have before its floor is
 * worth raising. Small enough to make progress, large enough that ordinary
 * run-to-run variance does not produce a recommendation.
 */
export const DEFAULT_SLACK = 5

/** The bar CLAUDE.md sets; a floor is never recommended above it. */
export const TARGET = 90

/** Pure. */
const cliSchema = z.object({
  coverage: z
    .string()
    .trim()
    .min(1, "--coverage requires a path")
    .default("coverage/coverage-final.json"),
  slack: z.coerce.number({ error: "--slack requires a number" }).finite().default(DEFAULT_SLACK),
  write: z.boolean().default(false),
})

function createProgram() {
  return new Command()
    .name("pnpm coverage:ratchet")
    .description("Recommend or write safe increases to layered coverage thresholds.")
    .configureOutput({ writeErr: () => {} })
    .showHelpAfterError()
    .exitOverride()
    .option("--coverage <path>", "Merged Istanbul coverage map.", "coverage/coverage-final.json")
    .option("--slack <points>", "Required percentage-point headroom.", String(DEFAULT_SLACK))
    .option("--write", "Write recommended threshold increases.")
}

export function parseArgs(argv) {
  const program = createProgram()
  try {
    program.parse(argv, { from: "user" })
  } catch (error) {
    if (error instanceof CommanderError && error.code === "commander.helpDisplayed") return null
    throw error
  }
  return cliSchema.parse(program.opts())
}

/**
 * Recommend a new floor for one metric. Pure.
 *
 * Rounds DOWN to a whole point so the recommendation always sits at or below
 * what was actually measured — a floor above the measurement would fail the
 * very next run.
 *
 * @returns {number | null} the proposed floor, or null to leave it alone
 */
export function proposeFloor(current, measured, slack = DEFAULT_SLACK) {
  if (measured === null || measured === undefined) return null
  // Negative thresholds are Jest's "max uncovered count" form, a different
  // unit entirely; never touch them.
  if (current < 0) return null
  if (measured < current + slack) return null
  const proposed = Math.min(TARGET, Math.floor(measured))
  return proposed > current ? proposed : null
}

/**
 * Compare measured coverage per group against the configured floors. Pure.
 *
 * @param {Record<string, Record<string, number>>} thresholds
 * @param {Record<string, Record<string, number|null>>} measured group → metric → pct
 * @param {number} [slack]
 * @returns {Array<{ group: string, metric: string, from: number, to: number, measured: number }>}
 */
export function recommend(thresholds, measured, slack = DEFAULT_SLACK) {
  const out = []
  for (const [group, floors] of Object.entries(thresholds)) {
    const actual = measured[group]
    if (!actual) continue
    for (const metric of METRICS) {
      const current = floors[metric]
      if (current === undefined) continue
      const proposed = proposeFloor(current, actual[metric], slack)
      if (proposed !== null) {
        out.push({ group, metric, from: current, to: proposed, measured: actual[metric] })
      }
    }
  }
  return out
}

/** Apply recommendations to a thresholds object. Pure — returns a new object. */
export function applyRecommendations(thresholds, recommendations) {
  const next = JSON.parse(JSON.stringify(thresholds))
  for (const r of recommendations) next[r.group][r.metric] = r.to
  return next
}

/**
 * Measure each threshold group's coverage from a merged istanbul map.
 * @returns {Record<string, Record<string, number|null>>}
 */
export function measureGroups(rawMap, thresholds, { cwd = process.cwd() } = {}) {
  const map = libCoverage.createCoverageMap(rawMap ?? {})
  const groups = Object.keys(thresholds)
  const { byGroup } = classifyFiles(map.files(), groups, { cwd })

  const measured = {}
  for (const group of groups) {
    const files = byGroup.get(group) ?? []
    const target = group === "global" && files.length === 0 ? map.files() : files
    if (target.length === 0) continue

    let combined
    for (const file of target) {
      const summary = map.fileCoverageFor(file).toSummary()
      combined = combined === undefined ? summary : combined.merge(summary)
    }
    if (!combined) continue

    measured[group] = Object.fromEntries(
      METRICS.map((m) => [m, combined[m].total === 0 ? null : Number(combined[m].pct.toFixed(2))])
    )
  }
  return measured
}

export function main(argv = []) {
  const args = parseArgs(argv)
  if (!args) return 0
  const thresholds = JSON.parse(readFileSync(THRESHOLDS_FILE, "utf8"))

  let rawMap
  try {
    rawMap = JSON.parse(readFileSync(args.coverage, "utf8"))
  } catch (err) {
    console.error(`[coverage-ratchet] could not read ${args.coverage}: ${err.message}`)
    return 1
  }

  const measured = measureGroups(rawMap, thresholds, { cwd: path.resolve(".") })
  const recommendations = recommend(thresholds, measured, args.slack)

  if (!recommendations.length) {
    console.log(
      `[coverage-ratchet] no floor has ${args.slack}+ points of headroom — nothing to raise.`
    )
    return 0
  }

  console.log(`[coverage-ratchet] ${recommendations.length} floor(s) can be raised:`)
  for (const r of recommendations) {
    console.log(`  ${r.group}  ${r.metric}: ${r.from} → ${r.to}  (measured ${r.measured}%)`)
  }

  if (args.write) {
    const next = applyRecommendations(thresholds, recommendations)
    writeFileAtomic.sync(THRESHOLDS_FILE, `${JSON.stringify(next, null, 2)}\n`)
    console.log("[coverage-ratchet] scripts/test/coverage-thresholds.json updated.")
  } else {
    console.log("\n  Run `pnpm coverage:ratchet -- --write` to lock these in.")
  }
  return 0
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("coverage-ratchet.mjs")
) {
  process.exit(main(process.argv.slice(2)))
}
