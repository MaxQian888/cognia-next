#!/usr/bin/env node
/**
 * Identity-vocabulary gate — ADR-0149.
 *
 * ## Why this exists
 *
 * The word "account" means at least four different things in this repository:
 *
 *   - a LocalProfile (`acct_…`, a password plus a physical Dexie database),
 *   - a ProviderAccount (the `accountId` in `lib/subscription`, an Anthropic
 *     or Codex login),
 *   - a connector account (an adapter instance's credential scope),
 *   - and, since ADR-0149, an Org (`org_…`, formerly `tnt_…`).
 *
 * None of those is a `User`, the entity ADR-0149 introduces for an actual
 * person. A bare `accountId` therefore carries no information about which of
 * the four it means, and every reader has to go find out. The split has already
 * been made once by hand, at the hardest point — `lib/subscription/core/
 * transport.ts` distinguishes `localAccountId` from `accountId` inside a single
 * file — and it was never propagated.
 *
 * ## Ratchet, not a cliff
 *
 * There are ~2100 bare occurrences across ~300 files. Failing on all of them
 * would get this gate switched off within a day, so they are recorded in
 * `identity-vocabulary-baseline.json` and the gate enforces the one property
 * that matters: THE COUNTS MAY ONLY SHRINK. Rename when you touch the file
 * (ADR-0149 §1); never add a new bare one.
 *
 * A per-file count rather than a per-line record is deliberate: line numbers
 * churn on every unrelated edit above them, which would make this gate fail for
 * reasons that have nothing to do with vocabulary. The known cost is that,
 * within one file, renaming one occurrence buys room for one new bare one. That
 * trade buys a gate people leave switched on.
 *
 * ## What counts as qualified
 *
 * `\baccountId\b` does not match `localAccountId`, `cogniaAccountId`,
 * `providerAccountId` or any other prefixed form, because there is no word
 * boundary in the middle of an identifier. Qualifying the name is therefore the
 * whole fix — no allowlist to maintain.
 *
 * Usage:
 *   pnpm audit:identity-vocabulary
 *   pnpm audit:identity-vocabulary:baseline   # after paying debt down
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, "../..")
export const BASELINE_FILE = join(__dirname, "identity-vocabulary-baseline.json")

/**
 * The rules. Structured as a table so ADR-0149's later batches can add one
 * without reshaping the gate: Batch 1 renames `tnt_…` to `org_…`, and Batch 5
 * turns IM principals into `ExternalIdentity` rows.
 *
 * `pattern` must be global — the gate counts matches, not files.
 */
export const RULES = [
  {
    id: "bareAccountId",
    pattern: /\baccountId\b/g,
    extensions: [".ts", ".tsx"],
    hint: "say which account: localAccountId (a LocalProfile) / providerAccountId (an Anthropic or Codex login) / the connector's own scope — or userId, if it is a person",
  },
  {
    id: "bareAccountIdRust",
    pattern: /\baccount_id\b/g,
    extensions: [".rs"],
    hint: "say which account: local_account_id / provider_account_id — or user_id, if it is a person",
  },
]

export const SCAN_ROOTS = [
  "app",
  "cli/src",
  "components",
  "crates",
  "hooks",
  "lib",
  "packages",
  "plugins",
  "src-tauri/src",
  "stores",
  "types",
  "web/components",
  "web/hooks",
  "web/lib",
]

/** Never scanned: build output, vendored trees, and dependency directories. */
export const SKIP_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "target",
  ".next",
  "out",
  "__snapshots__",
])

/**
 * Exempt by design. Tests and stories construct the very ids this gate is
 * about, and generated mirrors are rewritten wholesale by their generator —
 * failing on them would ask a human to edit a file they must not edit.
 */
export const EXEMPT_SUFFIXES = [
  ".test.ts",
  ".test.tsx",
  ".test.mjs",
  ".stories.tsx",
  ".d.ts",
  ".generated.ts",
]

/** A generated file says so in its own header; honour that rather than a path list. */
export const GENERATED_MARKER = /@generated|AUTO-GENERATED|DO NOT EDIT/i

export function isExempt(relPath) {
  return EXEMPT_SUFFIXES.some((suffix) => relPath.endsWith(suffix))
}

