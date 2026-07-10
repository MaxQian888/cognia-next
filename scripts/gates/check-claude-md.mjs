#!/usr/bin/env node
/**
 * Gate: CLAUDE.md freshness — deterministic drift checks between the agent
 * instruction file and the code it describes. Catches the "agents coding
 * against fiction" failure mode (Subsystem Map lagging the ADR directory,
 * stale Dexie ceilings, renamed paths) without any semantic/LLM pass.
 *
 * Invariants:
 *   1. Every repo path referenced in the Subsystem Map's "Lives in" column exists.
 *   2. Every numeric ADR referenced in the map has a matching file in the ADR dir.
 *   3. The newest ADR file number is referenced somewhere in CLAUDE.md.
 *   4. The highest Dexie `.version(N)` in lib/db/schema.ts appears as `vN` in CLAUDE.md.
 *
 * Usage: pnpm lint:claude-md
 */

import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

const ADR_DIR = "docs/content/docs/en/adr"
const SCHEMA_FILE = "lib/db/schema.ts"

/**
 * Extract Subsystem Map rows from CLAUDE.md markdown.
 * @param {string} md
 * @returns {Array<{ subsystem: string, livesIn: string[], adrs: number[] }>}
 */
export function extractMapRows(md) {
  const section = md.split(/^## Subsystem Map$/m)[1]?.split(/^#{2,3} /m)[0]
  if (!section) return []
  const rows = []
  for (const line of section.split("\n")) {
    if (!line.startsWith("|")) continue
    const cells = line.split("|").map((c) => c.trim())
    // cells[0] is the empty string before the leading pipe.
    const [subsystem, livesIn, , adrCell] = cells.slice(1)
    if (!subsystem || subsystem === "Subsystem" || /^-+$/.test(subsystem)) continue
    const livesInPaths = [...(livesIn ?? "").matchAll(/`([^`]+)`/g)]
      .map((m) => m[1])
      .filter((p) => !p.includes("*") && !p.includes(":"))
    const adrs = [...(adrCell ?? "").matchAll(/\b(\d{4})\b/g)].map((m) => Number(m[1]))
    rows.push({ subsystem, livesIn: livesInPaths, adrs })
  }
  return rows
}

/**
 * Run every invariant; pure so it can be unit-tested with injected inputs.
 * @param {object} input
 * @param {string} input.md              full CLAUDE.md content
 * @param {number[]} input.adrNumbers    ADR numbers present on disk
 * @param {number|null} input.dexieCeiling highest .version(N) in schema.ts
 * @param {(p: string) => boolean} input.pathExists
 * @returns {string[]} human-readable failures (empty = green)
 */
export function checkInvariants({ md, adrNumbers, dexieCeiling, pathExists }) {
  const failures = []
  const rows = extractMapRows(md)
  if (rows.length === 0) {
    return ["CLAUDE.md has no parseable Subsystem Map table — check the heading/format."]
  }

  const adrSet = new Set(adrNumbers)
  for (const row of rows) {
    for (const p of row.livesIn) {
      if (!pathExists(p)) {
        failures.push(`[${row.subsystem}] "Lives in" path does not exist: ${p}`)
      }
    }
    for (const adr of row.adrs) {
      if (!adrSet.has(adr)) {
        failures.push(
          `[${row.subsystem}] references ADR ${String(adr).padStart(4, "0")} but no such file exists in ${ADR_DIR}/`
        )
      }
    }
  }

  const newestAdr = adrNumbers.length ? Math.max(...adrNumbers) : null
  if (newestAdr !== null) {
    const padded = String(newestAdr).padStart(4, "0")
    if (!new RegExp(`\\b${padded}\\b`).test(md)) {
      failures.push(
        `Newest ADR ${padded} is not referenced anywhere in CLAUDE.md — add a Subsystem Map row for it.`
      )
    }
  }

  if (dexieCeiling !== null && !new RegExp(`\\bv${dexieCeiling}\\b`).test(md)) {
    failures.push(
      `Dexie schema ceiling is v${dexieCeiling} (${SCHEMA_FILE}) but CLAUDE.md never mentions it — update the Subsystem Map's Schema column.`
    )
  }

  return failures
}

/** Read ADR numbers from the ADR directory on disk. */
export function readAdrNumbers(dir = ADR_DIR) {
  return readdirSync(dir)
    .map((f) => f.match(/^(\d{4})-/)?.[1])
    .filter(Boolean)
    .map(Number)
}

/** Read the highest Dexie .version(N) from schema.ts. */
export function readDexieCeiling(file = SCHEMA_FILE) {
  const src = readFileSync(file, "utf8")
  const versions = [...src.matchAll(/\.version\((\d+)\)/g)].map((m) => Number(m[1]))
  return versions.length ? Math.max(...versions) : null
}

function main() {
  const md = readFileSync("CLAUDE.md", "utf8")
  const failures = checkInvariants({
    md,
    adrNumbers: readAdrNumbers(),
    dexieCeiling: readDexieCeiling(),
    pathExists: (p) => existsSync(join(process.cwd(), p)),
  })
  if (failures.length) {
    process.stderr.write(`lint:claude-md — ${failures.length} drift issue(s):\n`)
    for (const f of failures) process.stderr.write(`  ✗ ${f}\n`)
    process.exit(1)
  }
  process.stdout.write("lint:claude-md — CLAUDE.md is in sync with the repo.\n")
}

if (process.argv[1]?.endsWith("check-claude-md.mjs")) {
  main()
}