export function collectFiles(root, { readDir = readdirSync, stat = statSync } = {}) {
  const found = []
  const walk = (dir) => {
    let entries
    try {
      entries = readDir(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (SKIP_DIRECTORIES.has(entry) || entry.startsWith(".")) continue
      const full = join(dir, entry)
      let info
      try {
        info = stat(full)
      } catch {
        continue
      }
      if (info.isDirectory()) walk(full)
      else found.push(full)
    }
  }
  walk(root)
  return found
}

/** Count every rule's matches in one file. Returns null when nothing matched. */
export function countOffenders(relPath, source) {
  if (isExempt(relPath)) return null
  if (GENERATED_MARKER.test(source.slice(0, 500))) return null
  const counts = {}
  for (const rule of RULES) {
    if (!rule.extensions.some((ext) => relPath.endsWith(ext))) continue
    const matches = source.match(rule.pattern)
    if (matches?.length) counts[rule.id] = matches.length
  }
  return Object.keys(counts).length ? counts : null
}

/**
 * Compare a scan against the baseline. A file may shrink or vanish; it may
 * never grow, and a file absent from the baseline may not appear at all.
 */
export function diffAgainstBaseline(current, baselineEntries) {
  const problems = []
  for (const [file, counts] of Object.entries(current).sort(([a], [b]) => a.localeCompare(b))) {
    const recorded = baselineEntries[file]
    for (const [ruleId, count] of Object.entries(counts)) {
      const allowed = recorded?.[ruleId] ?? 0
      if (count <= allowed) continue
      const rule = RULES.find((candidate) => candidate.id === ruleId)
      problems.push(
        recorded
          ? `${file}: ${ruleId} grew ${allowed} → ${count} — ${rule?.hint ?? ""}`
          : `${file}: ${count} × ${ruleId} in a file the baseline does not cover — ${rule?.hint ?? ""}`
      )
    }
  }
  return problems
}

export function scanRepository({ root = REPO_ROOT } = {}) {
  const current = {}
  for (const scanRoot of SCAN_ROOTS) {
    const absolute = join(root, scanRoot)
    if (!existsSync(absolute)) continue
    for (const file of collectFiles(absolute)) {
      const relPath = relative(root, file).split(sep).join("/")
      let source
      try {
        source = readFileSync(file, "utf8")
      } catch {
        continue
      }
      const counts = countOffenders(relPath, source)
      if (counts) current[relPath] = counts
    }
  }
  return current
}

function readBaseline() {
  if (!existsSync(BASELINE_FILE)) return {}
  const parsed = JSON.parse(readFileSync(BASELINE_FILE, "utf8"))
  return parsed.entries ?? {}
}

function writeBaseline(current) {
  const entries = Object.fromEntries(Object.entries(current).sort(([a], [b]) => a.localeCompare(b)))
  const total = Object.values(entries).reduce(
    (sum, counts) => sum + Object.values(counts).reduce((inner, n) => inner + n, 0),
    0
  )
  writeFileSync(
    BASELINE_FILE,
    `${JSON.stringify(
      {
        version: 1,
        note: "ADR-0149: pre-existing bare `accountId` / `account_id` occurrences, recorded when the identity-vocabulary gate landed. These counts may only shrink — rename when you touch the file, never add a new bare one. Regenerate with `pnpm audit:identity-vocabulary:baseline` after paying debt down.",
        total,
        entries,
      },
      null,
      2
    )}\n`
  )
  return total
}

function main() {
  const current = scanRepository()
  if (process.argv.includes("--write-baseline")) {
    const total = writeBaseline(current)
    console.log(
      `[identity-vocabulary] baseline rewritten: ${Object.keys(current).length} files, ${total} occurrences.`
    )
    return
  }
  const problems = diffAgainstBaseline(current, readBaseline())
  if (problems.length) {
    console.error(`[identity-vocabulary] ${problems.length} problem(s) — see ADR-0149 §1:`)
    for (const problem of problems) console.error(`  ${problem}`)
    process.exit(1)
  }
  const total = Object.values(current).reduce(
    (sum, counts) => sum + Object.values(counts).reduce((inner, n) => inner + n, 0),
    0
  )
  console.log(
    `[identity-vocabulary] OK: ${total} baselined bare account ids across ${Object.keys(current).length} files, none added.`
  )
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
